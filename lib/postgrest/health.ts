/**
 * PHASE 3 — PostgREST liveness, and the one failure it cannot talk itself out of.
 *
 * Most PostgREST problems are per-request and report themselves honestly. One
 * does not: when the schema cache fails to build, PostgREST answers EVERY
 * request from EVERY project with
 *
 *   503  {"code":"PGRST002","message":"Could not query the database for the
 *         schema cache. Retrying."}
 *
 * and stays there. Verified on this server: `NOTIFY pgrst, 'reload config'`
 * does NOT clear the state even once the underlying cause is gone. The process
 * has to be restarted. So this is a fault that self-heals only if something
 * external notices and acts — which is what this module is for.
 *
 * The trigger for that state is a registered schema that no longer exists, and
 * an event trigger now prevents it (see postgrest-schema-registry.sql). This
 * exists because prevention covering every path today is not the same as
 * prevention covering every path forever, and the blast radius is every tenant.
 */

import { prisma } from '@/lib/db'

export type PostgrestStatus =
  | { state: 'healthy'; latencyMs: number }
  | { state: 'schema_cache_failed'; detail: string }
  | { state: 'unreachable'; detail: string }
  | { state: 'not_configured' }

const PROBE_TIMEOUT_MS = 5_000

/**
 * Probe PostgREST's root, which returns the OpenAPI document when the schema
 * cache is healthy and PGRST002 when it is not.
 *
 * Deliberately unauthenticated: this asks "is the service able to answer at
 * all", and mixing in a JWT would let a token problem masquerade as an outage.
 */
export async function probePostgrest(): Promise<PostgrestStatus> {
  const baseUrl = process.env.POSTGREST_URL
  if (!baseUrl) return { state: 'not_configured' }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/', {
      method: 'GET',
      signal: controller.signal,
    })
    const text = await res.text()

    // A 503 alone is not enough to conclude the cache is wedged — the body
    // distinguishes a wedged cache from ordinary unavailability, and restarting
    // for the wrong reason turns a blip into a dropped-connection event.
    if (res.status === 503 && text.includes('PGRST002')) {
      return { state: 'schema_cache_failed', detail: text.slice(0, 300) }
    }
    if (!res.ok && res.status >= 500) {
      return { state: 'unreachable', detail: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    return { state: 'healthy', latencyMs: Date.now() - started }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      state: 'unreachable',
      detail: aborted ? `no response within ${PROBE_TIMEOUT_MS}ms` : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Remove registered schemas that no longer exist — the cause of a wedged cache.
 *
 * Returns the number pruned. Runs before any restart is considered: restarting
 * without pruning would rebuild the cache from the same broken list and wedge
 * again, turning a self-heal into a restart loop.
 */
export async function pruneDanglingSchemas(): Promise<number> {
  const before = await currentSchemas()
  await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_prune_schemas()`)
  const after = await currentSchemas()
  return Math.max(0, before.length - after.length)
}

async function currentSchemas(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
    `SELECT public.backenly_pgrst_current_schemas() AS list`,
  )
  const list = rows[0]?.list ?? ''
  return list ? list.split(',').filter(Boolean) : []
}

export interface HealAttempt {
  status: PostgrestStatus
  prunedSchemas: number
  restartRequired: boolean
  notes: string[]
}

/**
 * Diagnose, repair what SQL can repair, and report what it cannot.
 *
 * This function does NOT restart PostgREST. Process control belongs to whatever
 * supervises the process, and a database-connected library reaching for pm2
 * would be both unreliable and a privilege this code should not hold. It
 * reports `restartRequired` so the supervising layer can act on a verified
 * diagnosis instead of on a guess.
 */
export async function diagnoseAndHeal(): Promise<HealAttempt> {
  const notes: string[] = []
  const status = await probePostgrest()

  if (status.state === 'healthy' || status.state === 'not_configured') {
    return { status, prunedSchemas: 0, restartRequired: false, notes }
  }

  let pruned = 0
  if (status.state === 'schema_cache_failed') {
    try {
      pruned = await pruneDanglingSchemas()
      notes.push(
        pruned > 0
          ? `Pruned ${pruned} dangling schema(s) from the PostgREST registry.`
          : 'No dangling schemas found; the cache failure has another cause.',
      )
    } catch (err) {
      notes.push(`Prune failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Re-probe: if pruning fixed it without a restart, say so rather than
  // recommending an unnecessary one.
  const after = await probePostgrest()
  if (after.state === 'healthy') {
    notes.push('PostgREST recovered without a restart.')
    return { status: after, prunedSchemas: pruned, restartRequired: false, notes }
  }

  notes.push(
    'PostgREST is still failing. A schema-cache failure does not clear on ' +
    'NOTIFY reload — the process must be restarted.',
  )
  return { status: after, prunedSchemas: pruned, restartRequired: true, notes }
}

// `listMigratedProjects()` lived here: it named the projects that could NOT be
// returned to the legacy executor during an incident, so an operator throwing
// the kill switch knew who they were about to break.
//
// Removed with the executors themselves (2026-07-21). There is no engine to
// fall back to, so there is no set of projects to exclude from falling back to
// it, and a helper that answers a question nobody can act on is worse than
// absent — it implies an escape hatch that does not exist. If PostgREST is
// down, the honest response is that the data plane is down.
