/**
 * TELEMETRY — what an extraction is observed and measured by
 * ===========================================================
 *
 * Three questions, asked at different times and answered from different
 * sources:
 *
 *   observe   is the cut-over change behaving right now? Hard signals only,
 *             cheap enough for an hourly pass: the two representations agree,
 *             the satellite is still the one this ladder built, and requests
 *             to it are not failing with server errors.
 *   snapshot  what the numbers were at one moment (R, S0, S1, S2, L30, L90),
 *             kept in architecture memory because the request log keeps 30
 *             days and a benefit can take 90 to show.
 *   measure   before against after, as Measurements the engine's benefit
 *             judge (lib/evolution-engine/benefit.ts) can decide on.
 *
 * ── What an extraction can change before `contract` ─────────────────────────
 *
 * Until a person runs `contract`, the host keeps every member column, every
 * index on them, and gains an AFTER trigger; every write to the concern now
 * writes two rows. So host latency, HOT ratio, dead rows and size cannot get
 * better — they can only stay flat or get worse. They are GUARDRAILS (they can
 * say "regressed" and nothing else) or COSTS (reported, never a verdict). The
 * only honest benefits are the ones tied to the cost that fired the proposal,
 * and only those named in `firedBy` are measured:
 *
 *   hot_host_change     later changes to the concern land on the satellite and
 *                       take no lock on the host
 *   attributed_repairs  fewer repairs located on the concern's columns
 *
 * Both are counted in schema history and health findings, which are kept, so
 * both can be judged at L30 and L90, long after the request log has aged out.
 *
 * ── Request windows ─────────────────────────────────────────────────────────
 *
 * The request log has one row per request with a whole-millisecond end-to-end
 * duration and no query string. Requests are attributed to a table by path, on
 * BOTH surfaces: `/db/<table>(/…)` (v1) and `/<table>(/…)` (v2, PostgREST
 * grammar — the surface a client uses to embed the satellite). Platform rows
 * (`/api/…`) and preview branches are excluded, as every other autonomy reader
 * does. One indexed pass over (projectId, timestamp) per window; rows are
 * aggregated in SQL and never loaded.
 *
 * Guardrails compare [S0 − L, S0) with [S1, S1 + L), L = now − S1: equal
 * lengths, adjacent to the change, skipping the backfill in between. While the
 * older window is inside 28 days both are recomputed from the raw log;
 * afterwards the "before" side is the 7-day aggregate stored at S0, and the
 * scope says the windows are unequal.
 *
 * ── Counters ────────────────────────────────────────────────────────────────
 *
 * Table counters (pg_stat_user_tables) and statement classes
 * (pg_stat_statements, top-level statements only, Backenly's own role
 * excluded so reconciliation and backfill never count as client work) are
 * cumulative. A delta between two snapshots is UNAVAILABLE, never zero, when:
 *
 *   stats_reset         the database or statement statistics were reset, or a
 *                       counter went backwards (single-table reset, crash)
 *   statements_evicted  pg_stat_statements dropped entries in between, so a
 *                       class sum can under-count
 *   relation_recreated  the table's oid changed: dropped and created again
 *   extension_missing / statement_text_hidden
 *                       the capability was not there at both ends; text hidden
 *                       behind `<insufficient privilege>` would make every
 *                       class match nothing and read as "no work", so it is
 *                       reported, never summed
 *
 * Per-class sums, not per-statement maps, keep a snapshot near 1–2 KB: a
 * statement shape first seen after the earlier snapshot still contributes its
 * full count from zero, and the rules above cover evictions and resets.
 *
 * Read-only. Every number that could not be read carries a reason from the
 * closed set in lib/evolution-engine/primitive.ts.
 */

import { prisma } from '@/lib/db'
import type {
  Measurement,
  ObservationSignal,
  SnapshotPhase,
  TelemetrySnapshot,
  UnavailableReason,
} from '@/lib/evolution-engine/primitive'
import { CONSISTENCY_SIGNAL } from '@/lib/evolution-engine/observe'
import { MIN_INCIDENTS } from '@/lib/autonomy/maintenance/outcome'
import type { ExtractionPlan } from './plan'
import { readTableFacts } from './facts'
import { reconcileExtraction } from './reconcile'
import { isOurSatellite } from './primitives'
import { columnHistory, readRepairs, readSnapshots, type SnapshotRow } from './sensing'
import { hostStem, readName } from './lexicon'

// ── Thresholds ───────────────────────────────────────────────────────────────

/** Server errors on the new table before observation calls it a regression… */
export const NEW_PATH_MIN_ERRORS = 3
/** …out of at least this many requests… */
export const NEW_PATH_MIN_REQUESTS = 20
/** …at this rate or more. */
export const NEW_PATH_MIN_RATE = 0.01

/** Requests on each side before a rate or a p95 counts. */
export const MIN_REQUESTS = 200
/** Statement calls on each side before a mean database time counts. */
export const MIN_STATEMENT_CALLS = 100

/** The raw request log is trusted this far back (it is pruned at 30 days). */
export const RAW_LOG_DAYS = 28
/** The request aggregate stored at S0, as insurance against that pruning. */
export const S0_AGGREGATE_DAYS = 7
/** How far back a snapshot reads concern evidence, and how much of it it keeps. */
export const EVIDENCE_DAYS = 365
export const EVIDENCE_KEPT = 20

const DAY = 86_400_000
const HOUR = 3_600_000

// ── Snapshot shape (opaque to the engine) ────────────────────────────────────

export interface TableCounters {
  oid: number
  ins: number
  upd: number
  hotUpd: number
  del: number
  live: number
  dead: number
  bytes: number
}

export interface StatementClass {
  calls: number
  ms: number
  rows: number
}

export type StatementClassName = 'hostWrite' | 'hostReadOnly' | 'hostReadWithSat' | 'satWrite' | 'satRead'
export type StatementClasses = Record<StatementClassName, StatementClass>

export type StatementCapability = 'available' | 'missing' | 'text_hidden' | 'unreadable'

export interface StatementReading {
  state: StatementCapability
  classes: StatementClasses | null
  statsReset: string | null
  dealloc: number | null
  hidden: number
  detail: string
}

export interface RequestClass {
  n: number
  p50: number | null
  p95: number | null
  s5xx: number
  s401: number
  s403: number
}

export interface RequestWindow {
  from: string
  to: string
  /** Every request of the project in the window, attributed or not. */
  project: number
  hostRead: RequestClass
  hostWrite: RequestClass
  satRead: RequestClass
  satWrite: RequestClass
}

export interface ConcernEvidence {
  /** Whether schema history could be read at all. */
  history: boolean
  /** When a change touching the concern landed on the host / on the satellite, newest last. */
  hostChanges: string[]
  satChanges: string[]
  /** When a repair located on a member column was detected, newest last. */
  repairs: string[]
  /** Totals before truncation to EVIDENCE_KEPT: [host, satellite, repairs]. */
  n: [number, number, number]
}

export interface ExtractionTelemetry {
  db: { statsReset: string | null }
  pgss: { state: StatementCapability; statsReset: string | null; dealloc: number | null; hidden: number }
  tables: { host: TableCounters | null; satellite: TableCounters | null }
  statements: StatementClasses | null
  /** S0 only: the host's request aggregate for the S0_AGGREGATE_DAYS before the change. */
  requests?: Pick<RequestWindow, 'from' | 'to' | 'project' | 'hostRead' | 'hostWrite'>
  /** R, S0, L30, L90: what the pressure-linked benefits are counted from. */
  concern?: ConcernEvidence
}

type Unavailable = TelemetrySnapshot['unavailable'][number]

// ── Small helpers ────────────────────────────────────────────────────────────

type Query = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => Promise<T[]>
const platform: Query = (sql, ...params) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any>

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v))
/** Second precision: what a person reads, and a third shorter than milliseconds. */
const short = (at: string | Date) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200)
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function span(ms: number): string {
  if (ms < 2 * HOUR) return `${Math.max(1, Math.round(ms / 60_000))} minutes`
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} hours`
  return `${Math.round(ms / DAY)} days`
}

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * The table a recorded path is for, in SQL: `/db/<t>` on v1, `/<t>` on v2.
 * The request recorder strips the project prefix and the query string, so
 * these are the only two shapes a table request can take.
 */
const PATH_TABLE = `COALESCE(substring(path FROM '^/db/([A-Za-z0-9_]+)'), substring(path FROM '^/([A-Za-z0-9_]+)(?:/|$)'))`

const emptyClass = (): RequestClass => ({ n: 0, p50: null, p95: null, s5xx: 0, s401: 0, s403: 0 })

/**
 * Host and satellite request aggregates for [from, to), in one indexed pass.
 * Null when the log could not be read — never an empty window.
 */
export async function readRequestWindow(
  projectId: string,
  host: string,
  satellite: string,
  from: Date,
  to: Date,
  opts: { percentiles?: boolean } = {},
): Promise<RequestWindow | null> {
  const pct = opts.percentiles !== false
  const percentiles = pct
    ? `, percentile_disc(0.5) WITHIN GROUP (ORDER BY duration) FILTER (WHERE cls NOT LIKE 'other%') AS p50
       , percentile_disc(0.95) WITHIN GROUP (ORDER BY duration) FILTER (WHERE cls NOT LIKE 'other%') AS p95`
    : ''
  try {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT cls, count(*)::int AS n,
              count(*) FILTER (WHERE sc >= 500)::int AS s5xx,
              count(*) FILTER (WHERE sc = 401)::int AS s401,
              count(*) FILTER (WHERE sc = 403)::int AS s403
              ${percentiles}
         FROM (SELECT "statusCode" AS sc, duration,
                      CASE ${PATH_TABLE} WHEN $4 THEN 'host' WHEN $5 THEN 'sat' ELSE 'other' END ||
                      CASE WHEN method = 'GET' OR path LIKE '%/vector-search' THEN 'Read' ELSE 'Write' END AS cls
                 FROM api_request_logs
                WHERE "projectId" = $1 AND "branchId" IS NULL
                  AND "timestamp" >= $2 AND "timestamp" < $3
                  AND path NOT LIKE '/api/%') w
        GROUP BY cls`,
      projectId,
      from,
      to,
      host,
      satellite,
    )
    const out: RequestWindow = {
      from: short(from),
      to: short(to),
      project: 0,
      hostRead: emptyClass(),
      hostWrite: emptyClass(),
      satRead: emptyClass(),
      satWrite: emptyClass(),
    }
    for (const r of rows) {
      const n = num(r.n)
      out.project += n
      const cls = String(r.cls) as keyof RequestWindow
      if (!['hostRead', 'hostWrite', 'satRead', 'satWrite'].includes(cls)) continue
      out[cls as 'hostRead'] = {
        n,
        p50: numOrNull(r.p50),
        p95: numOrNull(r.p95),
        s5xx: num(r.s5xx),
        s401: num(r.s401),
        s403: num(r.s403),
      }
    }
    return out
  } catch {
    return null
  }
}

// ── Table counters ───────────────────────────────────────────────────────────

async function readCounters(
  schema: string,
  host: string,
  satellite: string,
): Promise<{ host: TableCounters | null; satellite: TableCounters | null; statsReset: string | null }> {
  const rows = await platform(
    `SELECT v.role, c.oid::int8 AS oid,
            s.n_tup_ins::int8 AS ins, s.n_tup_upd::int8 AS upd, s.n_tup_hot_upd::int8 AS hot,
            s.n_tup_del::int8 AS del, s.n_live_tup::int8 AS live, s.n_dead_tup::int8 AS dead,
            CASE WHEN c.oid IS NULL THEN NULL ELSE pg_total_relation_size(c.oid)::int8 END AS bytes,
            (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS db_reset
       FROM (VALUES ('host', to_regclass(format('%I.%I', $1::text, $2::text))),
                    ('satellite', to_regclass(format('%I.%I', $1::text, $3::text)))) v(role, rel)
       LEFT JOIN pg_class c ON c.oid = v.rel::oid
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid`,
    schema,
    host,
    satellite,
  )
  const of = (role: string): TableCounters | null => {
    const r = rows.find(x => x.role === role)
    if (!r || r.oid === null || r.oid === undefined) return null
    return {
      oid: num(r.oid),
      ins: num(r.ins),
      upd: num(r.upd),
      hotUpd: num(r.hot),
      del: num(r.del),
      live: num(r.live),
      dead: num(r.dead),
      bytes: num(r.bytes),
    }
  }
  return { host: of('host'), satellite: of('satellite'), statsReset: iso(rows[0]?.db_reset ?? null) }
}

// ── Statement classes ────────────────────────────────────────────────────────

/** A qualified name as PostgREST writes it ("s"."t") or a person does (s.t). */
const qualified = (schema: string, table: string) => `"?${reEscape(schema)}"?\\."?${reEscape(table)}"?`
const refersTo = (schema: string, table: string) => `(^|[^A-Za-z0-9_"])${qualified(schema, table)}($|[^A-Za-z0-9_"])`
const writesTo = (schema: string, table: string) =>
  `(insert\\s+into|update|delete\\s+from)\\s+(only\\s+)?${qualified(schema, table)}($|[^A-Za-z0-9_"])`

const CLASS_SQL = (toplevel: boolean) => `
  WITH s AS (
    SELECT calls, total_exec_time, rows, query
      FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       ${toplevel ? 'AND toplevel' : ''}
       AND userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ), k AS (
    SELECT calls, total_exec_time, rows,
           query ~* $1 AS hw, query ~* $2 AS ha, query ~* $3 AS sw, query ~* $4 AS sa
      FROM s WHERE query <> '<insufficient privilege>'
  )
  SELECT (SELECT count(*)::int FROM s WHERE query = '<insufficient privilege>') AS hidden,
         ${(
           [
             ['hw', 'hw'],
             ['hro', 'ha AND NOT hw AND NOT sa'],
             ['hrs', 'ha AND sa AND NOT hw AND NOT sw'],
             ['sw', 'sw'],
             ['sr', 'sa AND NOT sw AND NOT ha'],
           ] as const
         )
           .map(
             ([p, f]) =>
               `coalesce(sum(calls) FILTER (WHERE ${f}), 0)::float8 AS ${p}_calls, ` +
               `coalesce(sum(total_exec_time) FILTER (WHERE ${f}), 0)::float8 AS ${p}_ms, ` +
               `coalesce(sum(rows) FILTER (WHERE ${f}), 0)::float8 AS ${p}_rows`,
           )
           .join(',\n         ')}
    FROM k`

/**
 * Per-class sums of pg_stat_statements for the host and the satellite.
 *
 * `run` defaults to the platform connection; it is a parameter so a test can
 * read as a role that cannot see other roles' statement text and prove the
 * reading says so instead of reporting no work.
 */
export async function readStatementClasses(
  schema: string,
  host: string,
  satellite: string,
  run: Query = platform,
): Promise<StatementReading> {
  const none = (state: StatementCapability, detail: string, hidden = 0): StatementReading => ({
    state,
    classes: null,
    statsReset: null,
    dealloc: null,
    hidden,
    detail,
  })
  try {
    const ext = await run<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`,
    )
    if (!ext[0]?.installed) return none('missing', 'pg_stat_statements is not installed in this database')
  } catch (err) {
    return none('unreadable', `the extension list could not be read: ${errText(err)}`)
  }

  const params = [writesTo(schema, host), refersTo(schema, host), writesTo(schema, satellite), refersTo(schema, satellite)]
  let row: Record<string, unknown> | undefined
  try {
    row = (await run(CLASS_SQL(true), ...params))[0]
  } catch {
    // Before PostgreSQL 14 there is no `toplevel`; with the default
    // track = top nested statements are not recorded at all.
    try {
      row = (await run(CLASS_SQL(false), ...params))[0]
    } catch (err) {
      return none('unreadable', `pg_stat_statements could not be read: ${errText(err)}`)
    }
  }
  const hidden = num(row?.hidden)
  if (hidden > 0) {
    return none(
      'text_hidden',
      `${hidden} statement(s) of other roles are hidden from Backenly's database role (it lacks pg_read_all_stats), so per-table statement time cannot be told apart`,
      hidden,
    )
  }

  let statsReset: string | null = null
  let dealloc: number | null = null
  try {
    const info = await run(`SELECT dealloc::int8 AS dealloc, stats_reset FROM pg_stat_statements_info`)
    dealloc = numOrNull(info[0]?.dealloc)
    statsReset = iso(info[0]?.stats_reset ?? null)
  } catch {
    // PostgreSQL 13 and older: no eviction or reset record. Deltas then rely
    // on counters never going backwards, which is still checked.
  }
  const cls = (p: string): StatementClass => ({ calls: num(row?.[`${p}_calls`]), ms: num(row?.[`${p}_ms`]), rows: num(row?.[`${p}_rows`]) })
  return {
    state: 'available',
    classes: { hostWrite: cls('hw'), hostReadOnly: cls('hro'), hostReadWithSat: cls('hrs'), satWrite: cls('sw'), satRead: cls('sr') },
    statsReset,
    dealloc,
    hidden: 0,
    detail: 'top-level statements of every role but Backenly’s own',
  }
}

// ── Concern evidence ─────────────────────────────────────────────────────────

/** Whether a host column belongs to the concern: a member, or a new column named for it. */
function concernColumn(plan: ExtractionPlan): (column: string) => boolean {
  const { host, members, label } = plan.spec
  const set = new Set(members)
  const labelStem = readName(label.trim().replace(/\s+/g, '_'), hostStem(host)).stem
  return c => set.has(c) || (labelStem !== null && readName(c, hostStem(host)).stem === labelStem)
}

interface LiveEvidence {
  history: boolean
  historyReason: string | null
  hostChanges: string[]
  satChanges: string[]
  repairs: Array<{ id: string; at: string }>
  /** False when the findings could not be read, so `repairs` is not "none". */
  repairsReadable: boolean
}

async function readEvidence(projectId: string, plan: ExtractionPlan, since: Date, snapshots?: SnapshotRow[] | { unavailable: string }): Promise<LiveEvidence> {
  const { host, satellite, members } = plan.spec
  const series = snapshots ?? (await readSnapshots(projectId))
  const hostHistory = columnHistory(series, host)
  const satHistory = columnHistory(series, satellite)
  const isConcern = concernColumn(plan)
  const memberSet = new Set(members)
  const seen = new Set<string>()
  const repairs: Array<{ id: string; at: string }> = []
  const found = await readRepairs(projectId, since)
  for (const r of found ?? []) {
    if ((r.table !== host && r.table !== satellite) || !memberSet.has(r.column) || seen.has(r.findingId)) continue
    seen.add(r.findingId)
    repairs.push({ id: r.findingId, at: r.at })
  }
  repairs.sort((a, b) => a.at.localeCompare(b.at))
  return {
    history: hostHistory.available,
    historyReason: hostHistory.available ? null : hostHistory.reason ?? 'schema history is not available',
    hostChanges: hostHistory.events.filter(e => e.columns.some(isConcern)).map(e => e.at),
    // The satellite IS the concern: every change to it is a change to the concern.
    satChanges: satHistory.available ? satHistory.events.map(e => e.at) : [],
    repairs,
    repairsReadable: found !== null,
  }
}

function keep(evidence: LiveEvidence, since: Date): ConcernEvidence {
  const after = (at: string) => new Date(at).getTime() >= since.getTime()
  const host = evidence.hostChanges.filter(after)
  const sat = evidence.satChanges.filter(after)
  const repairs = evidence.repairs.map(r => r.at).filter(after)
  const tail = (xs: string[]) => xs.slice(-EVIDENCE_KEPT).map(short)
  return {
    history: evidence.history,
    hostChanges: tail(host),
    satChanges: tail(sat),
    repairs: tail(repairs),
    n: [host.length, sat.length, repairs.length],
  }
}

// ── Observe ──────────────────────────────────────────────────────────────────

export async function observeExtraction(
  projectId: string,
  plan: ExtractionPlan,
  window: { since: Date; now: Date },
): Promise<ObservationSignal[]> {
  const { host, satellite } = plan.spec
  const signals: ObservationSignal[] = []

  let present: 'ours' | 'gone' | 'foreign' | 'unknown' = 'unknown'
  let satDetail = ''
  try {
    const sat = await readTableFacts(plan.schema, satellite)
    present = !sat ? 'gone' : isOurSatellite(sat, plan.spec) ? 'ours' : 'foreign'
  } catch (err) {
    satDetail = errText(err)
  }
  signals.push(
    present === 'ours'
      ? { name: 'satellite_present', status: 'ok', detail: `${satellite} is the table Backenly created` }
      : present === 'gone'
        ? { name: 'satellite_present', status: 'regressed', detail: `${satellite} was removed outside Backenly` }
        : present === 'foreign'
          ? {
              name: 'satellite_present',
              status: 'regressed',
              detail: `${satellite} was replaced outside Backenly: it no longer refers to ${host} the way Backenly built it`,
            }
          : { name: 'satellite_present', status: 'unavailable', detail: `the catalog could not be read: ${satDetail}` },
  )

  if (present !== 'ours') {
    signals.unshift({
      name: CONSISTENCY_SIGNAL,
      status: 'unavailable',
      detail: present === 'unknown' ? 'the catalog could not be read' : `there is no ${satellite} built by Backenly to compare with ${host}`,
    })
  } else {
    let consistency: ObservationSignal
    try {
      const facts = await readTableFacts(plan.schema, host)
      if (!facts) {
        consistency = { name: CONSISTENCY_SIGNAL, status: 'regressed', detail: `${host} no longer exists` }
      } else {
        const r = await reconcileExtraction(projectId, facts, plan.spec)
        consistency = { name: CONSISTENCY_SIGNAL, status: r.consistent ? 'ok' : 'regressed', detail: r.summary }
      }
    } catch (err) {
      consistency = { name: CONSISTENCY_SIGNAL, status: 'unavailable', detail: `reconciliation could not run: ${errText(err)}` }
    }
    signals.unshift(consistency)
  }

  const w = await readRequestWindow(projectId, host, satellite, window.since, window.now, { percentiles: false })
  if (!w) {
    signals.push({ name: 'new_path_errors', status: 'unavailable', detail: 'the request log could not be read' })
  } else {
    const n = w.satRead.n + w.satWrite.n
    const errors = w.satRead.s5xx + w.satWrite.s5xx
    const regressed = errors >= NEW_PATH_MIN_ERRORS && n >= NEW_PATH_MIN_REQUESTS && errors / n >= NEW_PATH_MIN_RATE
    signals.push({
      name: 'new_path_errors',
      status: regressed ? 'regressed' : 'ok',
      detail:
        n === 0
          ? `no requests to ${satellite} since the change`
          : `${errors} of ${n} request(s) to ${satellite} since the change failed with a server error`,
    })
  }
  return signals
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

const CONCERN_PHASES: ReadonlyArray<SnapshotPhase> = ['R', 'S0', 'L30', 'L90']

export async function snapshotExtraction(
  projectId: string,
  plan: ExtractionPlan,
  phase: SnapshotPhase,
  now: Date,
): Promise<TelemetrySnapshot> {
  const { host, satellite } = plan.spec
  const unavailable: Unavailable[] = []

  const [counters, statements] = await Promise.all([
    readCounters(plan.schema, host, satellite).catch(err => {
      unavailable.push({ metric: 'tables', reason: 'not_yet_measurable', detail: `table statistics could not be read: ${errText(err)}` })
      return { host: null, satellite: null, statsReset: null }
    }),
    readStatementClasses(plan.schema, host, satellite),
  ])
  if (statements.state !== 'available') {
    unavailable.push({
      metric: 'statements',
      reason: statements.state === 'text_hidden' ? 'statement_text_hidden' : 'extension_missing',
      detail: statements.detail,
    })
  }

  const data: ExtractionTelemetry = {
    db: { statsReset: counters.statsReset },
    pgss: { state: statements.state, statsReset: statements.statsReset, dealloc: statements.dealloc, hidden: statements.hidden },
    tables: { host: counters.host, satellite: counters.satellite },
    statements: statements.classes,
  }

  if (phase === 'S0') {
    const w = await readRequestWindow(projectId, host, satellite, new Date(now.getTime() - S0_AGGREGATE_DAYS * DAY), now)
    if (w) data.requests = { from: w.from, to: w.to, project: w.project, hostRead: w.hostRead, hostWrite: w.hostWrite }
    else unavailable.push({ metric: 'requests', reason: 'request_log_unreadable', detail: 'the request log could not be read' })
  }

  if (CONCERN_PHASES.includes(phase)) {
    const since = new Date(now.getTime() - EVIDENCE_DAYS * DAY)
    const evidence = await readEvidence(projectId, plan, since)
    data.concern = keep(evidence, since)
    if (!evidence.history) {
      unavailable.push({ metric: 'concern.history', reason: 'not_yet_measurable', detail: evidence.historyReason ?? 'schema history is not available' })
    }
  }

  return { v: 1, phase, at: now.toISOString(), data: data as unknown as Record<string, unknown>, unavailable }
}

// ── Measure ──────────────────────────────────────────────────────────────────

interface Snap {
  phase: SnapshotPhase
  at: Date
  data: Partial<ExtractionTelemetry>
}

function snaps(all: TelemetrySnapshot[]): Snap[] {
  return all
    .filter(s => s && s.v === 1 && typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)))
    .map(s => ({ phase: s.phase, at: new Date(s.at), data: (s.data ?? {}) as Partial<ExtractionTelemetry> }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** R is the FIRST assessment of a plan version; every other phase, the latest. */
function pick(all: Snap[], phase: SnapshotPhase): Snap | null {
  const of = all.filter(s => s.phase === phase)
  return (phase === 'R' ? of[0] : of[of.length - 1]) ?? null
}

type Delta<T> = { ok: true; value: T } | { ok: false; reason: UnavailableReason; detail: string }
const isDeltaRefusal = <T>(d: Delta<T>): d is Extract<Delta<T>, { ok: false }> => !d.ok

/** The §4.4 validity rules for statement-class deltas between two snapshots. */
function statementDelta(a: Snap, b: Snap, cls: StatementClassName, host: string): Delta<{ calls: number; ms: number }> {
  for (const s of [a, b]) {
    const state = s.data.pgss?.state ?? 'unreadable'
    if (state === 'text_hidden') {
      return { ok: false, reason: 'statement_text_hidden', detail: `at ${s.phase}, other roles' statements were hidden from Backenly's database role` }
    }
    if (state !== 'available' || !s.data.statements) {
      return { ok: false, reason: 'extension_missing', detail: `statement statistics were not readable at ${s.phase}` }
    }
  }
  if ((a.data.pgss!.statsReset ?? null) !== (b.data.pgss!.statsReset ?? null)) {
    return { ok: false, reason: 'stats_reset', detail: `statement statistics were reset between ${a.phase} and ${b.phase}` }
  }
  const da = a.data.pgss!.dealloc
  const db = b.data.pgss!.dealloc
  if (da !== null && da !== undefined && db !== null && db !== undefined && db > da) {
    return { ok: false, reason: 'statements_evicted', detail: `statement statistics dropped entries ${db - da} time(s) between ${a.phase} and ${b.phase}` }
  }
  const oa = a.data.tables?.host?.oid
  const ob = b.data.tables?.host?.oid
  if (oa !== undefined && ob !== undefined && oa !== ob) {
    return { ok: false, reason: 'relation_recreated', detail: `${host} was dropped and created again between ${a.phase} and ${b.phase}` }
  }
  const x = a.data.statements![cls]
  const y = b.data.statements![cls]
  if (!x || !y) return { ok: false, reason: 'not_yet_measurable', detail: `no ${cls} reading at ${!x ? a.phase : b.phase}` }
  if (y.calls < x.calls || y.ms < x.ms) {
    return { ok: false, reason: 'stats_reset', detail: `a statement counter went backwards between ${a.phase} and ${b.phase}` }
  }
  return { ok: true, value: { calls: y.calls - x.calls, ms: y.ms - x.ms } }
}

/** The same rules for table counters. */
function tableDelta(a: Snap, b: Snap, plan: ExtractionPlan): Delta<{ host: number; sat: number }> {
  const { host, satellite } = plan.spec
  if ((a.data.db?.statsReset ?? null) !== (b.data.db?.statsReset ?? null)) {
    return { ok: false, reason: 'stats_reset', detail: `table statistics were reset between ${a.phase} and ${b.phase}` }
  }
  const pairs: Array<[string, TableCounters | null | undefined, TableCounters | null | undefined]> = [
    [host, a.data.tables?.host, b.data.tables?.host],
    [satellite, a.data.tables?.satellite, b.data.tables?.satellite],
  ]
  for (const [name, x, y] of pairs) {
    if (!x || !y) return { ok: false, reason: 'not_yet_measurable', detail: `${name} had no statistics at ${!x ? a.phase : b.phase}` }
    if (x.oid !== y.oid) return { ok: false, reason: 'relation_recreated', detail: `${name} was dropped and created again between ${a.phase} and ${b.phase}` }
    if (y.ins < x.ins || y.upd < x.upd || y.del < x.del || y.hotUpd < x.hotUpd) {
      return { ok: false, reason: 'stats_reset', detail: `a counter of ${name} went backwards between ${a.phase} and ${b.phase}` }
    }
  }
  const writes = (t: TableCounters) => t.ins + t.upd + t.del
  return {
    ok: true,
    value: {
      host: writes(b.data.tables!.host!) - writes(a.data.tables!.host!),
      sat: writes(b.data.tables!.satellite!) - writes(a.data.tables!.satellite!),
    },
  }
}

function unmeasurable(
  base: Pick<Measurement, 'name' | 'role' | 'unit' | 'better' | 'minSamples' | 'scope'>,
  reason: UnavailableReason,
  detail: string,
): Measurement {
  return { ...base, before: null, after: null, samplesBefore: null, samplesAfter: null, reason, unavailableReason: detail }
}

/** Why a side of a request measurement has no value. */
function emptySide(w: Pick<RequestWindow, 'project'>, what: string, when: string): { reason: UnavailableReason; detail: string } {
  return w.project === 0
    ? { reason: 'no_traffic_recorded', detail: `no requests to this project were recorded ${when}` }
    : { reason: 'table_not_served_over_api', detail: `no ${what} were recorded ${when}` }
}

type HostWindow = Pick<RequestWindow, 'project' | 'hostRead' | 'hostWrite'>

async function requestGuardrails(projectId: string, plan: ExtractionPlan, s0: Snap | null, s1: Snap | null, now: Date): Promise<Measurement[]> {
  const { host, satellite } = plan.spec
  const kinds = [
    { name: `${host} server errors`, unit: 'ratio', key: 's5xx' as const },
    { name: `${host} permission refusals`, unit: 'ratio', key: 's403' as const },
    { name: `${host} read p95`, unit: 'ms', key: 'read' as const },
    { name: `${host} write p95`, unit: 'ms', key: 'write' as const },
  ]
  const shape = (k: (typeof kinds)[number], scope: string) =>
    ({ name: k.name, role: 'guardrail', unit: k.unit, better: 'lower', minSamples: MIN_REQUESTS, scope }) as const

  if (!s0 || !s1) {
    const missing = !s0 ? 'when the change started' : 'when it finished'
    return kinds.map(k => unmeasurable(shape(k, `requests to ${host}`), 'not_yet_measurable', `no snapshot marks ${missing}`))
  }
  const L = now.getTime() - s1.at.getTime()
  if (L <= 0) {
    return kinds.map(k => unmeasurable(shape(k, `requests to ${host}`), 'not_yet_measurable', 'observation has not started'))
  }

  let before: HostWindow | null
  let after: HostWindow | null
  let scope: string
  let beforeWhen: string
  const afterWhen = 'since the change'
  let beforeMissing: { reason: UnavailableReason; detail: string } | null = null
  const beforeFrom = new Date(s0.at.getTime() - L)
  if (now.getTime() - beforeFrom.getTime() <= RAW_LOG_DAYS * DAY) {
    ;[before, after] = await Promise.all([
      readRequestWindow(projectId, host, satellite, beforeFrom, s0.at),
      readRequestWindow(projectId, host, satellite, s1.at, now),
    ])
    scope = `requests to ${host} in the ${span(L)} before the change and the ${span(L)} after`
    beforeWhen = `in the ${span(L)} before the change`
  } else {
    const afterFrom = new Date(Math.max(s1.at.getTime(), now.getTime() - RAW_LOG_DAYS * DAY))
    before = s0.data.requests ?? null
    after = await readRequestWindow(projectId, host, satellite, afterFrom, now)
    scope =
      `requests to ${host} in the ${S0_AGGREGATE_DAYS} days before the change (kept when it started) and the ` +
      `${span(now.getTime() - afterFrom.getTime())} up to now: the windows are not the same length, because the request log keeps 30 days`
    beforeWhen = `in the ${S0_AGGREGATE_DAYS} days before the change`
    if (!before) beforeMissing = { reason: 'window_aged_out', detail: 'the request log no longer holds the period before the change, and no aggregate was kept when it started' }
  }
  if (!before && !beforeMissing) beforeMissing = { reason: 'request_log_unreadable', detail: 'the request log could not be read' }

  return kinds.map(k => {
    const base = shape(k, scope)
    if (beforeMissing) return unmeasurable(base, beforeMissing.reason, beforeMissing.detail)
    if (!after) return unmeasurable(base, 'request_log_unreadable', 'the request log could not be read')
    const b = before!
    if (k.key === 's5xx' || k.key === 's403') {
      const nb = b.hostRead.n + b.hostWrite.n
      const na = after.hostRead.n + after.hostWrite.n
      const eb = b.hostRead[k.key] + b.hostWrite[k.key]
      const ea = after.hostRead[k.key] + after.hostWrite[k.key]
      const missing = nb === 0 ? emptySide(b, `requests to ${host}`, beforeWhen) : na === 0 ? emptySide(after, `requests to ${host}`, afterWhen) : null
      if (missing) return unmeasurable(base, missing.reason, missing.detail)
      return { ...base, before: eb / nb, after: ea / na, samplesBefore: nb, samplesAfter: na, eventsBefore: eb, eventsAfter: ea }
    }
    const cb = k.key === 'read' ? b.hostRead : b.hostWrite
    const ca = k.key === 'read' ? after.hostRead : after.hostWrite
    const what = `${k.key === 'read' ? 'reads of' : 'writes to'} ${host}`
    const missing =
      cb.n === 0 || cb.p95 === null ? emptySide(b, what, beforeWhen) : ca.n === 0 || ca.p95 === null ? emptySide(after, what, afterWhen) : null
    if (missing) return unmeasurable(base, missing.reason, missing.detail)
    return { ...base, before: cb.p95, after: ca.p95, samplesBefore: cb.n, samplesAfter: ca.n }
  })
}

function writeTimeGuardrail(plan: ExtractionPlan, r: Snap | null, s0: Snap | null, s1: Snap | null, last: Snap | null): Measurement {
  const { host, satellite } = plan.spec
  const base = {
    name: `${host} write time in the database`,
    role: 'guardrail' as const,
    unit: 'ms',
    better: 'lower' as const,
    minSamples: MIN_STATEMENT_CALLS,
    scope:
      `average database time per write statement on ${host}, from the proposal to the start of the change and from its end to now; ` +
      `it includes keeping ${satellite} in step`,
  }
  if (!r || !s0) return unmeasurable(base, 'not_yet_measurable', 'no pair of snapshots brackets the time before the change')
  if (!s1 || !last) return unmeasurable(base, 'not_yet_measurable', 'no pair of snapshots brackets the time after the change')
  const before = statementDelta(r, s0, 'hostWrite', host)
  if (isDeltaRefusal(before)) return unmeasurable(base, before.reason, before.detail)
  const after = statementDelta(s1, last, 'hostWrite', host)
  if (isDeltaRefusal(after)) return unmeasurable(base, after.reason, after.detail)
  if (before.value.calls === 0 || after.value.calls === 0) {
    const side = before.value.calls === 0 ? 'before the change' : 'since the change'
    return unmeasurable(base, 'insufficient_sample', `no write statements on ${host} were recorded ${side}`)
  }
  return {
    ...base,
    before: before.value.ms / before.value.calls,
    after: after.value.ms / after.value.calls,
    samplesBefore: before.value.calls,
    samplesAfter: after.value.calls,
  }
}

function costs(plan: ExtractionPlan, s1: Snap | null, last: Snap | null): Measurement[] {
  const { host, satellite } = plan.spec
  const size = {
    name: `storage taken by ${satellite}`,
    role: 'cost' as const,
    unit: 'bytes',
    better: 'lower' as const,
    minSamples: 0,
    scope: `${satellite} with its indexes; nothing is removed from ${host} until the old columns are dropped`,
  }
  const amp = {
    name: `extra rows written per ${host} write`,
    role: 'cost' as const,
    unit: '',
    better: 'lower' as const,
    minSamples: 0,
    scope: `rows written to ${satellite} for each row written to ${host} since the change, in either direction`,
  }
  const out: Measurement[] = []
  const sat = last?.data.tables?.satellite
  out.push(
    sat
      ? // Before the change there was no satellite: zero is the fact, not a default.
        { ...size, before: 0, after: sat.bytes, samplesBefore: null, samplesAfter: null }
      : unmeasurable(size, 'not_yet_measurable', last ? `${satellite} had no statistics at ${last.phase}` : 'no snapshot since the change'),
  )
  if (!s1 || !last || last === s1) {
    out.push(unmeasurable(amp, 'not_yet_measurable', 'no pair of snapshots brackets the time since the change'))
    return out
  }
  const d = tableDelta(s1, last, plan)
  if (isDeltaRefusal(d)) out.push(unmeasurable(amp, d.reason, d.detail))
  else if (d.value.host === 0) out.push(unmeasurable(amp, 'insufficient_sample', `no rows of ${host} were written since the change`))
  else out.push({ ...amp, before: 0, after: d.value.sat / d.value.host, samplesBefore: null, samplesAfter: d.value.host })
  return out
}

async function benefits(
  projectId: string,
  plan: ExtractionPlan,
  firedBy: string[],
  all: Snap[],
  s0: Snap | null,
  s1: Snap | null,
  now: Date,
): Promise<Measurement[]> {
  const { host, satellite, label, members } = plan.spec
  const out: Measurement[] = []
  const wants = new Set(firedBy)
  if (!wants.has('hot_host_change') && !wants.has('attributed_repairs')) return out

  const L = s1 ? now.getTime() - s1.at.getTime() : 0
  const since = s0 && s1 ? new Date(s0.at.getTime() - L) : now
  const live = await readEvidence(projectId, plan, since)

  if (wants.has('hot_host_change')) {
    const base = {
      name: `${label} changes that locked ${host}`,
      role: 'benefit' as const,
      unit: 'changes',
      better: 'lower' as const,
      minSamples: 1,
    }
    if (!s1) {
      out.push(unmeasurable({ ...base, scope: `schema changes to ${label}` }, 'not_yet_measurable', 'the change has not finished'))
    } else {
      // Live history first; if it cannot be read now, the latest snapshot
      // after the change that could read it.
      const kept = [...all].reverse().find(x => x.at.getTime() > s1.at.getTime() && x.data.concern?.history)
      const source = live.history
        ? { host: live.hostChanges, sat: live.satChanges }
        : kept
          ? { host: kept.data.concern!.hostChanges, sat: kept.data.concern!.satChanges }
          : null
      const afterS1 = (at: string) => new Date(at).getTime() > s1.at.getTime() && new Date(at).getTime() <= now.getTime()
      const h = source ? source.host.filter(afterS1).length : 0
      const s = source ? source.sat.filter(afterS1).length : 0
      const total = h + s
      const scope = `${total} change(s) to ${label} since the change: ${s} on ${satellite}, ${h} on ${host}; before it, every one would have locked ${host}`
      if (!source) {
        out.push(unmeasurable({ ...base, scope: `schema changes to ${label}` }, 'not_yet_measurable', live.historyReason ?? 'schema history is not available'))
      } else if (total === 0) {
        out.push(
          unmeasurable({ ...base, scope }, 'insufficient_sample', `${label} has not changed since the change; the saving shows when it does`),
        )
      } else {
        out.push({ ...base, scope, before: total, after: h, samplesBefore: total, samplesAfter: total })
      }
    }
  }

  if (wants.has('attributed_repairs')) {
    const base = {
      name: `repairs on ${label} columns`,
      role: 'benefit' as const,
      unit: 'repairs',
      better: 'lower' as const,
      minSamples: MIN_INCIDENTS,
    }
    if (!s0 || !s1 || L <= 0) {
      out.push(unmeasurable({ ...base, scope: `repairs located on ${members.join(', ')}` }, 'not_yet_measurable', 'the change has not finished'))
    } else if (!live.repairsReadable) {
      out.push(unmeasurable({ ...base, scope: `repairs located on ${members.join(', ')}` }, 'history_unreadable', 'the record of repairs could not be read'))
    } else {
      const t = (at: string) => new Date(at).getTime()
      const nb = live.repairs.filter(r => t(r.at) >= since.getTime() && t(r.at) < s0.at.getTime()).length
      const na = live.repairs.filter(r => t(r.at) >= s1.at.getTime() && t(r.at) < now.getTime()).length
      out.push({
        ...base,
        scope: `repairs located on ${members.join(', ')} in the ${span(L)} before the change and the ${span(L)} after`,
        before: nb,
        after: na,
        samplesBefore: nb,
        // An event count over a window as long as the "before" one; zero is
        // the answer hoped for, so this side has no minimum.
        samplesAfter: null,
      })
    }
  }
  return out
}

export async function measureExtraction(
  projectId: string,
  plan: ExtractionPlan,
  snapshots: TelemetrySnapshot[],
  context: { firedBy: string[]; now: Date },
): Promise<Measurement[]> {
  const { now } = context
  const all = snaps(snapshots)
  const r = pick(all, 'R')
  const s0 = pick(all, 'S0')
  const s1 = pick(all, 'S1')
  const after = s1 ? all.filter(s => ['S2', 'L30', 'L90'].includes(s.phase) && s.at.getTime() > s1.at.getTime()) : []
  const last = after[after.length - 1] ?? null

  const [guardrails, benefit] = await Promise.all([
    requestGuardrails(projectId, plan, s0, s1, now),
    benefits(projectId, plan, context.firedBy, all, s0, s1, now),
  ])
  return [...guardrails, writeTimeGuardrail(plan, r, s0, s1, last), ...costs(plan, s1, last), ...benefit]
}
