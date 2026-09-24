/**
 * RUNTIME CONTRACT VERIFICATION
 * ==============================
 * Synthetic probes that exercise a project's ADVERTISED API surfaces the way a
 * real client would — over HTTP, entering at the same process production
 * traffic enters (see probeOrigin). This is the platform noticing its own
 * breakage instead of the developer's users finding it first.
 *
 * Born from a real incident: the storage endpoints were dead in production
 * for weeks (Express catch-all intercepted them) while every internal health
 * signal stayed green — because nothing ever tested the runtime contract from
 * the outside. These probes make that class of failure self-detecting.
 *
 * Probes (all read-only except auth, which uses a synthetic `.internal` user
 * that is created, exercised, and deleted):
 *   auth       signup → signin → logout round-trip
 *   db         list first table with the project's anon key
 *   storage    list files (proves the Next-owned surface is routable)
 *   functions  dispatcher reachability (expects FUNCTION_NOT_FOUND, not a misroute)
 *   healthz    hosted health endpoint (proves the Express→Next proxy hop)
 *
 * Run by the contract sweep (runContractSweep in workspace-observer.ts), the
 * ONLY writer and resolver of `contract_surface_broken`. The sweep checks the
 * ingress first, probes every watchable project, and only then decides who a
 * failure belongs to (attributeContractFailures). A failure the platform
 * caused is reported to the operator and never filed against a tenant.
 */

import { prisma } from '@/lib/db'
import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'
import { isDataPlaneOutage } from '@/lib/core/fix-actions'
import type { RawFinding } from '@/lib/core/types'

const PROBE_TIMEOUT_MS = 8_000

export type ContractSurface = 'auth' | 'db' | 'storage' | 'functions' | 'healthz'

export interface ProbeResult {
  surface: ContractSurface
  ok: boolean
  critical: boolean
  detail: string
  /** Truncated raw response body — Details-expander evidence, never shown in the summary row. */
  response?: string
  status?: number
  /**
   * Set only when no HTTP response arrived. `unreachable` means the connection
   * itself failed, which nothing inside a tenant's project can cause.
   * `timeout` means the ingress accepted the request and did not answer in
   * time, which can be one project's problem or everyone's.
   */
  transport?: 'unreachable' | 'timeout'
  durationMs: number
}

/**
 * Where the probes enter: the process that receives a customer's traffic, over
 * loopback, so a probe takes the same handler chain a real request takes minus
 * TLS and the load balancer.
 *
 * That process depends on the topology, and assuming one is how production
 * probed nothing at all. On the old single box nginx sent everything to the
 * Express runtime on :3001, which fronted Next. On AWS (and in
 * docker/compose.stack.yml) the load balancer sends everything to Next on
 * :3000, which serves its own /api/v1 routes and rewrites the rest to a
 * separate runtime named by RUNTIME_API_URL (next.config.js). The sweep runs
 * in the web process, so a hardcoded :3001 there reached an empty port: every
 * built project was reported "runtime unreachable" every minute, and the
 * customers were told it was their problem.
 *
 *   CONTRACT_PROBE_ORIGIN set   that, verbatim
 *   RUNTIME_API_URL set         this web process's own ingress, 127.0.0.1:PORT
 *   neither                     the single-box Express runtime, 127.0.0.1:RUNTIME_PORT
 *
 * A wrong answer here can no longer blame a tenant: the sweep checks this
 * origin before it probes anyone (probePlatformIngress).
 */
export function probeOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CONTRACT_PROBE_ORIGIN?.trim()
  const origin = explicit
    ? explicit
    : env.RUNTIME_API_URL?.trim()
      ? `http://127.0.0.1:${env.PORT || '3000'}`
      : `http://127.0.0.1:${env.RUNTIME_PORT || '3001'}`
  return origin.replace(/\/+$/, '')
}

async function probeFetch(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; raw: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const raw = await res.text()
    let body: any = null
    try { body = JSON.parse(raw) } catch { /* HTML or empty */ }
    return { status: res.status, body, raw: raw.slice(0, 500) }
  } finally {
    clearTimeout(timer)
  }
}

function pass(surface: ProbeResult['surface'], detail: string, startedAt: number, critical = true): ProbeResult {
  return { surface, ok: true, critical, detail, durationMs: Date.now() - startedAt }
}

function fail(
  surface: ProbeResult['surface'],
  detail: string,
  startedAt: number,
  status?: number,
  critical = true,
  response?: string,
): ProbeResult {
  return { surface, ok: false, critical, detail, status, response, durationMs: Date.now() - startedAt }
}

/** A probe that threw before any HTTP response arrived. */
function probeError(surface: ProbeResult['surface'], err: any, startedAt: number, critical = true): ProbeResult {
  return {
    ...fail(surface, `probe error: ${err?.message ?? String(err)}`, startedAt, undefined, critical),
    transport: err?.name === 'AbortError' ? 'timeout' : 'unreachable',
  }
}

/**
 * Human sentence for a failed probe response. The finding row renders `detail`
 * verbatim, so it must never contain a serialized body — pull the handler's own
 * message out of the JSON instead, and keep the raw body as separate evidence.
 */
function describeBody(res: { body: any; raw: string }): string {
  const b = res.body
  const msg =
    (typeof b?.error?.message === 'string' && b.error.message) ||
    (typeof b?.message === 'string' && b.message) ||
    (typeof b?.error === 'string' && b.error) ||
    ''
  if (msg) return msg.slice(0, 160)
  if (b != null) return '' // JSON without a message field — status code says enough
  // HTML / plain-text body (proxy error page, empty response)
  return res.raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** `returned 404 — No API definition for "posts"` (or just `returned 502`). */
function statusLine(res: { status: number; body: any; raw: string }): string {
  const why = describeBody(res)
  return `returned ${res.status}${why ? ` — ${why}` : ''}`
}

// ── Individual probes ──────────────────────────────────────────────────────────

async function probeAuth(projectId: string, base: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  const email = `__cv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@backenly.internal`
  const password = `Cv!${Math.random().toString(36).slice(2)}Aa1`

  try {
    const signup = await probeFetch(`${base}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Contract Probe' }),
    })
    if (signup.status !== 201) {
      // 503 = auth not configured for this project — a setup state, not an
      // outage. Only report when a configured surface misbehaves.
      if (signup.status === 503) return pass('auth', 'auth not configured (skipped)', startedAt)
      return fail('auth', `signup ${statusLine(signup)}`, startedAt, signup.status, true, signup.raw)
    }

    const signin = await probeFetch(`${base}/api/v1/${projectId}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    // 403 EMAIL_NOT_VERIFIED means the surface works and is enforcing the
    // project's verification policy — that's a pass.
    const emailGate = signin.status === 403 && signin.body?.error?.details?.reason === 'EMAIL_NOT_VERIFIED'
    if (signin.status !== 200 && !emailGate) {
      return fail('auth', `signin ${statusLine(signin)}`, startedAt, signin.status, true, signin.raw)
    }

    const token = signin.body?.data?.token
    if (token) {
      await probeFetch(`${base}/api/v1/${projectId}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token }),
      }).catch(() => {})
    }

    return pass('auth', 'signup → signin → logout round-trip OK', startedAt)
  } catch (err: any) {
    return probeError('auth', err, startedAt)
  } finally {
    // Delete the synthetic user AND every side-effect row the signup/logout
    // round-trip created for it (email-verification token, blacklisted jti).
    // Targeted by email + service-role (users is RLS-FORCED) inside the helper.
    await purgeSyntheticAuthArtifacts(projectId, { email }).catch(() => {})
  }
}

async function probeDb(projectId: string, base: string, apiKey: string, tableName: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(
      `${base}/api/v1/${projectId}/db/${encodeURIComponent(tableName)}?limit=1`,
      { headers: { 'x-api-key': apiKey } },
    )
    if (res.status === 200 && (Array.isArray(res.body?.data) || res.body?.data !== undefined)) {
      return pass('db', `list ${tableName} OK`, startedAt)
    }
    return fail('db', `GET /db/${tableName} ${statusLine(res)}`, startedAt, res.status, true, res.raw)
  } catch (err: any) {
    return probeError('db', err, startedAt)
  }
}

async function probeStorage(projectId: string, base: string, apiKey: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(
      `${base}/api/v1/${projectId}/storage/files?limit=1`,
      { headers: { 'x-api-key': apiKey } },
    )
    // Any storage-shaped response (200, or a structured 4xx from the storage
    // handler) proves the surface is routable. The failure mode we're catching
    // is a misroute (catch-all "API not found" / NO_AUTH shape) or 502.
    if (res.status === 200) return pass('storage', 'file list OK', startedAt)
    const code = res.body?.error?.code ?? res.body?.code
    if (res.status < 500 && code && code !== 'API_NOT_FOUND' && code !== 'NO_AUTH_PROVIDED') {
      return pass('storage', `storage handler answered (${res.status} ${code})`, startedAt)
    }
    return fail('storage', `GET /storage/files ${statusLine(res)}`, startedAt, res.status, true, res.raw)
  } catch (err: any) {
    return probeError('storage', err, startedAt)
  }
}

async function probeFunctions(projectId: string, base: string, apiKey: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(
      `${base}/api/v1/${projectId}/fn/__contract_probe__`,
      { headers: { 'x-api-key': apiKey } },
    )
    // The dispatcher answering FUNCTION_NOT_FOUND proves /fn/* routing works.
    if (res.body?.code === 'FUNCTION_NOT_FOUND') {
      return pass('functions', 'fn dispatcher reachable', startedAt, false)
    }
    return fail(
      'functions',
      `GET /fn/… expected FUNCTION_NOT_FOUND but ${statusLine(res)}`,
      startedAt, res.status, false, res.raw,
    )
  } catch (err: any) {
    return probeError('functions', err, startedAt, false)
  }
}

async function probeHealthz(projectId: string, base: string): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await probeFetch(`${base}/api/v1/${projectId}/healthz`)
    // The healthz handler answers with a status body even for edge cases —
    // any JSON `status` proves the Express→Next proxy hop works.
    if (res.body?.status) return pass('healthz', `healthz answered (${res.body.status})`, startedAt, false)
    return fail('healthz', `GET /healthz ${statusLine(res)}`, startedAt, res.status, false, res.raw)
  } catch (err: any) {
    return probeError('healthz', err, startedAt, false)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Run every applicable probe for a project. Never throws. */
export async function runContractVerification(projectId: string): Promise<ProbeResult[]> {
  const base = probeOrigin()

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { anonKey: true, jwtSecret: true },
  })
  if (!project) return []

  // Probe a real CRUD-exposable table — NOT the auth `users` table (managed via
  // /auth/*, intentionally 404 on /db/users) nor reserved plumbing. Probing
  // users produced a permanent false "contract_surface_broken" critical.
  const { isCrudExposable } = await import('@/lib/mcp/schema-introspection')
  const candidateTables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
    orderBy: { createdAt: 'asc' },
    take: 25,
  })
  const firstTable = candidateTables.find(t => isCrudExposable(t.name)) ?? null

  const probes: Promise<ProbeResult>[] = [probeHealthz(projectId, base)]

  // Auth is probed only where it is genuinely in use. The jwtSecret is seeded
  // at creation, so keying on it probed the auth surface of projects that had
  // never built auth, and the probe's own signup would have created the very
  // `users` table the no-fake-scaffolding rule says must not appear by itself.
  if (project.jwtSecret && project.jwtSecret.length >= 32) {
    const { getEndUserAuthUsage } = await import('@/lib/services/auth-status')
    const usage = await getEndUserAuthUsage(projectId).catch(() => null)
    if (usage?.inUse) probes.push(probeAuth(projectId, base))
  }

  // Key-authed probes need the anon key.
  if (project.anonKey) {
    probes.push(probeStorage(projectId, base, project.anonKey))
    probes.push(probeFunctions(projectId, base, project.anonKey))
    if (firstTable) probes.push(probeDb(projectId, base, project.anonKey, firstTable.name))
  }

  const settled = await Promise.allSettled(probes)
  return settled
    .filter((s): s is PromiseFulfilledResult<ProbeResult> => s.status === 'fulfilled')
    .map(s => s.value)
}

// ── Who a failure belongs to ──────────────────────────────────────────────────

/**
 * Before any tenant is probed: does the ingress answer at all?
 *
 * If it does not, every probe that follows would fail the same way, and the
 * only honest conclusion is that the platform is down. That is the operator's
 * problem, never a tenant's. Checked once per sweep, so a dead ingress costs
 * one request rather than five per project.
 */
export interface IngressCheck {
  ok: boolean
  origin: string
  status?: number
  detail: string
}

export async function probePlatformIngress(origin: string = probeOrigin()): Promise<IngressCheck> {
  try {
    const res = await probeFetch(`${origin}/api/health`)
    // A 5xx here is the platform reporting its own database or process as
    // unhealthy. Anything below that proves something is listening.
    if (res.status >= 500) {
      return { ok: false, origin, status: res.status, detail: `ingress health at ${origin} returned ${res.status}` }
    }
    return { ok: true, origin, status: res.status, detail: `ingress at ${origin} answered ${res.status}` }
  } catch (err: any) {
    return { ok: false, origin, detail: `no response from ingress at ${origin}: ${err?.message ?? String(err)}` }
  }
}

export interface ProjectProbeOutcome {
  projectId: string
  results: ProbeResult[]
}

export interface PlatformFault {
  kind: 'surface_unreachable' | 'surface_failing_fleetwide'
  surface: ContractSurface
  /** HTTP status the failing projects shared, or 'timeout'. Absent when unreachable. */
  status?: number | 'timeout'
  projectIds: string[]
  /** How many projects this surface was probed on this pass. */
  probed: number
  detail: string
}

export interface ContractAttribution {
  platformFaults: PlatformFault[]
  /** Failures that are this project's alone, by project. */
  tenantBroken: Map<string, ProbeResult[]>
  /**
   * Surfaces whose state this pass could not attribute to the tenant. Unknown,
   * not healthy: nothing is resolved and no heartbeat is written for them.
   */
  unknown: Map<string, Set<ContractSurface>>
}

/**
 * The same surface failing the same way on this many projects, and on at least
 * this share of the projects it was probed on, is one platform fault rather
 * than N tenant faults. A tenant can only break its own surface; a route, a
 * proxy or a shared process breaks everyone's at once. With a single project
 * (a self-hosted install) nothing can be correlated, and the operator and the
 * tenant are the same person anyway.
 */
export const FLEET_FAULT_MIN_PROJECTS = 2
export const FLEET_FAULT_MIN_SHARE = 0.5

function failureKey(r: ProbeResult): string {
  return `${r.surface}|${r.status ?? r.transport ?? 'unknown'}`
}

/**
 * Decide, for every failed probe of one sweep, whether it belongs to a tenant.
 *
 *   no connection at all      platform. Nothing in a project can refuse a TCP
 *                             connection to the platform's own ingress.
 *   same failure fleet-wide   platform (see FLEET_FAULT_MIN_*).
 *   anything else             the tenant's, and filed against their project.
 *
 * Pure, so the rule is provable without a network.
 */
export function attributeContractFailures(outcomes: ProjectProbeOutcome[]): ContractAttribution {
  const platformFaults: PlatformFault[] = []
  const tenantBroken = new Map<string, ProbeResult[]>()
  const unknown = new Map<string, Set<ContractSurface>>()
  const markUnknown = (projectId: string, surface: ContractSurface) => {
    const set = unknown.get(projectId) ?? new Set<ContractSurface>()
    set.add(surface)
    unknown.set(projectId, set)
  }

  const probedBySurface = new Map<ContractSurface, number>()
  const unreachableBySurface = new Map<ContractSurface, string[]>()
  const failingByKey = new Map<
    string,
    { surface: ContractSurface; status: number | 'timeout' | undefined; projectIds: string[] }
  >()

  for (const { projectId, results } of outcomes) {
    for (const r of results) {
      probedBySurface.set(r.surface, (probedBySurface.get(r.surface) ?? 0) + 1)
      if (r.ok) continue
      if (r.transport === 'unreachable') {
        unreachableBySurface.set(r.surface, [...(unreachableBySurface.get(r.surface) ?? []), projectId])
        markUnknown(projectId, r.surface)
        continue
      }
      const key = failureKey(r)
      const entry = failingByKey.get(key) ?? {
        surface: r.surface,
        status: r.status ?? (r.transport === 'timeout' ? 'timeout' : undefined),
        projectIds: [],
      }
      entry.projectIds.push(projectId)
      failingByKey.set(key, entry)
    }
  }

  for (const [surface, projectIds] of unreachableBySurface) {
    platformFaults.push({
      kind: 'surface_unreachable',
      surface,
      projectIds,
      probed: probedBySurface.get(surface) ?? projectIds.length,
      detail: `${surface} probes could not connect to the platform on ${projectIds.length} project(s)`,
    })
  }

  const fleetKeys = new Set<string>()
  for (const [key, entry] of failingByKey) {
    const probed = probedBySurface.get(entry.surface) ?? 0
    const failing = entry.projectIds.length
    if (failing >= FLEET_FAULT_MIN_PROJECTS && probed > 0 && failing / probed >= FLEET_FAULT_MIN_SHARE) {
      fleetKeys.add(key)
      platformFaults.push({
        kind: 'surface_failing_fleetwide',
        surface: entry.surface,
        status: entry.status,
        projectIds: entry.projectIds,
        probed,
        detail: `${entry.surface} failed with ${entry.status ?? 'no status'} on ${failing} of ${probed} projects`,
      })
      for (const projectId of entry.projectIds) markUnknown(projectId, entry.surface)
    }
  }

  for (const { projectId, results } of outcomes) {
    const mine = results.filter(
      r => !r.ok && r.transport !== 'unreachable' && !fleetKeys.has(failureKey(r)),
    )
    if (mine.length > 0) tenantBroken.set(projectId, mine)
  }

  return { platformFaults, tenantBroken, unknown }
}

/**
 * Settle one project's pass: close findings for surfaces that answered
 * correctly, and turn this project's own failures into findings.
 *
 * `broken` must already be attributed. Passing raw probe results here is how
 * the platform's outage used to become the customer's critical.
 */
export async function settleTenantContract(
  projectId: string,
  results: ProbeResult[],
  broken: ProbeResult[],
): Promise<RawFinding[]> {
  for (const r of results.filter(r => r.ok)) {
    await prisma.healthFinding.updateMany({
      where: {
        projectId,
        type: 'contract_surface_broken',
        status: { in: ['open', 'pending_approval'] },
        details: { path: ['surface'], equals: r.surface },
      },
      data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
    }).catch(() => {})
  }

  return broken.map((r): RawFinding => {
    const details = {
      surface: r.surface,
      detail: r.detail,
      response: r.response?.slice(0, 300) ?? null,
      httpStatus: r.status ?? null,
      durationMs: r.durationMs,
      probedAt: new Date().toISOString(),
      hint:
        'Other projects answered on this surface in the same pass, so the fault is specific to this ' +
        (r.surface === 'storage' || r.surface === 'healthz'
          ? 'project. The surface is served by the web app.'
          : 'project. The surface is served by the runtime.'),
    }

    // A broken surface is usually a symptom whose cause is outside this
    // project's schema — a process down, a route unmounted, a proxy
    // misconfigured — and inventing a schema repair for it would be a guess.
    //
    // The DATA-PLANE shape is the exception, and it is not a small one: a 502
    // from /db/* means the gateway could not reach PostgREST, which is a
    // separate supervised process with a real, verifiable repair. Leaving that
    // un-healed is what put a critical "GET /db/profiles returned 502" in a
    // human approval queue while every one of that project's data endpoints
    // was down. See lib/postgrest/supervisor.ts for why the restart is safe to
    // automate; the decision to act is re-verified there against an
    // independent platform probe, never taken on this finding alone.
    const healable = isDataPlaneOutage(details)

    return {
      type: 'contract_surface_broken',
      severity: r.critical ? 'critical' : 'warning',
      autoFixable: healable,
      details,
      fix: healable
        ? async () => {
            const { healDataPlane, describeHeal } = await import('@/lib/postgrest/supervisor')
            const result = await healDataPlane(projectId)
            // Only `healthy` counts. Throwing on anything else is deliberate:
            // the sweep records a non-throwing fix as auto_fixed, and a data
            // plane recorded as repaired while it is still serving 502s is
            // worse than an open finding, because the queue stops showing it.
            // Recoveries auto-resolve at the top of this function anyway.
            if (!result.healthy) throw new Error(describeHeal(result))
          }
        : undefined,
    }
  })
}
