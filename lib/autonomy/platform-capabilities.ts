/**
 * PLATFORM CAPABILITIES — server-level facts a probe needs before it can see
 * ==========================================================================
 *
 * Some detectors depend on something the PROJECT cannot provide and the project
 * owner cannot install: a PostgreSQL extension that requires
 * `shared_preload_libraries` and a server restart. `pg_stat_statements` is the
 * one that matters — it is the only source of measured query latency in the
 * platform, and without it two detectors go quiet:
 *
 *   • lib/autonomy/slow-query-index.ts  (the `slow_query_missing_index` repair)
 *   • lib/ai/infra-intelligence.ts      (the slow-query section of the report)
 *
 * ── Why this module exists rather than each probe checking for itself ────────
 *
 * Both already checked, and both handled the absence the only way they could:
 * by returning an empty result. That is precisely the failure this codebase has
 * paid for repeatedly — `detectMissingRls` returned `[]` for months because of a
 * bind-arity bug, and nothing could tell "I looked and found nothing" apart from
 * "I could not look". The slow-query probe had the same shape by DESIGN, and it
 * was invisible: the invariant read `satisfied: true`, the dashboard printed
 * "Backend is healthy — all guarantees hold", and the single most valuable
 * performance detector in the product had never run on a server where the
 * extension was not installed.
 *
 * Throwing instead is not the answer either, and the reason is specific.
 * `computeDesiredStateDiff` records a throw in `report.errors`, and
 * `reapInvariantFindings` refuses to withdraw ANY stale finding while that array
 * is non-empty (unknown state is not "resolved"). So one permanently-absent
 * extension would disable stale-finding withdrawal for every project on the
 * platform, forever — the exact production incident of 2026-08-07, caused then
 * by a mis-bound parameter in this very probe.
 *
 * So a missing capability is its own third state: not satisfied, not an error.
 * The invariant is reported as UNCHECKED with the exact remediation, the loop
 * keeps reaping, and nobody is told a guarantee holds that was never evaluated.
 *
 * Read-only. Cached, because this answers a question about the SERVER: it cannot
 * change without a restart, and the reconciler asks once a minute per project.
 */

import { Pool } from 'pg'

export type PlatformCapability = 'pg_stat_statements'

export interface CapabilityState {
  available: boolean
  /** What to do about it. Empty when available. */
  remediation: string
  /** True when the check itself could not run (treated as unavailable). */
  indeterminate: boolean
}

/**
 * How long an answer is trusted.
 *
 * The underlying fact needs a PostgreSQL restart to change, so this could be
 * cached for the process lifetime. Ten minutes instead, so an operator who
 * installs the extension sees the platform notice within one coffee rather than
 * having to restart Backenly to clear a cache — and so a database that was
 * merely unreachable during the first check is retried.
 */
const TTL_MS = 10 * 60 * 1000

const REMEDIATION: Record<PlatformCapability, string> = {
  pg_stat_statements:
    'Measured query latency is unavailable because the pg_stat_statements extension is not ' +
    'installed. Add `shared_preload_libraries = \'pg_stat_statements\'` to postgresql.conf, ' +
    'restart PostgreSQL, then run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`. ' +
    'Until then Backenly can see missing indexes by SHAPE but not by MEASUREMENT.',
}

interface CacheEntry {
  at: number
  state: CapabilityState
}

const cache = new Map<PlatformCapability, CacheEntry>()

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  return pool
}

/**
 * Is a server-level capability present?
 *
 * Never throws. A check that cannot run reports `available: false` with
 * `indeterminate: true`, because a capability we could not confirm must not be
 * treated as present — a probe running against a missing extension produces a
 * confusing SQL error instead of an honest "not checked".
 */
export async function hasCapability(cap: PlatformCapability): Promise<CapabilityState> {
  const hit = cache.get(cap)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.state

  let state: CapabilityState
  try {
    const res = await getPool().query(
      `SELECT 1 FROM pg_extension WHERE extname = $1 LIMIT 1`,
      [cap],
    )
    const available = res.rows.length > 0
    state = {
      available,
      remediation: available ? '' : REMEDIATION[cap],
      indeterminate: false,
    }
  } catch (err: any) {
    state = {
      available: false,
      indeterminate: true,
      remediation:
        `Could not check whether ${cap} is installed (${err?.message ?? 'query failed'}). ` +
        `Treating it as unavailable.`,
    }
  }

  cache.set(cap, { at: Date.now(), state })
  return state
}

/** Drop the cache. For tests and for an operator-triggered re-check. */
export function resetCapabilityCache(): void {
  cache.clear()
}
