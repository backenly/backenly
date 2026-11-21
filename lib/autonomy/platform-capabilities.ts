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
 * `statement_text` is the other half: the extension installed, and the role the
 * probes read with allowed to see the text of statements other roles ran
 * (superuser, or the privileges of pg_read_all_stats). Without it the extension
 * answers, and every statement PostgREST, a function or a direct connection
 * ran reads `<insufficient privilege>`.
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
 *
 * Each region has its own server, so the question is asked per region: a
 * project's probes depend on the extensions of the database holding its data.
 */

import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { databasePool, regionPool } from '@/lib/data-plane/regional'

/**
 * The database a capability is asked of: a region's own (a region id alone),
 * or a project's own database in it. Extensions are per database, so a project
 * with a database of its own is answered for that database, which the
 * template every such database is cloned from equips, and cached apart from its
 * region's.
 */
export type CapabilityTarget = CloudRegionId | { region: CloudRegionId; database: string | null }

function targetOf(target: CapabilityTarget): { region: CloudRegionId; database: string | null } {
  return typeof target === 'string' ? { region: target, database: null } : target
}

/** The database holding a project's data, as hasCapability asks it: the region alone for a shared project. */
export function capabilityTargetOf(placement: { region: CloudRegionId; tenancy: string; database: string | null }): CapabilityTarget {
  return placement.tenancy === 'dedicated' && placement.database ? { region: placement.region, database: placement.database } : placement.region
}

export type PlatformCapability = 'pg_stat_statements' | 'pgstattuple' | 'statement_text'

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
  // The extension can be installed and still show Backenly nothing that
  // matters: PostgreSQL shows the text of a statement another role ran only to
  // a role holding the privileges of pg_read_all_stats, and PostgREST runs every
  // REST request as anon, authenticated or service_role. Without them every REST
  // read is `<insufficient privilege>` (production QA, 2026-11-16).
  statement_text:
    'Measured query latency cannot be attributed: Backenly\'s database role cannot read the text of ' +
    'statements other roles ran, which is every REST request (PostgREST runs them as anon, ' +
    'authenticated or service_role), every function and every direct connection. Grant it the ' +
    'privileges of pg_read_all_stats: `GRANT pg_read_all_stats TO <the application role>;` ' +
    '(the regional database procedure and the home privilege job do this). No restart needed.',
  // Unlike pg_stat_statements this needs no preload and no restart, which is
  // worth stating: the remedy is one statement.
  pgstattuple:
    'Index bloat cannot be measured because the pgstattuple extension is not installed. Run ' +
    '`CREATE EXTENSION IF NOT EXISTS pgstattuple;` — no restart needed. Leaf density is not in ' +
    'any statistics view, and the estimate queries that approximate it go wrong on exactly the ' +
    'schemas people ask about (wide text keys, partial indexes, non-default fillfactor), so ' +
    'Backenly reports this unchecked rather than guessed.',
}

interface CacheEntry {
  at: number
  state: CapabilityState
}

const cache = new Map<string, CacheEntry>()

/**
 * Is a server-level capability present on the database server for `region`?
 *
 * A check that cannot run reports `available: false` with
 * `indeterminate: true`, because a capability we could not confirm must not be
 * treated as present — a probe running against a missing extension produces a
 * confusing SQL error instead of an honest "not checked".
 *
 * The one thing it throws is a region error, when this process has no
 * connection to `region` at all: that is not an answer about an extension.
 */
export async function hasCapability(
  cap: PlatformCapability,
  target: CapabilityTarget = HOME_REGION,
): Promise<CapabilityState> {
  const { region, database } = targetOf(target)
  // Before the cache, so a cached answer never hides a missing connection.
  const pool =
    database === null
      ? regionPool(region, 'platform-capabilities', { max: 1 })
      : await databasePool(region, database, 'platform-capabilities', { max: 1 })
  const key = database === null ? `${region}:${cap}` : `${region}/${database}:${cap}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.state

  let state: CapabilityState
  try {
    const res = cap === 'statement_text'
      // Asked as the role the probes read with: a superuser, or a role with the
      // privileges of pg_read_all_stats, sees every role's statement text.
      ? await pool.query(
          `SELECT 1 FROM pg_roles
            WHERE rolname = current_user
              AND (rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE'))`,
        )
      : await pool.query(
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
        `Could not check whether ${cap === 'statement_text' ? 'other roles\' statement text is readable' : `${cap} is installed`} ` +
        `(${err?.message ?? 'query failed'}). Treating it as unavailable.`,
    }
  }

  cache.set(key, { at: Date.now(), state })
  return state
}

/** Drop the cache. For tests and for an operator-triggered re-check. */
export function resetCapabilityCache(): void {
  cache.clear()
}
