/**
 * LIVENESS AND READINESS OF A WEB TASK
 * ====================================
 * Two questions about a web task, kept apart because they are acted on
 * differently:
 *
 *   live    is this process up and answering? (/api/health/live) Nothing
 *           else is asked. A load balancer that replaces a task on this
 *           signal replaces only a task that is itself broken.
 *   ready   can this process serve its region's requests now? (/api/health)
 *           What that needs depends on the region the task serves.
 *
 * The home region is unchanged: ready means the platform database answers, as
 * it always has, and the home load balancer still checks /api/health.
 *
 * A task serving another region (BACKENLY_SERVICE_REGION) cannot serve without
 * the region's own database. The home region it reaches over peering is a
 * dependency, not part of the task: requests are authorized there unless the
 * region's authorization copy is enforced and fresh (lib/auth-projection), and
 * bookkeeping and the console live there. When Mumbai does not answer, a
 * regional task is not broken and a new one would not bring Mumbai back; a
 * load balancer acting on that would only replace every task in the region,
 * over and over, including tasks still answering from their copy. So a
 * regional load balancer checks liveness, and readiness reports home as a
 * dependency:
 *
 *   ready             the region's database answers, home answers, and the
 *                     copy is fresh when it is used
 *   ready, degraded   requests are still served, but something they depend on
 *                     is impaired: home does not answer and the enforced copy
 *                     is still fresh (it will stop authorizing once it passes
 *                     the staleness bound), or the copy is stale and home
 *                     answers for it
 *   not ready (503)   the region's database does not answer, or nothing can
 *                     authorize a request: home does not answer and the copy is
 *                     not enforced or is stale
 *
 * Every dependency is asked with a timeout, so a dropped peering connection
 * makes the answer "not reachable" within seconds rather than a hung check.
 * Failure reasons are codes, never error text: this endpoint is public and a
 * driver error can name a database host.
 */

import { prisma } from '@/lib/db/prisma'
import { runHealthCheck } from '@/lib/db/startup-validation'
import { regionRawClient } from '@/lib/data-plane/regional'
import { serviceRegion } from '@/lib/data-plane/serving'
import { rateLimitHealth } from '@/lib/security/rate-limit-backend'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { authMaxStalenessMs, authProjectionMode, type AuthProjectionMode } from '@/lib/auth-projection/mode'
import { copyFreshness } from '@/lib/auth-projection/copy'

type Env = Readonly<Record<string, string | undefined>>

/** How long a dependency may take before it counts as not answering. */
export const DEPENDENCY_TIMEOUT_MS = 2_000

export type ProbeFailure = 'timeout' | 'error'

export type ProbeResult<T> = { ok: true; value: T } | { ok: false; reason: ProbeFailure }

/** What a regional readiness check asks; injectable so the decision can be tested without databases. */
export interface RegionalProbes {
  /** Resolves when the region's own database answers. */
  regionDatabase(region: CloudRegionId): Promise<unknown>
  /** Resolves when the home platform database answers. */
  homeDatabase(): Promise<unknown>
  /** The age of the region's authorization copy. */
  copyFreshness(region: CloudRegionId, maxStalenessMs: number): Promise<{ fresh: boolean; ageMs: number | null }>
}

export interface AuthProjectionDependency {
  mode: AuthProjectionMode
  /** Only when the copy is used (shadow or enforce). */
  fresh?: boolean
  ageMs?: number | null
  boundMs?: number
  reason?: ProbeFailure
}

export interface RegionalReadiness {
  healthy: boolean
  degraded: boolean
  region: CloudRegionId
  /** What `healthy` is made of; every value true when ready. */
  checks: { database: boolean; authorization: boolean }
  dependencies: {
    home: { reachable: boolean; reason?: ProbeFailure }
    authProjection: AuthProjectionDependency
  }
}

/** Settles a probe within `timeoutMs`, as a result rather than a throw. */
export async function within<T>(probe: () => Promise<T>, timeoutMs: number = DEPENDENCY_TIMEOUT_MS): Promise<ProbeResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ProbeResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)
  })
  const answer = (async (): Promise<ProbeResult<T>> => {
    try {
      return { ok: true, value: await probe() }
    } catch {
      return { ok: false, reason: 'error' }
    }
  })()
  try {
    return await Promise.race([answer, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The readiness of a task serving `region` (not the home region), from what
 * its probes answer. Pure apart from the probes.
 */
export async function regionalReadiness(
  region: CloudRegionId,
  probes: RegionalProbes,
  options: { mode?: AuthProjectionMode; maxStalenessMs?: number; timeoutMs?: number } = {},
): Promise<RegionalReadiness> {
  const mode = options.mode ?? authProjectionMode()
  const boundMs = options.maxStalenessMs ?? authMaxStalenessMs()
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_TIMEOUT_MS

  const [own, home, copy] = await Promise.all([
    within(() => probes.regionDatabase(region), timeoutMs),
    within(() => probes.homeDatabase(), timeoutMs),
    mode === 'off' ? Promise.resolve(null) : within(() => probes.copyFreshness(region, boundMs), timeoutMs),
  ])

  const copyFresh = copy !== null && copy.ok && copy.value.fresh
  const canAuthorize = home.ok || (mode === 'enforce' && copyFresh)
  const healthy = own.ok && canAuthorize
  const copyImpaired = mode !== 'off' && !copyFresh

  const authProjection: AuthProjectionDependency =
    copy === null
      ? { mode }
      : copy.ok
        ? { mode, fresh: copy.value.fresh, ageMs: copy.value.ageMs, boundMs }
        : { mode, fresh: false, ageMs: null, boundMs, reason: failureOf(copy) }

  return {
    healthy,
    degraded: healthy && (!home.ok || copyImpaired),
    region,
    checks: { database: own.ok, authorization: canAuthorize },
    dependencies: {
      home: home.ok ? { reachable: true } : { reachable: false, reason: failureOf(home) },
      authProjection,
    },
  }
}

function failureOf<T>(result: ProbeResult<T>): ProbeFailure | undefined {
  return result.ok ? undefined : (result as { ok: false; reason: ProbeFailure }).reason
}

const liveProbes: RegionalProbes = {
  regionDatabase: (region) => regionRawClient(region).$queryRaw`SELECT 1`,
  homeDatabase: () => prisma.$queryRaw`SELECT 1`,
  copyFreshness: (region, maxStalenessMs) => copyFreshness(region, maxStalenessMs),
}

export type Readiness = (Awaited<ReturnType<typeof runHealthCheck>> & { region: CloudRegionId; degraded: boolean }) | (RegionalReadiness & {
  rateLimiter: Awaited<ReturnType<typeof runHealthCheck>>['rateLimiter']
  timestamp: string
})

/**
 * Readiness of this process: the home check as it always was in the home
 * region, the regional decision anywhere else. A BACKENLY_SERVICE_REGION this
 * build does not know throws (lib/data-plane/serving.ts), which the route
 * answers as not ready.
 */
export async function readiness(env: Env = process.env): Promise<Readiness> {
  const region = serviceRegion(env)
  if (region === HOME_REGION) {
    return { ...(await runHealthCheck()), region, degraded: false }
  }

  const result = await regionalReadiness(region, liveProbes, {
    mode: authProjectionMode(env.BACKENLY_AUTH_PROJECTION),
    maxStalenessMs: authMaxStalenessMs(env.AUTH_MAX_STALENESS_MS),
  })
  if (!result.healthy || result.degraded) {
    // A line per check while impaired, for the region's log metric and alarm;
    // the response is what a monitor reads.
    console.warn(
      `[health] region ${region} ${result.healthy ? 'degraded' : 'not ready'}: ` +
        `database ${result.checks.database ? 'answers' : 'does not answer'}, ` +
        `home ${result.dependencies.home.reachable ? 'answers' : `does not answer (${result.dependencies.home.reason})`}, ` +
        `authorization copy ${describeCopy(result.dependencies.authProjection)}`,
    )
  }

  const limiter = rateLimitHealth()
  return {
    ...result,
    rateLimiter: {
      store: limiter.kind,
      ready: limiter.ready,
      lastError: limiter.lastError,
      lastErrorAt: limiter.lastErrorAt ? new Date(limiter.lastErrorAt).toISOString() : null,
    },
    timestamp: new Date().toISOString(),
  }
}

function describeCopy(copy: AuthProjectionDependency): string {
  if (copy.mode === 'off') return 'not used (off)'
  if (copy.reason) return `unreadable (${copy.reason}, ${copy.mode})`
  const age = copy.ageMs === null || copy.ageMs === undefined ? 'no watermark' : `${(copy.ageMs / 1000).toFixed(1)} s old`
  return `${copy.fresh ? 'fresh' : 'stale'} (${age}, bound ${(copy.boundMs ?? 0) / 1000} s, ${copy.mode})`
}
