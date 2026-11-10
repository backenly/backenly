/**
 * INFRA INTELLIGENCE — AI Infrastructure Architect
 * =================================================
 * Detects real infrastructure pressure from live PostgreSQL system catalogs.
 *
 * Detection surface:
 *   - Hot tables     — high seq_scan rate, low index hit %, dead-tuple bloat
 *   - Index issues   — unused indexes (wasted write overhead) + missing indexes (missed reads)
 *   - Partitioning   — unbounded append tables crossing the 100k-row threshold
 *   - Query cost     — pg_stat_statements top-N slow queries (if extension available)
 *   - Connection sat — active vs max_connections headroom
 *   - WebSocket load — realtime table write rate as a proxy for subscribe pressure
 *
 * Rules:
 *   - All queries target pg_stat_* views — never reads user data
 *   - Every finding includes a concrete SQL fix (safe to auto-apply or queue)
 *   - Never throws — returns partial report on any query failure
 */

import { Pool } from 'pg'
import { projectDatabaseUrl } from '@/lib/data-plane/regional'
import { literalPrefix } from '@/lib/projects/backend-presence'
import { sizeWords } from '@/lib/core/size-words'

// Warn once per server restart if pg_stat_statements is unavailable.
// Avoids spamming logs on every cron invocation.
let _pgStatStatementsWarned = false

// ── Public types ──────────────────────────────────────────────────────────────

export type InfraPressure = 'none' | 'low' | 'medium' | 'high' | 'critical'

/**
 * Live rows a table needs before a sequential scan is worth complaining about.
 *
 * A seq scan is not evidence of a missing index on its own — on a table small
 * enough to sit in a couple of pages it is the CHEAPEST plan, and the planner
 * would ignore an index there anyway. Shared with the hot-path index probe in
 * lib/autonomy/invariant-probes.ts so the daily scan and the per-minute loop
 * cannot disagree about what counts as a table worth indexing.
 */
export const HOT_TABLE_MIN_LIVE_ROWS = 500

export interface HotTableFinding {
  table: string
  seqScans: number
  idxHitPct: number   // 0-100: percentage of reads served by indexes
  deadTupRatio: number // 0-100: dead tuple bloat ratio
  liveRows: number
  pressure: InfraPressure
  /**
   * WHICH problem this is, and therefore which repair applies.
   *
   * These were one type with one remedy, and it produced un-actionable rows in
   * production: a table with 96% index coverage and 265 sequential scans is not
   * index-starved, but it tripped the dead-tuple branch, was filed as a hot
   * table, and arrived at the repair path with no column to index. The
   * classifier correctly refused to guess a column, so it sat notify-only
   * forever next to a recommendation telling the owner to run VACUUM.
   *
   * 'index_pressure' → CREATE_INDEX on `indexColumn` (may be absent, in which
   *                    case the finding is honestly notify-only)
   * 'bloat'          → VACUUM (ANALYZE) on the table, which always applies
   */
  kind: 'index_pressure' | 'bloat'
  recommendation: string
  suggestedIndex?: string
  /**
   * The column `suggestedIndex` targets, verified to exist on the table.
   * Carried separately because the repair path builds CREATE_INDEX from
   * {tableName, columnName} — parsing it back out of the SQL string would
   * reintroduce exactly the guessing this detector was fixed to stop.
   * Absent when no safe candidate exists, which makes the finding notify-only.
   */
  indexColumn?: string
}

// `IndexFinding` / `detectIndexIssues` were REMOVED on 2026-08-09.
//
// They found unused indexes, and their answer went into
// `InfraReport.approvalRequired` — which nothing persisted, nothing rendered,
// and no route returned. The query ran on every scan and its result was thrown
// away every time.
//
// It could not simply be wired up, because the evidence was `idx_scan < 10`,
// and idx_scan is a counter since the statistics were last reset with no notion
// of elapsed time. An index created five minutes ago has zero scans; so does an
// index serving a monthly job. Filing either as "safe to drop" is a claim about
// runtime behaviour with no runtime observation behind it.
//
// The replacement is lib/autonomy/unused-index.ts, which measures a real
// window: it records each index's scan count on first sight, raises nothing,
// and reports only an index whose count has not moved across fourteen days of
// observation. It is classified `approval`, never auto, and its repair is the
// DROP_INDEX executor action.
//
// The `'fragmented'` and `'missing'` kinds declared here were never emitted by
// anything.

export interface PartitioningFinding {
  table: string
  liveRows: number
  /** The table with its indexes and TOAST, on disk. */
  bytes: number
  /** effective_cache_size: the server's own estimate of the memory that caches its data. */
  cacheBytes: number
  recommendation: string
}

export interface QueryFinding {
  queryPattern: string  // truncated + anonymized
  avgMs: number
  calls: number
  avgRows: number
  pressure: InfraPressure
  recommendation: string
  /**
   * The table/column this query filters on, when it could be read unambiguously
   * from the normalised query text. Absent means no index will be proposed —
   * the finding stays advisory rather than guessing a column, which is the same
   * contract `HotTableFinding.indexColumn` holds and for the same reason.
   *
   * Still UNVERIFIED at this point: whether the column exists and is not already
   * indexed is decided against the catalog in verifyIndexCandidates().
   */
  indexCandidate?: IndexCandidate
}

export interface WebSocketFinding {
  highWriteTables: string[]
  estimatedSubscriberLoad: 'low' | 'medium' | 'high'
  recommendation: string
}

export interface InfraReport {
  projectId: string
  schemaName: string
  scannedAt: string
  overallPressure: InfraPressure
  hotTables: HotTableFinding[]
  /**
   * Whether the hot-table read finished. Its empty list after a failure used to
   * withdraw every hot-table finding the project had.
   */
  hotTablesScanned: boolean
  partitioningCandidates: PartitioningFinding[]
  /**
   * Whether the partitioning read finished. An empty list from a read that
   * failed is not "no table outgrows the cache", and must not withdraw the
   * findings already raised.
   */
  partitioningScanned: boolean
  slowQueries: QueryFinding[]
  websocketPressure: WebSocketFinding | null
  /** Prioritised actionable recommendations, highest severity first */
  topRecommendations: string[]
  /**
   * Index SQL for the hot tables under high or critical pressure: the repairs
   * their findings carry. Nothing here runs it. A person applies one from its
   * finding ("Fix now"), through the governed kernel, and the repair loop's
   * measured invariants index what they detect on their own.
   */
  autoApplicableFixes: string[]
  /** SQL that needs user approval before running */
  approvalRequired: string[]
}

// ── Connection helper ─────────────────────────────────────────────────────────

/** A short-lived pool on the project's own database, in its region. */
async function getPool(projectId: string): Promise<Pool> {
  return new Pool({ connectionString: await projectDatabaseUrl(projectId), max: 3 })
}

// ── Detection: Hot tables ─────────────────────────────────────────────────────

// No catch around the read: one that fails rejects, and the report records it
// (hotTablesScanned), so a failed read never reads as "no hot tables" and never
// withdraws the findings already raised. measuredFilterColumns keeps its own
// catch: without pg_stat_statements a table is reported with no column.
export async function detectHotTables(pool: Pool, schemaName: string): Promise<HotTableFinding[]> {
  const rows = await pool.query<{
    tablename: string
    seq_scan: string
    idx_scan: string
    n_live_tup: string
    n_dead_tup: string
  }>(
    // `relname AS tablename`, not `tablename`. pg_stat_user_tables exposes
    // (schemaname, relname); `tablename` is a pg_tables column. Selecting it
    // here raised 42703 on EVERY call, the module's "never throws" contract
    // swallowed it, and this detector returned [] — reported as "no hot
    // tables" rather than "the query is wrong". It had never once run.
    `SELECT relname AS tablename, seq_scan, COALESCE(idx_scan, 0) AS idx_scan,
            n_live_tup, n_dead_tup
       FROM pg_stat_user_tables
      WHERE schemaname = $1
        AND (seq_scan > 100 OR n_live_tup > 5000)
        -- Underscore-prefixed tables are Backenly's own platform internals
        -- (_email_verifications, _token_blacklist, …). Surfacing them told the
        -- owner their backend had a problem they neither created nor can act
        -- on. Every other detector already excludes them; this one did not.
        --
        -- left() rather than a LIKE pattern, deliberately. This was first
        -- written as NOT LIKE E'\\_%', which a JS template literal collapses to
        -- SQL E'\_%'; an E-string drops the unrecognised escape, leaving the
        -- pattern '_%' where _ is a LIKE WILDCARD. That excluded every table
        -- with at least one character, so the detector returned [] for every
        -- project and its catch reported "no hot tables". Same silent shape as
        -- the pg_stat_user_tables.tablename bug it sits next to. left() has no
        -- escaping semantics to get wrong.
        AND left(relname, 1) <> '_'
      ORDER BY seq_scan DESC
      LIMIT 20`,
    [schemaName],
  )

  // Which column are these sequential scans actually filtering on?
  //
  // This used to answer from a hardcoded name list — created_at, user_id,
  // owner_id, updated_at — picking the first one that existed on the table.
  // Two revisions before that it hardcoded `created_at` outright and produced
  // CREATE INDEX statements against columns the table did not have.
  //
  // The name list fixed the crash and left the real defect in place. This
  // detector MEASURES sequential scans and then indexed a column chosen by
  // convention, so on a table whose queries filter `customer_ref` it would
  // count the scans correctly and build the index on `created_at` — a
  // permanent write-throughput cost on every insert and update, buying nothing,
  // with the scans it was supposed to absorb still happening. And because
  // `infra_hot_table` is classified auto, that index was APPLIED without asking
  // whenever pressure reached high or critical.
  //
  // The codebase's own rule, written three times in these files, is that an
  // index on a guessed column is worse than no index because nothing ever
  // surfaces it. The rule was simply never applied here.
  //
  // So the column now comes from the same place the scans do: measurement.
  // pg_stat_statements records the statements this schema actually spends time
  // in; extractIndexCandidate parses the equality predicate out of one; the
  // catalog confirms the column exists and nothing already leads an index with
  // it. A table that survives none of that is reported with NO column, which
  // classifyFix already routes to notify_only with a hint asking the owner
  // which column their queries filter by. Saying "I measured the scans but
  // cannot tell you which column" is worth more than a confident wrong answer.
  const tableNames = rows.rows.map(r => r.tablename)
  const indexColumn = await measuredFilterColumns(pool, schemaName, tableNames)

  return rows.rows.map(r => {
    const seqScans = Number(r.seq_scan)
    const idxScans = Number(r.idx_scan)
    const live = Number(r.n_live_tup)
    const dead = Number(r.n_dead_tup)
    const total = seqScans + idxScans
    const idxHitPct = total > 0 ? Math.round((idxScans / total) * 100) : 0
    const deadRatio = live + dead > 0 ? Math.round((dead / (live + dead)) * 100) : 0

    // Index pressure and bloat are evaluated separately, because they are
    // different faults with different repairs. Collapsing them into one
    // ternary chain is what let a healthy, well-indexed table be reported as
    // a "hot table" on the strength of its dead-tuple ratio alone.
    //
    // ── The size floor, and why its absence produced every stuck finding ──
    //
    // Sequential-scan COUNT says nothing without table SIZE. Scanning a table
    // that fits in one or two 8KB pages costs less than descending a B-tree,
    // which is why the planner picks a seq scan there and would keep picking
    // it even if an index existed.
    //
    // Without this floor the detector was reporting exactly that situation as
    // a problem. Every one of the seven index-pressure findings sitting open
    // on production was a table with between 0 and 19 LIVE ROWS — including a
    // `users` table with zero rows credited with 13,255 sequential scans. None
    // of them had anything wrong. They could not be auto-repaired either,
    // because there was no sane column to index, so they sat in the review
    // queue permanently telling the owner to fix a table that was empty.
    //
    // 500 rows is where a scan starts to cost more than a lookup on typical
    // row widths. Below it an index is pure write overhead, paid forever, to
    // speed up a scan that was already free — so proposing one is worse than
    // saying nothing.
    const indexPressure: InfraPressure =
      live < HOT_TABLE_MIN_LIVE_ROWS ? 'none' :
      (idxHitPct < 20 && seqScans > 10_000) ? 'critical' :
      (idxHitPct < 50 && seqScans > 1_000)  ? 'high' :
      (idxHitPct < 70 && seqScans > 100)     ? 'medium' :
      'none'
    // Must agree with lib/autonomy/invariant-probes.ts (BLOAT_RATIO_PCT /
    // BLOAT_MIN_DEAD_TUPLES), or the daily scan raises a finding the
    // per-minute probe cannot re-detect and the reaper withdraws it minutes
    // later, forever. 20% was Postgres's own autovacuum trigger point, i.e.
    // the normal operating state of a healthy write-heavy table.
    const bloatPressure: InfraPressure =
      deadRatio >= 40 && dead >= 1_000 ? 'low' : 'none'

    // Index pressure wins when both are present: a table that is both
    // under-indexed and bloated is hurting from the scans first, and the
    // bloat finding will be raised on the next pass once the index lands.
    const kind: 'index_pressure' | 'bloat' =
      indexPressure !== 'none' ? 'index_pressure' : 'bloat'
    const pressure: InfraPressure =
      indexPressure !== 'none' ? indexPressure : bloatPressure

    const idxCol = indexColumn.get(r.tablename)
    // Gated on `kind`, not on a second independent threshold. These used to
    // disagree: a table at 60% coverage was rated 'medium' index pressure but
    // described as a bloat problem and offered no index, because the pressure
    // chain cut at 70 and the recommendation cut at 50.
    // No DESC. It was there because the column used to be picked from a list
    // headed by `created_at`, where a descending index matches "newest first"
    // ordering. The column is now parsed from an equality predicate, and a
    // btree serves equality identically in either direction — leaving DESC
    // would describe an intent the measurement never showed.
    const suggestedIndex = kind === 'index_pressure' && idxCol
      ? `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${r.tablename}_${idxCol} ON "${schemaName}"."${r.tablename}" ("${idxCol}");`
      : undefined

    return {
      table: r.tablename,
      seqScans,
      idxHitPct,
      deadTupRatio: deadRatio,
      liveRows: live,
      pressure,
      kind,
      // Name the actual column when there is one. "add indexes on commonly
      // filtered columns" told the owner nothing they could act on and did not
      // match what the repair would do.
      recommendation: kind === 'index_pressure'
        ? idxCol
          ? `Table "${r.tablename}" is read ${seqScans.toLocaleString()}× with only ${idxHitPct}% index coverage, and the statements doing it filter on "${idxCol}" — indexing that column should absorb most of those scans.`
          : `Table "${r.tablename}" is read ${seqScans.toLocaleString()}× with only ${idxHitPct}% index coverage. Backenly could not measure which column those reads filter on, and will not guess — an index on the wrong column costs a write on every insert forever and nothing surfaces it. Name the column your queries filter or sort by.`
        : `Table "${r.tablename}" is carrying ${deadRatio}% dead rows — Backenly runs VACUUM ANALYZE to reclaim the space and refresh planner statistics.`,
      suggestedIndex,
      indexColumn: idxCol,
    }
  }).filter(f => f.pressure !== 'none')
}

// ── Detection: Partitioning candidates ───────────────────────────────────────
//
// A table larger than PostgreSQL's cache. The manual's rule of thumb (Table
// Partitioning, 5.12.1) is that partitioning pays once "the size of the table
// should exceed the physical memory of the database server". SQL cannot read
// physical memory, so this compares against effective_cache_size, the server's
// own estimate of the memory that caches its data (RDS sets it to half the
// instance's memory), and the advice names both numbers.
//
// This advised partitioning for any table past a million rows, or past 100,000
// with a log-like name, with a "migration" that began by renaming the live
// table aside, and filed it as a change waiting for approval that had nothing
// to approve (production QA, 2026-11-09: a "Partitioning candidate" with no
// next step, for a table PostgreSQL served from memory).
//
// No catch: a read that failed rejects, and the report records it
// (partitioningScanned), so findings are never withdrawn on a failed read.
export async function detectPartitioningCandidates(
  pool: Pool,
  schemaName: string,
): Promise<PartitioningFinding[]> {
  const rows = await pool.query<{ tablename: string; live_rows: string; bytes: string; cache_bytes: string }>(
    // relname, not tablename — see detectHotTables. Backenly's own underscore
    // tables are not the owner's to partition, and a partition is already
    // partitioned (its parent has no storage of its own, so it never qualifies).
    // The size is read once per table: the CTE holds a volatile function, so
    // PostgreSQL keeps it rather than folding it into the filter and the sort.
    `WITH sized AS (
       SELECT s.relname, s.n_live_tup, pg_total_relation_size(s.relid) AS bytes
         FROM pg_stat_user_tables s
         JOIN pg_class c ON c.oid = s.relid
        WHERE s.schemaname = $1
          AND s.relname NOT LIKE '\\_%'
          AND NOT c.relispartition
     )
     SELECT relname AS tablename,
            n_live_tup::bigint AS live_rows,
            bytes,
            pg_size_bytes(current_setting('effective_cache_size')) AS cache_bytes
       FROM sized
      WHERE bytes > pg_size_bytes(current_setting('effective_cache_size'))
      ORDER BY bytes DESC
      LIMIT 15`,
    [schemaName],
  )

  return rows.rows.map(r => {
    const bytes = Number(r.bytes)
    const cacheBytes = Number(r.cache_bytes)
    return {
      table: r.tablename,
      liveRows: Number(r.live_rows),
      bytes,
      cacheBytes,
      recommendation:
        `"${r.tablename}" takes ${sizeWords(bytes)}, more than the ${sizeWords(cacheBytes)} PostgreSQL ` +
        `expects to have cached on this server, so reads of it cannot all come from memory.`,
    }
  })
}

// ── Partitioning findings: what one scan changes ─────────────────────────────

export interface FiledPartitionFinding {
  id: string
  type: string
  status: string
  details: unknown
}

export interface PartitionFindingPlan {
  /** Raised under the retired row-count rule: withdrawn as `detector_retired`. */
  retire: FiledPartitionFinding[]
  /** Its table fits in the cache again: withdrawn, a condition that cleared, never a fix. */
  cleared: FiledPartitionFinding[]
  /** Still true, with sizes that moved: the same finding, its numbers brought up to date. */
  refresh: Array<{ id: string; details: Record<string, unknown> }>
  /** New, assuming every row in `retire` was withdrawn. */
  raise: PartitioningFinding[]
}

const partitionType = (table: string) => `infra_partition_${table}`

/**
 * Pure: what a scan does to the partitioning findings already filed, of every
 * status. Nothing at all after a read that failed. A finding a person
 * dismissed is never raised again; one Backenly withdrew may come back when
 * its table outgrows the cache again (lib/core/finding-reaper.ts).
 */
export function planPartitionFindings(
  filed: FiledPartitionFinding[],
  scan: { scanned: boolean; candidates: PartitioningFinding[] },
): PartitionFindingPlan {
  const plan: PartitionFindingPlan = { retire: [], cleared: [], refresh: [], raise: [] }
  if (!scan.scanned) return plan

  const candidates = new Map(scan.candidates.map(f => [partitionType(f.table), f]))
  const kept = new Set<string>()
  for (const row of filed) {
    if (!row.type.startsWith('infra_partition_')) continue
    const d = (row.details ?? {}) as Record<string, unknown>
    if (row.status === 'dismissed') {
      // A person's dismissal stands; a withdrawal (withdrawnBy) does not.
      if (!d.withdrawnBy) kept.add(row.type)
      continue
    }
    if (row.status !== 'open' && row.status !== 'pending_approval') continue
    if (typeof d.cacheBytes !== 'number') {
      plan.retire.push(row)
      continue
    }
    const now = candidates.get(row.type)
    if (!now) {
      plan.cleared.push(row)
      continue
    }
    kept.add(row.type)
    if (d.description !== now.recommendation) {
      plan.refresh.push({
        id: row.id,
        details: { ...d, description: now.recommendation, liveRows: now.liveRows, bytes: now.bytes, cacheBytes: now.cacheBytes },
      })
    }
  }
  plan.raise = scan.candidates.filter(f => !kept.has(partitionType(f.table)))
  return plan
}

// ── Detection: Slow queries (pg_stat_statements) ──────────────────────────────

/**
 * The table and column a slow query filters on, when that is unambiguous.
 *
 * Pure and deliberately conservative. The consumer turns this into a CREATE
 * INDEX, and this codebase has already paid once for a repair built from a
 * guessed column (see the `infra_hot_table` split): an index on the wrong column
 * costs write throughput for as long as it exists, and nothing ever tells you.
 * So this recognises one shape — an equality predicate on a schema-qualified
 * table — and answers null for everything else rather than approximating.
 *
 * pg_stat_statements has already normalised literals to $1, which is what makes
 * the shape stable enough to match at all.
 */
export interface IndexCandidate {
  table: string
  column: string
}

export function extractIndexCandidate(
  queryText: string,
  schemaName: string,
  opts: {
    /**
     * The schema's tables, for a statement this project's own role ran (its
     * functions' or its direct connections'). Such a statement need not name
     * the schema: its search path is the project's schema, so an unqualified
     * table name counts, but only when it is one of these.
     */
    tables?: ReadonlySet<string>
  } = {},
): IndexCandidate | null {
  if (!queryText || !schemaName) return null

  // The table must be named with THIS project's schema. A bare "orders" could
  // belong to any tenant sharing the database. The schema is always quoted (its
  // name has hyphens); the table after it may be quoted or not.
  const esc = schemaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fromRe = new RegExp(`(?:FROM|JOIN|UPDATE|INTO)\\s+"${esc}"\\.${IDENT}${WORD_END}`, 'i')
  const fromMatch = fromRe.exec(queryText)
  let table: string | null = fromMatch ? nameAt(fromMatch, 1) : null
  if (!table && opts.tables) {
    const unqualified = new RegExp(`(?:FROM|JOIN|UPDATE|INTO)\\s+${IDENT}${WORD_END}(?!\\s*\\.)`, 'gi')
    for (let m = unqualified.exec(queryText); m; m = unqualified.exec(queryText)) {
      const name = nameAt(m, 1)
      if (opts.tables.has(name)) {
        table = name
        break
      }
    }
  }
  if (!table) return null

  const whereIdx = queryText.search(/\bWHERE\b/i)
  if (whereIdx === -1) return null
  const predicate = queryText.slice(whereIdx + 5)

  // Qualified first ("orders"."status" = $1), then bare (status = $1), each
  // quoted or not. Only equality and IN: a range or a LIKE '%x' does not
  // necessarily benefit from a plain btree index, and proposing one there would
  // be cargo cult.
  const qualified = new RegExp(`${IDENT}\\.${IDENT}${WORD_END}\\s*(?:=|IN\\b)`, 'i').exec(predicate)
  if (qualified) {
    // The predicate named its table explicitly. If that is not the table we
    // matched in FROM, this filter belongs to a JOINed relation and we know
    // nothing about which column of OUR table is being filtered.
    //
    // Falling through to the bare branch here is a real bug and not a
    // theoretical one: in `FROM "s"."orders" JOIN "s"."users" … WHERE
    // "users"."email" = $1`, the bare pattern matches `email` (it is the
    // identifier immediately before the `=`) and attributes it to `orders`,
    // producing CREATE INDEX on a column `orders` does not have. Answering null
    // is the honest result.
    return nameAt(qualified, 1) === table ? sane(table, nameAt(qualified, 3)) : null
  }
  const bare = new RegExp(`(?<![.A-Za-z0-9_$"])${IDENT}${WORD_END}\\s*(?:=|IN\\b)`, 'gi')
  for (let m = bare.exec(predicate); m; m = bare.exec(predicate)) {
    // `NOT IN (…)` reads as a name followed by IN; a keyword is never a column.
    if (m[1] === undefined && PREDICATE_KEYWORDS.has(m[2].toLowerCase())) continue
    return sane(table, nameAt(m, 1))
  }

  return null
}

/**
 * A name as SQL writes it: quoted, which keeps its case, or unquoted, which
 * PostgreSQL folds to lower case. Two groups: the quoted text, the bare name.
 */
const IDENT = '(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))'
/** The end of a bare name: no backtracking into `othe` from `other.t`. */
const WORD_END = '(?![A-Za-z0-9_$])'
const PREDICATE_KEYWORDS = new Set(['not', 'and', 'or', 'is', 'in', 'on', 'where', 'any', 'all', 'some', 'exists', 'between', 'like', 'ilike', 'similar', 'case', 'when', 'then', 'else', 'end'])

function nameAt(m: RegExpExecArray, group: number): string {
  return m[group] !== undefined ? m[group].replace(/""/g, '"') : m[group + 1].toLowerCase()
}

/**
 * Reject candidates that are pointless rather than wrong. `id` is the primary
 * key and already leads its own unique index, so proposing one is noise that
 * would be filed, verified, discarded, and filed again on the next scan.
 */
function sane(table: string, column: string): IndexCandidate | null {
  if (column === 'id') return null
  return { table, column }
}

async function detectSlowQueries(pool: Pool, schemaName: string): Promise<QueryFinding[]> {
  try {
    // Check if pg_stat_statements is available
    const ext = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
    )
    if (ext.rows.length === 0) {
      if (!_pgStatStatementsWarned) {
        _pgStatStatementsWarned = true
        console.warn(
          '[InfraIntelligence] pg_stat_statements extension is not installed. ' +
          'Slow query detection is disabled. ' +
          'Run: CREATE EXTENSION IF NOT EXISTS pg_stat_statements; and restart PostgreSQL.',
        )
      }
      return []
    }

    const rows = await pool.query<{
      query: string
      calls: string
      avg_ms: string
      avg_rows: string
    }>(
      // ── Scoped to THIS tenant's schema ─────────────────────────────────────
      //
      // pg_stat_statements is per-DATABASE, and every project on this server
      // shares one. Without this filter the scan read every tenant's statements
      // and attributed the slowest to whichever project happened to be scanned,
      // so a customer could be shown someone else's query text as their own
      // performance problem — a cross-tenant leak of query shapes, and advice
      // about a table they do not have.
      //
      // `position()` rather than LIKE on purpose: in LIKE, the `_` in
      // `workspace_<id>` is a single-character wildcard, so the pattern would
      // also match schemas that merely resemble this one.
      //
      // No `NOT LIKE '%pg_catalog%'`: PostgREST, which serves /api/v2 and v1
      // /db, selects `pg_catalog.count(…)` in every statement, so that filter
      // hid all REST traffic (lib/autonomy/slow-query-index.ts has the
      // measurement). The text is read long enough to reach PostgREST's WHERE,
      // which follows fully qualified column lists.
      `SELECT LEFT(query, 4000) AS query,
              calls,
              ROUND((total_exec_time / NULLIF(calls, 0))::numeric, 2) AS avg_ms,
              ROUND((rows / NULLIF(calls, 0))::numeric, 0) AS avg_rows
         FROM pg_stat_statements
        WHERE position($1 in query) > 0
          AND query NOT LIKE '%information_schema%'
          AND (total_exec_time / NULLIF(calls, 0)) > 100
        ORDER BY avg_ms DESC
        LIMIT 8`,
      [schemaName],
    )

    return rows.rows.map(r => {
      const avgMs = Number(r.avg_ms)
      const calls = Number(r.calls)
      const avgRows = Number(r.avg_rows)
      const candidate = extractIndexCandidate(r.query, schemaName)
      return {
        queryPattern: r.query.replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim().slice(0, 400),
        avgMs,
        calls,
        avgRows,
        indexCandidate: candidate ?? undefined,
        pressure: avgMs > 5000 ? 'critical' : avgMs > 1000 ? 'high' : avgMs > 500 ? 'medium' : 'low',
        recommendation: avgRows > 10000
          ? `Query averaging ${Math.round(avgMs)}ms returns ${avgRows.toLocaleString()} rows on average. Add a LIMIT or a covering index to reduce scan scope.`
          : candidate
            ? `Query averaging ${Math.round(avgMs)}ms called ${calls.toLocaleString()}x, filtering "${candidate.table}"."${candidate.column}" with no index on it.`
            : `Query averaging ${Math.round(avgMs)}ms called ${calls.toLocaleString()}x. Add an index on the columns it filters by.`,
      }
    })
  } catch {
    return []
  }
}

// ── Connection pressure — REMOVED 2026-08-09 ─────────────────────────────────
//
// `detectConnectionPressure` counted every connection to the database, compared
// it to max_connections, and filed the result as a per-PROJECT finding. On a
// shared cluster that is one platform fact attributed to every tenant at once:
// ten customers each told their backend is at 82% of max_connections, none of
// them able to do anything about it, and the number moving for reasons that have
// nothing to do with them.
//
// The attributable half moved to lib/autonomy/connection-health.ts, which reads
// only the sessions opened with THIS project's own direct-access roles
// (bkn_ro_<hex> and friends) and reports the one condition an owner can actually
// fix: a connection sitting inside an open transaction, holding locks and
// pinning the vacuum horizon.
//
// Cluster-wide saturation is a platform operations concern. It belongs on an
// operator dashboard, not in a customer's review queue, and inventing a
// per-project finding for it was how it ended up there.

// ── Detection: WebSocket / Realtime pressure ──────────────────────────────────

async function detectWebSocketPressure(
  pool: Pool,
  schemaName: string,
): Promise<WebSocketFinding | null> {
  try {
    // High write tables drive NOTIFY volume, which drives websocket fan-out
    const rows = await pool.query<{ tablename: string; n_tup_ins: string; n_tup_upd: string }>(
      // relname, not tablename — see detectHotTables. Same 42703, same swallow.
      `SELECT relname AS tablename,
              n_tup_ins, n_tup_upd
         FROM pg_stat_user_tables
        WHERE schemaname = $1
          AND (n_tup_ins + n_tup_upd) > 1000
        ORDER BY (n_tup_ins + n_tup_upd) DESC
        LIMIT 5`,
      [schemaName],
    )

    if (rows.rows.length === 0) return null

    const highWriteTables = rows.rows.map(r => r.tablename)
    const totalWrites = rows.rows.reduce(
      (s, r) => s + Number(r.n_tup_ins) + Number(r.n_tup_upd), 0,
    )

    const load: WebSocketFinding['estimatedSubscriberLoad'] =
      totalWrites > 500_000 ? 'high' : totalWrites > 50_000 ? 'medium' : 'low'

    if (load === 'low') return null

    return {
      highWriteTables,
      estimatedSubscriberLoad: load,
      recommendation: load === 'high'
        ? `Tables ${highWriteTables.join(', ')} have very high write volume (${totalWrites.toLocaleString()} mutations). At scale, NOTIFY/LISTEN will saturate. Consider throttling realtime subscriptions to 1-2 second intervals or using a dedicated pub/sub layer.`
        : `Tables ${highWriteTables.join(', ')} generate significant realtime traffic — monitor pg_stat_activity for LISTEN clients exceeding 500.`,
    }
  } catch {
    return null
  }
}

/**
 * The column each named table is measurably filtered by, verified indexable.
 *
 * Returns an empty map when pg_stat_statements is not installed — the honest
 * result, and the reason `infra_hot_table` findings then carry no column and
 * become notify_only rather than auto-applying a guess.
 *
 * Three filters, and a candidate has to survive all of them:
 *   1. PARSED from a real statement, never inferred from a name
 *   2. the column EXISTS on that table (a parse can produce a plausible name for
 *      a column nobody has)
 *   3. no existing index already LEADS with it — re-indexing removes no scans
 */
async function measuredFilterColumns(
  pool: Pool,
  schemaName: string,
  tableNames: string[],
): Promise<Map<string, string>> {
  const picked = new Map<string, string>()
  if (tableNames.length === 0) return picked

  try {
    const ext = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
    )
    if (ext.rows.length === 0) return picked

    // Scoped to THIS schema: pg_stat_statements is per-database and every tenant
    // shares one, so an unscoped read would index a column named in someone
    // else's query. `position()` rather than LIKE, where `_` is a wildcard.
    //
    // No latency threshold here, deliberately. The evidence for a hot table is
    // its scan count, which the caller already measured; this query only has to
    // answer WHICH column, so a fast statement run ten thousand times is exactly
    // as informative as a slow one. Ordered by total time so the column the
    // table spends the most time filtering wins when several qualify.
    // No `NOT LIKE '%pg_catalog%'` (see detectSlowQueries): it hid every
    // PostgREST statement, so a table read only through the REST APIs could
    // never name its measured column, and its Hot table finding named none.
    const stmts = await pool.query<{ query: string }>(
      `SELECT LEFT(query, 4000) AS query
         FROM pg_stat_statements
        WHERE position($1 in query) > 0
          AND query NOT LIKE '%information_schema%'
        ORDER BY total_exec_time DESC
        LIMIT 100`,
      [schemaName],
    )

    const wanted = new Set(tableNames)
    const candidates = new Map<string, string>()
    for (const row of stmts.rows) {
      const cand = extractIndexCandidate(row.query, schemaName)
      if (!cand || !wanted.has(cand.table)) continue
      // First match wins: rows arrive worst-first, so this is the column the
      // table spends the most time filtering on.
      if (!candidates.has(cand.table)) candidates.set(cand.table, cand.column)
    }
    if (candidates.size === 0) return picked

    const verified = await pool.query<{
      table_name: string
      column_name: string
      already_indexed: boolean
    }>(
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
          AND c.relkind = 'r'
          AND c.relname = ANY($2::text[])`,
      [schemaName, [...candidates.keys()]],
    )

    const indexable = new Map<string, boolean>()
    for (const v of verified.rows) {
      indexable.set(`${v.table_name}.${v.column_name}`, !v.already_indexed)
    }

    for (const [table, column] of candidates) {
      if (indexable.get(`${table}.${column}`) === true) picked.set(table, column)
    }
    return picked
  } catch {
    // Never invent a column because a lookup failed. An empty map degrades the
    // finding to notify_only, which is the correct answer under uncertainty.
    return picked
  }
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Run a full infrastructure intelligence scan for a project's workspace schema.
 * Returns a structured InfraReport — never throws.
 */
export async function runInfraIntelligence(
  projectId: string,
  schemaName?: string,
): Promise<InfraReport> {
  const schema = schemaName ?? `workspace_${projectId}`
  const scannedAt = new Date().toISOString()

  const pool = await getPool(projectId)
  try {
    const [hotTables, partitionCandidates, slowQueries, wsPressure] =
      await Promise.allSettled([
        detectHotTables(pool, schema),
        detectPartitioningCandidates(pool, schema),
        detectSlowQueries(pool, schema),
        detectWebSocketPressure(pool, schema),
      ])

    const report: InfraReport = {
      projectId,
      schemaName: schema,
      scannedAt,
      overallPressure: 'none',
      hotTables: hotTables.status === 'fulfilled' ? hotTables.value : [],
      partitioningCandidates: partitionCandidates.status === 'fulfilled' ? partitionCandidates.value : [],
      hotTablesScanned: hotTables.status === 'fulfilled',
      partitioningScanned: partitionCandidates.status === 'fulfilled',
      slowQueries: slowQueries.status === 'fulfilled' ? slowQueries.value : [],
      websocketPressure: wsPressure.status === 'fulfilled' ? wsPressure.value : null,
      topRecommendations: [],
      autoApplicableFixes: [],
      approvalRequired: [],
    }

    // Compute overall pressure (highest severity across all findings)
    const pressureRank: Record<InfraPressure, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
    const allPressures: InfraPressure[] = [
      ...report.hotTables.map(f => f.pressure),
      // Advice, never pressure on its own: a table larger than the cache is
      // served from disk, which is slower, not broken.
      ...report.partitioningCandidates.map((): InfraPressure => 'low'),
      ...report.slowQueries.map(f => f.pressure),
    ]
    const maxPressure = allPressures.reduce<InfraPressure>(
      (best, p) => pressureRank[p] > pressureRank[best] ? p : best,
      'none',
    )
    report.overallPressure = maxPressure

    // Top recommendations (critical + high first, max 6)
    const recs: Array<{ priority: number; text: string }> = []
    for (const f of report.hotTables.filter(f => f.pressure === 'critical' || f.pressure === 'high')) {
      recs.push({ priority: pressureRank[f.pressure], text: f.recommendation })
    }
    for (const f of report.partitioningCandidates) {
      recs.push({ priority: pressureRank.low, text: f.recommendation })
    }
    for (const f of report.slowQueries.filter(f => f.pressure === 'critical' || f.pressure === 'high')) {
      recs.push({ priority: pressureRank[f.pressure], text: f.recommendation })
    }
    report.topRecommendations = recs
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 6)
      .map(r => r.text)

    // Auto-applicable fixes (safe: index creation, VACUUM hints — no drops)
    for (const f of report.hotTables) {
      if (f.suggestedIndex && (f.pressure === 'critical' || f.pressure === 'high')) {
        report.autoApplicableFixes.push(f.suggestedIndex)
      }
    }
    // Unused-index removal moved to lib/autonomy/unused-index.ts, which raises a
    // real `unused_index` finding through the approval queue instead of pushing
    // SQL into an array nothing reads.

    return report
  } finally {
    await pool.end().catch(() => {})
  }
}

/**
 * Run infra intelligence and store findings as HealthFinding rows.
 * Fire-and-forget — never throws.
 */
export async function runAndStoreInfraIntelligence(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    const report = await runInfraIntelligence(projectId)

    // NOTE: the `overallPressure === 'none'` early return used to sit here, and
    // it made auto-resolve impossible: a project that had just been fixed
    // reported no pressure, returned immediately, and left its old findings open
    // forever. Healthy is precisely when stale findings must be withdrawn, so
    // the gate now sits after the resolve pass below.
    const { prisma } = await import('@/lib/db/prisma')

    // Deduplicate against open findings
    const existing = await prisma.healthFinding.findMany({
      where: { projectId, status: 'open', type: { startsWith: literalPrefix('infra_') } },
      select: { id: true, type: true, details: true },
    }).catch(() => [])
    const existingTypes = new Set(existing.map(e => e.type))
    // A hot table a person dismissed is not raised again: only Backenly's own
    // withdrawals (details.withdrawnBy) may come back (lib/core/finding-reaper.ts).
    // Deduplicating against open rows alone raised it again the next minute,
    // undoing the person's decision. Null when the read failed: then no hot
    // table is raised this pass, rather than one a person may have dismissed.
    const dismissedHotRows = await prisma.healthFinding.findMany({
      where: { projectId, status: 'dismissed', type: { startsWith: 'infra_hot_table_' } },
      select: { type: true, details: true },
    }).catch(() => null)
    const dismissedHot = dismissedHotRows
      ? new Set(
          dismissedHotRows
            .filter(r => !(r.details as { withdrawnBy?: unknown } | null)?.withdrawnBy)
            .map(r => r.type),
        )
      : null

    type PrismaFindingCreate = {
      projectId: string
      type: string
      severity: string
      details: object
      status: string
      autoFixed: boolean
    }

    const toCreate: PrismaFindingCreate[] = []

    // ── Refresh details on hot-table findings that already exist ──────────────
    //
    // Creation is guarded by `!existingTypes.has(type)`, so a finding raised
    // before this detector learned to name its index column would keep the old
    // details forever — including the `created_at` SQL that could not run. The
    // fix would be deployed and the finding would still be dead.
    //
    // Only `details` is touched. Status, severity and detectedAt are the
    // finding's own history and are not rewritten by a re-scan.
    // ── Bloat findings are NOT raised here ───────────────────────────────────
    //
    // Bloat is owned by the per-minute invariant probe (detectTableBloat), which
    // emits the canonical type `infra_table_bloat`. This daily scan emits
    // per-table types (`infra_hot_table_<table>`), and the two cannot both file
    // the same logical finding: `ensureFinding` dedupes on an EXACT type match,
    // so `infra_table_bloat` and `infra_table_bloat_users` would never recognise
    // each other and every bloated table would carry two rows — one per source,
    // neither able to resolve the other.
    //
    // Bloat stays in `report.hotTables` because the infra report surface still
    // shows it. It simply no longer mints findings. One producer per finding
    // type is the rule; the alternative is the duplicate-row bug this codebase
    // has already paid for once with `missing_fk::prompts.user_id`.
    const indexPressureTables = report.hotTables.filter(f => f.kind === 'index_pressure')

    const hotByType = new Map(
      indexPressureTables.map(f => [`infra_hot_table_${f.table}`, f]),
    )
    for (const [type, f] of hotByType) {
      if (!existingTypes.has(type)) continue
      await prisma.healthFinding.updateMany({
        where: { projectId, type, status: 'open' },
        data: {
          details: {
            title: f.kind === 'bloat' ? `Table bloat: ${f.table}` : `Hot table: ${f.table}`,
            description: f.recommendation,
            source: 'infra_intelligence',
            table: f.table,
            tableName: f.table,
            columnName: f.indexColumn ?? null,
            idxHitPct: f.idxHitPct,
            seqScans: f.seqScans,
            deadTupRatio: f.deadTupRatio,
            fix: f.suggestedIndex ?? null,
            requiresApproval: false,
            detectedAt: report.scannedAt,
          } as any,
        },
      }).catch(() => {})
    }

    // ── Withdraw hot-table findings the scan no longer reports ────────────────
    //
    // Without this a finding outlives its cause: add the index and the row stays
    // open forever, so the dashboard keeps showing a problem that no longer
    // exists. It is also how the platform-internal `_email_verifications` rows
    // clear now that underscore tables are excluded from detection.
    //
    // Through the reaper kernel, as a condition that cleared: these were marked
    // 'resolved', a status no surface classifies (lib/autonomy/resolution.ts),
    // and Backenly did not repair them. Only after a read that finished: an
    // empty list from a failed one withdrew every hot-table finding at once.
    if (report.hotTablesScanned) {
      const stale = existing.filter(
        e =>
          (e.type.startsWith('infra_hot_table_') || e.type.startsWith('infra_table_bloat_')) &&
          !hotByType.has(e.type),
      )
      if (stale.length) {
        const { withdrawFindings } = await import('@/lib/core/finding-reaper')
        const withdrawn = await withdrawFindings(stale, 'infra_reaper')
        console.log(`[InfraIntelligence] withdrew ${withdrawn} hot-table finding(s) no longer detected`)
      }
    }

    // ── Partitioning findings ────────────────────────────────────────────────
    //
    // Closed through the reaper kernel, so no surface reads a closure as a
    // repair (lib/autonomy/resolution.ts): one raised under the retired
    // row-count rule is withdrawn as `detector_retired`, and one whose table
    // fits in the cache again as a condition that cleared. Nothing changes
    // after a read that failed (planPartitionFindings).
    const filedPartitions = await prisma.healthFinding.findMany({
      where: { projectId, type: { startsWith: 'infra_partition_' } },
      select: { id: true, type: true, status: true, details: true },
    }).catch(() => null)
    let partitionsToRaise: PartitioningFinding[] = []
    if (filedPartitions) {
      const plan = planPartitionFindings(filedPartitions, {
        scanned: report.partitioningScanned,
        candidates: report.partitioningCandidates,
      })
      const { withdrawFindings } = await import('@/lib/core/finding-reaper')
      // A row raised under the old rule for a table that still outgrows the
      // cache is replaced by a new one, and only once it is withdrawn: never two.
      const stillFiled = new Set<string>()
      for (const row of plan.retire) {
        if ((await withdrawFindings([row], 'detector_retired')) === 0) stillFiled.add(row.type)
      }
      if (plan.cleared.length) await withdrawFindings(plan.cleared, 'infra_reaper')
      for (const r of plan.refresh) {
        await prisma.healthFinding.update({ where: { id: r.id }, data: { details: r.details as any } }).catch(() => {})
      }
      partitionsToRaise = plan.raise.filter(f => !stillFiled.has(`infra_partition_${f.table}`))
    }

    // Nothing under pressure — the resolve pass above has already withdrawn
    // anything stale, so there is nothing left to raise.
    if (report.overallPressure === 'none') return

    // Hot tables → HealthFinding
    for (const f of indexPressureTables) {
      const type = `infra_hot_table_${f.table}`
      if (dismissedHot && !existingTypes.has(type) && !dismissedHot.has(type)) {
        toCreate.push({
          projectId,
          type,
          severity: mapPressureToSeverity(f.pressure),
          details: {
            title: f.kind === 'bloat' ? `Table bloat: ${f.table}` : `Hot table: ${f.table}`,
            description: f.recommendation,
            source: 'infra_intelligence',
            table: f.table,
            // buildFixAction reads tableName/columnName. `table` alone left the
            // repair path with nothing to build CREATE_INDEX from, so every
            // "Fix now" click on a hot-table finding failed.
            tableName: f.table,
            columnName: f.indexColumn ?? null,
            idxHitPct: f.idxHitPct,
            seqScans: f.seqScans,
            deadTupRatio: f.deadTupRatio,
            fix: f.suggestedIndex ?? null,
            requiresApproval: false,
            detectedAt: report.scannedAt,
          },
          status: 'open',
          autoFixed: false,
        })
      }
    }

    // Partitioning candidates → HealthFinding. Advice with a next step, not a
    // change waiting for approval: there is no statement to approve, since
    // partitioning a table that holds data moves every row.
    for (const f of partitionsToRaise) {
      toCreate.push({
        projectId,
        type: `infra_partition_${f.table}`,
        severity: 'info',
        details: {
          title: `Larger than the cache: ${f.table}`,
          description: f.recommendation,
          source: 'infra_intelligence',
          table: f.table,
          tableName: f.table,
          liveRows: f.liveRows,
          bytes: f.bytes,
          cacheBytes: f.cacheBytes,
          requiresApproval: false,
          detectedAt: report.scannedAt,
        },
        status: 'open',
        autoFixed: false,
      })
    }

    // `infra_connection_pressure` was raised here until 2026-08-09. It was a
    // cluster-wide number filed against one tenant — see the tombstone above.
    // The attributable condition is now `idle_in_transaction`, raised by the
    // per-minute invariant probe in lib/autonomy/connection-health.ts.

    if (toCreate.length > 0) {
      await prisma.healthFinding.createMany({ data: toCreate as any, skipDuplicates: true }).catch(() => {})
    }

    // This pass changes no schema. It used to run each hot table's CREATE INDEX
    // itself, on its own pool, every minute: outside the change ledger (so a
    // restore could not see the index and was refused over it), with no
    // breaker, and through an incident freeze. Every autonomous repair goes
    // through the governed kernel instead, and the repair loop's measured
    // invariants (measured_slow_queries_are_indexed, hot_path_columns_are_
    // indexed) index what they detect there. This pass reports: its findings
    // carry the column, so "Fix now" applies one through the same kernel.

    if (toCreate.length > 0) {
      // Notify
      await prisma.platformNotification.create({
        data: {
          userId,
          projectId,
          type: 'infra_intelligence',
          title: `Infrastructure pressure detected (${report.overallPressure})`,
          body: report.topRecommendations[0] ?? 'Review infra findings in your project dashboard.',
          metadata: {
            overallPressure: report.overallPressure,
            findingCount: toCreate.length,
            // Nothing is applied by this pass (see above).
            autoFixed: 0,
            source: 'infra_intelligence',
          },
          read: false,
        } as any,
      }).catch(() => {})
    }

    console.log(`[InfraIntelligence] project=${projectId} pressure=${report.overallPressure} findings=${toCreate.length} applicableIndexes=${report.autoApplicableFixes.length}`)
  } catch (err: any) {
    console.warn(`[InfraIntelligence] Failed for project ${projectId}:`, err?.message)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapPressureToSeverity(p: InfraPressure): string {
  switch (p) {
    case 'critical': return 'critical'
    case 'high':     return 'error'
    case 'medium':   return 'warning'
    default:         return 'info'
  }
}

function fmtBytes(b: number): string {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b > 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}
