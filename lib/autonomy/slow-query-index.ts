/**
 * SLOW QUERIES — turn a measured latency into an index that is actually missing
 * =============================================================================
 *
 * Backenly could already SEE slow queries: infra-intelligence reads
 * pg_stat_statements and writes a recommendation. A recommendation is not a
 * repair, and this is the one performance problem where the gap between the two
 * is the whole product — the platform had measured the query, knew which column
 * it filtered on, and still handed the owner a sentence to act on themselves.
 *
 * ── The rule that makes this safe to auto-apply ─────────────────────────────
 *
 * An index on the wrong column is not a harmless mistake. It costs write
 * throughput on every insert and update for as long as it exists, and nothing
 * ever surfaces it. This codebase has already paid for that once, in the
 * hot-table detector that emitted CREATE INDEX with a column it had inferred
 * from a table name and could not find on the table.
 *
 * So a candidate has to survive three separate filters before it becomes a
 * finding, and any one of them failing drops it silently:
 *
 *   1. PARSED, not guessed — the column is read from an equality predicate in
 *      the normalised query text, on a table qualified with THIS project's
 *      schema (lib/ai/infra-intelligence.ts: extractIndexCandidate).
 *   2. VERIFIED against the catalog — the table exists, the column exists on it.
 *      A parse that produced a plausible name for a column nobody has is exactly
 *      the failure mode above.
 *   3. NOT ALREADY INDEXED — no existing index has this column in its leading
 *      position. An index that duplicates one already there is pure write cost.
 *
 * What survives all three is a column Postgres measured itself spending time
 * filtering, that exists, and that has no index. CREATE INDEX on that is
 * additive and reversible, which is why it is rated `auto` alongside
 * missing_fk_index rather than queued for a human.
 */

import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { probeQueryFailed } from '@/lib/core/drift-detector'
import { extractIndexCandidate, type IndexCandidate } from '@/lib/ai/infra-intelligence'
import type { RawFinding } from '@/lib/core/types'

/**
 * Mean milliseconds a statement must exceed before it is worth an index.
 *
 * Matches the threshold infra-intelligence already reports at, so the advisory
 * surface and the repair cannot disagree about what "slow" means — a query
 * listed as slow in one place and ignored in the other reads as a bug even when
 * both thresholds are individually defensible.
 */
export const SLOW_QUERY_MIN_AVG_MS = 100

/** Statements below this call count are noise: a one-off report, a migration. */
export const SLOW_QUERY_MIN_CALLS = 20

interface StatementRow {
  query: string
  calls: string | number
  avg_ms: string | number
}

interface VerifiedCandidate extends IndexCandidate {
  avgMs: number
  calls: number
  queryPattern: string
}

/**
 * INVARIANT PROBE — columns this project measurably filters on with no index.
 *
 * Returns [] rather than throwing when pg_stat_statements is absent: the
 * extension is a server-level install, its absence is a platform configuration
 * fact rather than a fault in this project, and every project would otherwise
 * carry a permanently failing invariant nobody can act on. Genuine query
 * failures still throw, per probeQueryFailed.
 */
export async function detectSlowQueryMissingIndexes(projectId: string): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  // No bind parameters, so none are passed. queryWorkspaceSchema forwards its
  // rest args straight to Postgres, and supplying an argument a statement has no
  // placeholder for is rejected at bind time — which is what happened in
  // production on 2026-08-07: this probe threw on every project on every tick.
  //
  // The damage was not the dead probe. computeDesiredStateDiff records the throw
  // in `report.errors`, and reapInvariantFindings refuses to withdraw ANYTHING
  // when that array is non-empty (unknown state is not "resolved"). So one
  // mis-bound query disabled stale-finding withdrawal for the whole platform.
  // The arity guard in workspace-pool is what surfaced it instead of a silent
  // empty result.
  const ext = await queryWorkspaceSchema(
    projectId,
    `SELECT 1 AS present FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
  ).catch(probeQueryFailed('detectSlowQueryMissingIndexes/extension'))
  const extRows = ext?.rows ?? ext ?? []
  if (extRows.length === 0) return []

  const res = await queryWorkspaceSchema(
    projectId,
    // Scoped to this tenant's schema. pg_stat_statements is per-database and
    // every project shares one, so an unscoped read would attribute another
    // customer's query to this one.
    //
    // `position()` rather than LIKE: `_` is a single-character wildcard in LIKE,
    // so `workspace_<id>` would also match schemas that merely resemble it.
    `SELECT LEFT(query, 400)                                   AS query,
            calls,
            ROUND((total_exec_time / NULLIF(calls, 0))::numeric, 2) AS avg_ms
       FROM pg_stat_statements
      WHERE position($1 in query) > 0
        AND query NOT LIKE '%pg_catalog%'
        AND query NOT LIKE '%information_schema%'
        AND calls >= ${SLOW_QUERY_MIN_CALLS}
        AND (total_exec_time / NULLIF(calls, 0)) > ${SLOW_QUERY_MIN_AVG_MS}
      ORDER BY avg_ms DESC
      LIMIT 20`,
    schema,
  ).catch(probeQueryFailed('detectSlowQueryMissingIndexes/statements'))

  const rows: StatementRow[] = res?.rows ?? res ?? []
  if (rows.length === 0) return []

  // ── Filter 1: parse, never guess ──────────────────────────────────────────
  const parsed = new Map<string, VerifiedCandidate>()
  for (const r of rows) {
    const cand = extractIndexCandidate(String(r.query ?? ''), schema)
    if (!cand) continue
    const key = `${cand.table}.${cand.column}`
    const avgMs = Number(r.avg_ms) || 0
    const calls = Number(r.calls) || 0
    const existing = parsed.get(key)
    // Keep the worst offender per column: several statements can filter the same
    // column, and they all get fixed by the one index.
    if (!existing || avgMs > existing.avgMs) {
      parsed.set(key, {
        ...cand,
        avgMs,
        calls,
        queryPattern: String(r.query ?? '').replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim().slice(0, 200),
      })
    }
  }
  if (parsed.size === 0) return []

  // ── Filters 2 and 3: the column exists, and nothing already indexes it ────
  const verified = await queryWorkspaceSchema(
    projectId,
    `SELECT c.relname AS table_name,
            a.attname AS column_name,
            EXISTS (
              SELECT 1 FROM pg_index i
               WHERE i.indrelid = c.oid AND i.indkey[0] = a.attnum
            ) AS already_indexed
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1
        AND c.relkind = 'r'`,
    schema,
  ).catch(probeQueryFailed('detectSlowQueryMissingIndexes/catalog'))

  const catalogRows: Array<{ table_name: string; column_name: string; already_indexed: boolean }> =
    verified?.rows ?? verified ?? []

  const indexable = new Map<string, boolean>()
  for (const c of catalogRows) {
    indexable.set(`${c.table_name}.${c.column_name}`, !c.already_indexed)
  }

  const out: RawFinding[] = []
  for (const [key, cand] of parsed) {
    // Absent from the map entirely means the parse produced a column this table
    // does not have. That is the guessed-column failure, and it drops here.
    const needsIndex = indexable.get(key)
    if (needsIndex !== true) continue

    out.push({
      type: 'slow_query_missing_index',
      severity: cand.avgMs > 1000 ? 'critical' : 'warning',
      autoFixable: true,
      details: {
        reason:
          `Queries filtering "${cand.table}"."${cand.column}" are averaging ` +
          `${Math.round(cand.avgMs)}ms across ${cand.calls.toLocaleString()} calls, and that ` +
          `column has no index. Postgres is scanning the table to answer them. Adding the ` +
          `index changes no data and is reversible.`,
        location: `${cand.table}.${cand.column}`,
        // buildFixAction builds CREATE_INDEX from exactly these two fields.
        // Both are verified against the catalog above; neither is ever inferred
        // from the finding type or the table name.
        tableName: cand.table,
        columnName: cand.column,
        avgMs: Math.round(cand.avgMs),
        calls: cand.calls,
        queryPattern: cand.queryPattern,
        source: 'pg_stat_statements',
      },
    })
  }

  return out
}
