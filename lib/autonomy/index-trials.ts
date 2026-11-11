/**
 * INDEX TRIALS — an index Backenly builds on its own has to earn its place
 * =======================================================================
 *
 * The slow-query repair (./slow-query-index.ts) builds an index on a column
 * PostgreSQL measured itself scanning. That measurement says the queries were
 * slow. It does not say the index will make them fast: the planner may decline
 * it (a column that is not selective enough), and every index costs every
 * insert, and every update of its column, for as long as it exists. So an index
 * Backenly builds without a person is a trial, judged the way Azure SQL's
 * automatic tuning judges its own (learn.microsoft.com, "Automatic tuning
 * overview"): validated for 30 minutes to 72 hours, depending on how often the
 * queries run, and removed if performance regresses or no significant
 * improvement is detected.
 *
 * ── The verdict, in order ───────────────────────────────────────────────────
 *
 *   regressed       a measured statement got slower beyond noise: Welch one-
 *                   sided p < 0.05, at least LATENCY_RATIO times and
 *                   LATENCY_MIN_MS slower (the evolution engine's latency
 *                   guardrail, lib/evolution-engine/benefit.ts), and the index
 *                   changed how it runs. Removed at once, even inside the first
 *                   30 minutes.
 *   (30 minutes)    nothing below is decided earlier.
 *   unused          TRIAL_MIN_CALLS measured queries ran since, PostgreSQL has
 *                   not scanned the index, and none of them reads fewer pages.
 *                   Removed: it only costs writes.
 *   net_cost        writes to the table got slower beyond noise, by more time
 *                   than the faster queries saved. Removed.
 *   improved        statements carrying at least half of the measured calls
 *                   since got faster beyond noise (p < 0.05, and by at least
 *                   IMPROVEMENT), and the index is what changed: it was
 *                   scanned, or they read half the pages or fewer. Kept; the
 *                   trial ends.
 *   no_improvement  72 hours passed without a measured improvement, too few
 *                   queries to measure one included. Removed.
 *   unmeasurable    72 hours passed without statement statistics Backenly
 *                   could read. Removed: an index nobody can show helps is
 *                   kept by a person, not by Backenly.
 *
 * Removing is DROP INDEX CONCURRENTLY, as a governed change of its own
 * (lib/changes/ledger.ts), so the history shows the index added and taken away,
 * and the table is never locked against its readers or writers. After a
 * removal Backenly does not build that index on its own for 30 days: the
 * authority decision says so (lib/authority/decision.ts, recently_undone), and a
 * person can still build it.
 *
 * ── Measuring across 72 hours of a shared database ──────────────────────────
 *
 * pg_stat_statements counts each statement since its entry was created, and
 * every project in a database shares the entries. They are evicted when the
 * view is full, and statistics can be reset. A difference between the reading
 * at build time and one three days later would be wrong whenever an entry was
 * evicted and counted again past its old count in between, which in a busy
 * shared database is not rare. So the calls since the build are accumulated
 * pass by pass, each pass adding the difference since the previous one. An
 * entry that went backwards within one pass, or any entry when the statistics
 * were reset, was counted again from zero, and everything it holds is new.
 * What a pass cannot see is an entry evicted and counted past its old count
 * within one interval; for the frequent statements a trial measures, that does
 * not happen.
 *
 * The before side is each statement's whole history at build time: the history
 * the detector measured.
 *
 * ── Whether the index is what changed ───────────────────────────────────────
 *
 * Time alone cannot say: the cache is warmer after a build than in the history
 * before it, and the load moves. So the verdicts that credit or blame the
 * index also need it to have changed how the statements run: PostgreSQL
 * scanned it (pg_stat_user_indexes, which backends report up to a minute
 * late), or the statements now touch half the shared pages per call or fewer
 * (pg_stat_statements, recorded as each statement ends, and the same whether
 * the pages were cached or read).
 *
 * ── Records ─────────────────────────────────────────────────────────────────
 *
 * One ledger row per (table, column), in project_preferences, type
 * `index_trial`, as the unused-index and index-bloat detectors keep theirs. It
 * holds statement ids and numbers, never a statement's text, so it can stay at
 * home for a project kept in another region (lib/data-plane/residency.ts). The
 * same row counts failed online builds in a row (`failures`), which pace the
 * next attempt and, at BUILD_ATTEMPTS, hand the index to a person.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { extractIndexCandidate } from '@/lib/ai/infra-intelligence'
import { IMPROVEMENT, LATENCY_MIN_MS, LATENCY_RATIO } from '@/lib/evolution-engine/benefit'
import { SLOW_QUERY_MIN_CALLS } from './slow-query-index'
import { addTimes, blocksPerCall, NO_TIMES, timesFromStatement, timesSince, welch, type TimeSums } from './index-trial-stats'

export const LEDGER_TYPE = 'index_trial'

/** Nothing but a regression is decided before this. */
export const TRIAL_MIN_MS = 30 * 60_000
/** A trial with no verdict by now ends in removal. */
export const TRIAL_MAX_MS = 72 * 3_600_000
/** Calls a statement needs on each side before it is compared: the detector's own floor. */
export const TRIAL_MIN_CALLS = SLOW_QUERY_MIN_CALLS
/** One-sided significance every verdict needs. */
export const TRIAL_SIGNIFICANCE = 0.05
/** After a removal, how long Backenly leaves building the index again to a person. */
export const TRIAL_COOLDOWN_MS = 30 * 86_400_000
/** Wait after the first and second failed online build before trying again. */
export const BUILD_BACKOFF_MS: readonly number[] = [3_600_000, 4 * 3_600_000]
/** Failed online builds in a row after which a person decides. */
export const BUILD_ATTEMPTS = 3
/** Statements tracked per side, the most frequent first. */
const MAX_TRACKED = 40

export type TrialStatus = 'observing' | 'kept' | 'undone' | 'undo_failed' | 'ended' | 'build_failed'

export type RemovalReason = 'regressed' | 'unused' | 'net_cost' | 'no_improvement' | 'unmeasurable'

/** One reading of the measured statements and the index. Ids and numbers only. */
export interface TrialReading {
  at: string
  /** 'ok' unless pg_stat_statements is missing or could not be read. */
  statements: 'ok' | 'missing' | 'unreadable'
  /** When statement statistics were last reset (pg_stat_statements_info), when readable. */
  statsReset: string | null
  tableOid: string | null
  /** The index, or null when it is not there. */
  index: { valid: boolean; scans: number } | null
  /** Statements filtering the column (by queryid). */
  reads: Record<string, TimeSums>
  /** Statements writing the table that do not filter the column. */
  writes: Record<string, TimeSums>
}

export interface TrialNumbers {
  /** Calls since the build, of the statements compared. */
  readCalls: number
  /** Their mean before and since, weighted by calls since. */
  beforeMs: number
  afterMs: number
  /** Query time the faster statements saved since the build. */
  savedMs: number
  /** Write time the slower writes added since the build. */
  addedWriteMs: number
  /** Index scans since the build. */
  scans: number
}

export interface TrialEntry {
  v: 1
  table: string
  column: string
  status: TrialStatus
  indexName?: string
  findingId?: string | null
  /** The governed changes that built it. */
  changeIds?: string[]
  builtAt?: string
  /** Each measured statement's history at build time. Null until a reading succeeds. */
  before?: { reads: Record<string, TimeSums>; writes: Record<string, TimeSums> } | null
  /** The calls since the build, accumulated pass by pass. */
  since?: { reads: Record<string, TimeSums>; writes: Record<string, TimeSums>; scans: number }
  /** The previous pass's reading, which the next one accumulates from. */
  last?: TrialReading | null
  /**
   * What was measured, as a clause that reads after "because" (no action in
   * it: the record says what was done, and when).
   */
  verdict?: { why: RemovalReason | 'improved' | 'index_gone' | 'table_recreated'; finding: string; decidedAt: string; numbers?: TrialNumbers | null }
  /**
   * Set when the index was taken away, by Backenly or by someone else: before
   * then Backenly does not build it again without a person.
   */
  cooldownUntil?: string
  undoChangeId?: string | null
  undoError?: string
  /** Failed online builds in a row, oldest first. Cleared by a successful build. */
  failures?: Array<{ at: string; reason: string }>
}

// ── Ledger ───────────────────────────────────────────────────────────────────

const keyOf = (table: string, column: string) => `${table}.${column}`

function parseEntry(value: string): TrialEntry | null {
  try {
    const e = JSON.parse(value)
    return e && e.v === 1 && typeof e.table === 'string' && typeof e.column === 'string' ? (e as TrialEntry) : null
  } catch {
    return null
  }
}

export async function loadIndexTrial(projectId: string, table: string, column: string): Promise<TrialEntry | null> {
  const row = await prisma.projectPreference.findUnique({
    where: { projectId_type_key: { projectId, type: LEDGER_TYPE, key: keyOf(table, column) } },
    select: { value: true },
  })
  return row ? parseEntry(row.value) : null
}

async function saveEntry(projectId: string, entry: TrialEntry): Promise<void> {
  const value = JSON.stringify(entry)
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: LEDGER_TYPE, key: keyOf(entry.table, entry.column) } },
    create: { projectId, type: LEDGER_TYPE, key: keyOf(entry.table, entry.column), value, confidence: 1 },
    update: { value, lastSeen: new Date() },
  })
}

/** What the authority decision needs to know about earlier attempts at this index. */
export interface IndexAttempts {
  /**
   * Backenly built it and it was taken away: by whom, why, and until when the
   * next build is left to a person.
   */
  removed: { by: 'backenly' | 'someone_else'; builtAt: string | null; removedAt: string; until: string; finding: string } | null
  /** Failed online builds in a row, and the last one's reason. */
  failures: number
  lastFailure: string | null
}

export function attemptsOf(entry: TrialEntry | null, nowMs: number = Date.now()): IndexAttempts {
  const failures = entry?.failures ?? []
  const removed =
    entry && (entry.status === 'undone' || entry.status === 'ended') && entry.cooldownUntil && Date.parse(entry.cooldownUntil) > nowMs && entry.verdict
      ? {
          by: entry.status === 'undone' ? ('backenly' as const) : ('someone_else' as const),
          builtAt: entry.builtAt ?? null,
          removedAt: entry.verdict.decidedAt,
          until: entry.cooldownUntil,
          finding: entry.verdict.finding,
        }
      : null
  return { removed, failures: failures.length, lastFailure: failures.length ? failures[failures.length - 1].reason : null }
}

export async function indexAttempts(projectId: string, table: string, column: string): Promise<IndexAttempts> {
  return attemptsOf(await loadIndexTrial(projectId, table, column))
}

/**
 * Whether an online build of this index must wait, and why. The first failure
 * waits an hour, the second four: a build that failed while PostgreSQL waited
 * for older transactions has already read the whole table twice, and the loop
 * passes every minute. From BUILD_ATTEMPTS on, the authority decision hands it
 * to a person instead.
 */
export function buildWaitOf(entry: TrialEntry | null, nowMs: number = Date.now()): string | null {
  const failures = entry?.failures ?? []
  if (failures.length === 0 || failures.length >= BUILD_ATTEMPTS) return null
  const last = failures[failures.length - 1]
  const until = Date.parse(last.at) + BUILD_BACKOFF_MS[Math.min(failures.length, BUILD_BACKOFF_MS.length) - 1]
  if (!(until > nowMs)) return null
  return (
    `The last attempt to build this index without blocking the table failed (${last.reason}). ` +
    `Backenly will try again after ${new Date(until).toISOString().slice(11, 16)} UTC.`
  )
}

export async function noteIndexBuildFailure(projectId: string, table: string, column: string, reason: string): Promise<void> {
  const prior = await loadIndexTrial(projectId, table, column).catch(() => null)
  // A failure while a trial or a cooldown is on record keeps that record.
  const base: TrialEntry = prior && prior.status !== 'build_failed' ? prior : { v: 1, table, column, status: 'build_failed' }
  const failures = [...(prior?.failures ?? []), { at: new Date().toISOString(), reason: reason.slice(0, 300) }].slice(-BUILD_ATTEMPTS)
  await saveEntry(projectId, { ...base, failures })
}

/** A build of this index succeeded without a trial: its failures in a row are over. */
export async function noteIndexBuilt(projectId: string, table: string, column: string): Promise<void> {
  const prior = await loadIndexTrial(projectId, table, column).catch(() => null)
  if (!prior || !prior.failures?.length) return
  if (prior.status === 'build_failed') {
    // Nothing else on record: the row was only counting failures.
    await prisma.projectPreference
      .delete({ where: { projectId_type_key: { projectId, type: LEDGER_TYPE, key: keyOf(table, column) } } })
      .catch(() => {})
    return
  }
  await saveEntry(projectId, { ...prior, failures: [] })
}

/**
 * Open a trial for an index Backenly just built on its own. `reading` is taken
 * right after the build; if it failed, the next review takes the before side.
 */
export async function startIndexTrial(args: {
  projectId: string
  table: string
  column: string
  indexName: string
  findingId: string | null
  changeIds: string[]
  reading: TrialReading | null
}): Promise<void> {
  const ok = args.reading && args.reading.statements === 'ok' && args.reading.index
  await saveEntry(args.projectId, {
    v: 1,
    table: args.table,
    column: args.column,
    status: 'observing',
    indexName: args.indexName,
    findingId: args.findingId,
    changeIds: args.changeIds,
    builtAt: new Date().toISOString(),
    before: ok ? { reads: args.reading!.reads, writes: args.reading!.writes } : null,
    since: { reads: {}, writes: {}, scans: 0 },
    last: ok ? args.reading : null,
  })
}

// ── Reading ──────────────────────────────────────────────────────────────────

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** INSERT, UPDATE or DELETE on the table, anywhere in the statement (PostgREST wraps writes in a CTE). */
function writesTable(schema: string, table: string): RegExp {
  const q = `"?${reEscape(schema)}"?\\."?${reEscape(table)}"?`
  return new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(only\\s+)?${q}($|[^A-Za-z0-9_"])`, 'i')
}

function topByCalls(m: Map<string, TimeSums>): Record<string, TimeSums> {
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_TRACKED))
}

type Run = <R = Record<string, unknown>>(sql: string, ...params: unknown[]) => Promise<R[]>

async function workspaceRun(projectId: string): Promise<Run> {
  const { queryWorkspace } = await import('@/lib/services/workspace-pool')
  return async <R>(sql: string, ...params: unknown[]) => {
    const res: any = await queryWorkspace(projectId, sql, params)
    return (res?.rows ?? res ?? []) as R[]
  }
}

/**
 * Read the measured statements, the index and the table, on the project's own
 * database. Never throws: what could not be read is said in the reading.
 */
export async function readIndexTrial(
  projectId: string,
  table: string,
  column: string,
  indexName: string,
  run?: Run,
): Promise<TrialReading> {
  const at = new Date().toISOString()
  const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
  const schema = await resolveWorkspaceSchema(projectId)
  const q = run ?? (await workspaceRun(projectId))

  let tableOid: string | null = null
  let index: TrialReading['index'] = null
  try {
    const t = await q<{ oid: string }>(
      `SELECT c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
      schema, table,
    )
    tableOid = t[0]?.oid ?? null
    const i = await q<{ valid: boolean; scans: string | number }>(
      `SELECT ix.indisvalid AS valid, pg_stat_get_numscans(i.oid)::int8 AS scans
         FROM pg_class i
         JOIN pg_index ix ON ix.indexrelid = i.oid
         JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE n.nspname = $1 AND i.relname = $2`,
      schema, indexName,
    )
    index = i[0] ? { valid: Boolean(i[0].valid), scans: Number(i[0].scans) || 0 } : null
  } catch {
    return { at, statements: 'unreadable', statsReset: null, tableOid, index, reads: {}, writes: {} }
  }

  const empty = (statements: TrialReading['statements']): TrialReading => ({ at, statements, statsReset: null, tableOid, index, reads: {}, writes: {} })
  try {
    const ext = await q<{ installed: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`)
    if (!ext[0]?.installed) return empty('missing')
  } catch {
    return empty('unreadable')
  }

  let rows: Array<{ id: string | null; calls: number; total: number; sd: number; blocks: number; query: string }>
  let statsReset: string | null = null
  try {
    // Scoped to this database and to statements naming this project's schema;
    // the text is parsed below, never stored.
    rows = await q(
      `SELECT queryid::text AS id, calls::float8 AS calls, total_exec_time::float8 AS total,
              stddev_exec_time::float8 AS sd, (shared_blks_hit + shared_blks_read)::float8 AS blocks,
              LEFT(query, 4000) AS query
         FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND position($1 in query) > 0`,
      schema,
    )
    const info = await q<{ stats_reset: Date | string | null }>(`SELECT stats_reset FROM pg_stat_statements_info`).catch(() => [])
    const r = info[0]?.stats_reset
    statsReset = r ? new Date(r as any).toISOString() : null
  } catch {
    return empty('unreadable')
  }

  const writes = writesTable(schema, table)
  const reads = new Map<string, TimeSums>()
  const others = new Map<string, TimeSums>()
  for (const row of rows) {
    if (!row.id) continue
    const query = String(row.query ?? '')
    const sums = timesFromStatement(row.calls, row.total, row.sd, row.blocks)
    const cand = extractIndexCandidate(query, schema)
    // One statement can have a row per role; they add up.
    if (cand && cand.table === table && cand.column === column) reads.set(row.id, addTimes(reads.get(row.id) ?? NO_TIMES, sums))
    else if (writes.test(query)) others.set(row.id, addTimes(others.get(row.id) ?? NO_TIMES, sums))
  }
  return { at, statements: 'ok', statsReset, tableOid, index, reads: topByCalls(reads), writes: topByCalls(others) }
}

// ── Judging (pure) ───────────────────────────────────────────────────────────

/**
 * Add what a reading counted since the previous one. When the statistics were
 * reset in between, every entry was counted again from zero.
 */
export function accumulate(entry: TrialEntry, now: TrialReading): TrialEntry {
  const last = entry.last
  const since = entry.since ?? { reads: {}, writes: {}, scans: 0 }
  if (!last || now.statements !== 'ok' || last.statements !== 'ok') return { ...entry, last: now.statements === 'ok' ? now : last ?? null }
  const reset = now.statsReset !== last.statsReset
  const add = (acc: Record<string, TimeSums>, prev: Record<string, TimeSums>, cur: Record<string, TimeSums>, tracked: Record<string, TimeSums>) => {
    const out = { ...acc }
    // Only statements on the before side are compared; a statement first
    // seen later has nothing to be compared with.
    for (const id of Object.keys(tracked)) {
      const d = timesSince(reset ? undefined : prev[id], cur[id])
      if (d.n > 0) out[id] = addTimes(out[id] ?? NO_TIMES, d)
    }
    return out
  }
  const before = entry.before ?? { reads: {}, writes: {} }
  const lastScans = last.index?.scans ?? 0
  const nowScans = now.index?.scans ?? 0
  return {
    ...entry,
    since: {
      reads: add(since.reads, last.reads, now.reads, before.reads),
      writes: add(since.writes, last.writes, now.writes, before.writes),
      // A counter that went backwards was reset: everything it holds is new.
      scans: since.scans + (nowScans >= lastScans ? nowScans - lastScans : nowScans),
    },
    last: now,
  }
}

/**
 * `finding` is what was measured, written to follow "because": the caller says
 * what was done about it.
 */
export type TrialJudgement =
  | { kind: 'observe'; why: string }
  | { kind: 'ended'; why: 'index_gone' | 'table_recreated'; finding: string }
  | { kind: 'keep'; finding: string; numbers: TrialNumbers }
  | { kind: 'remove'; why: RemovalReason; finding: string; numbers: TrialNumbers | null }

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`)
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * The verdict on a trial, from its accumulated calls and the latest reading.
 * Pure: the same record and reading always give the same answer.
 */
export function judgeTrial(entry: TrialEntry, now: TrialReading, nowMs: number): TrialJudgement {
  const name = `${entry.table}.${entry.column}`
  const elapsed = nowMs - Date.parse(entry.builtAt ?? new Date(nowMs).toISOString())
  const deadline = elapsed >= TRIAL_MAX_MS

  if (now.statements !== 'unreadable' && !now.index) {
    return { kind: 'ended', why: 'index_gone', finding: `someone removed it before the trial ended` }
  }
  if (now.tableOid && entry.last?.tableOid && now.tableOid !== entry.last.tableOid) {
    return { kind: 'ended', why: 'table_recreated', finding: `${entry.table} was dropped and created again, so its measurements no longer apply` }
  }
  if (!entry.before || now.statements !== 'ok') {
    if (!deadline) return { kind: 'observe', why: 'statement statistics could not be read on this pass' }
    return {
      kind: 'remove',
      why: 'unmeasurable',
      numbers: null,
      finding: `query statistics could not be read in the 72 hours after it was built, so nothing shows it helps`,
    }
  }

  const before = entry.before
  const since = entry.since ?? { reads: {}, writes: {}, scans: 0 }
  const α = TRIAL_SIGNIFICANCE

  // ── The statements the index was built for ──
  const tested: Array<{ id: string; n: number; w: NonNullable<ReturnType<typeof welch>>; pages: number | null }> = []
  let readCalls = 0
  for (const [id, b] of Object.entries(before.reads)) {
    const a = since.reads[id] ?? NO_TIMES
    readCalls += a.n
    if (b.n < TRIAL_MIN_CALLS || a.n < TRIAL_MIN_CALLS) continue
    const w = welch(b, a)
    const pb = blocksPerCall(b)
    const pa = blocksPerCall(a)
    // Pages touched per call, since over before: how the plan changed.
    if (w) tested.push({ id, n: a.n, w, pages: pb && pa !== null ? pa / pb : null })
  }

  // ── Did the index change how they run? ──
  //
  // Its scan counter says so, but backends report it late (PostgreSQL flushes
  // a backend's statistics at most once a second, and up to a minute late when
  // it is busy), so a used index can still read zero. Pages per call say it at
  // once: a statement that now reads half the pages or fewer has a plan that
  // uses the index, whatever the cache held. Time alone says neither: a warmer
  // cache makes an unused index look helpful.
  const scanned = since.scans > 0
  const fewerPages = tested.some((t) => t.pages !== null && t.pages <= 0.5)
  const planChanged = scanned || tested.some((t) => t.pages !== null && (t.pages <= 0.5 || t.pages >= 1.5))
  const testedCalls = tested.reduce((s, t) => s + t.n, 0)
  const weighted = (pick: (t: (typeof tested)[number]) => number) => (testedCalls ? tested.reduce((s, t) => s + pick(t) * t.n, 0) / testedCalls : 0)

  // ── Writes to the table ──
  let addedWriteMs = 0
  for (const [id, b] of Object.entries(before.writes)) {
    const a = since.writes[id] ?? NO_TIMES
    if (b.n < TRIAL_MIN_CALLS || a.n < TRIAL_MIN_CALLS) continue
    const w = welch(b, a)
    if (w && w.pSlower < α && w.meanAfter > w.meanBefore) addedWriteMs += (w.meanAfter - w.meanBefore) * a.n
  }

  const improved = tested.filter((t) => t.w.pFaster < α && t.w.meanAfter <= (1 - IMPROVEMENT) * t.w.meanBefore)
  const savedMs = improved.reduce((s, t) => s + (t.w.meanBefore - t.w.meanAfter) * t.n, 0)
  const numbers: TrialNumbers = {
    readCalls,
    beforeMs: weighted((t) => t.w.meanBefore),
    afterMs: weighted((t) => t.w.meanAfter),
    savedMs,
    addedWriteMs,
    scans: since.scans,
  }

  // 1. A regression is acted on at once, when the index is what changed.
  const slower = tested.find(
    (t) => t.w.pSlower < α && t.w.meanAfter >= LATENCY_RATIO * t.w.meanBefore && t.w.meanAfter - t.w.meanBefore >= LATENCY_MIN_MS,
  )
  if (slower && planChanged) {
    return {
      kind: 'remove',
      why: 'regressed',
      numbers,
      finding:
        `queries filtering ${name} got slower with it: ${ms(slower.w.meanBefore)} before, ` +
        `${ms(slower.w.meanAfter)} since (${plural(slower.n, 'query', 'queries')})`,
    }
  }

  if (elapsed < TRIAL_MIN_MS) return { kind: 'observe', why: 'inside the first 30 minutes' }

  // 2. Never used.
  if (readCalls >= TRIAL_MIN_CALLS && !scanned && !fewerPages) {
    return {
      kind: 'remove',
      why: 'unused',
      numbers,
      finding:
        `PostgreSQL did not use it for any of the ${plural(readCalls, 'query', 'queries')} that filtered ${name} ` +
        `since it was built, and an unused index only slows writes`,
    }
  }

  if (tested.length > 0) {
    // 3. Cost more than it saved.
    if (addedWriteMs > 0 && addedWriteMs > savedMs) {
      return {
        kind: 'remove',
        why: 'net_cost',
        numbers,
        finding: `it saved ${ms(savedMs)} of query time and added ${ms(addedWriteMs)} to writes on ${entry.table}`,
      }
    }
    // 4. Earned its place: faster, and because of the index.
    const improvedCalls = improved.reduce((s, t) => s + t.n, 0)
    if (improvedCalls * 2 >= testedCalls && savedMs > 0 && (scanned || fewerPages)) {
      return {
        kind: 'keep',
        numbers,
        finding:
          `queries filtering ${name} went from ${ms(numbers.beforeMs)} to ${ms(numbers.afterMs)} on average ` +
          `(${plural(testedCalls, 'query', 'queries')} measured)`,
      }
    }
  }

  // 5. Out of time.
  if (deadline) {
    return {
      kind: 'remove',
      why: 'no_improvement',
      numbers,
      finding:
        tested.length === 0
          ? `only ${plural(readCalls, 'query', 'queries')} filtered ${name} in the 72 hours after it was built, too few to show it helps`
          : `queries filtering ${name} were not measurably faster in the 72 hours after it was built ` +
            `(${ms(numbers.beforeMs)} before, ${ms(numbers.afterMs)} since)`,
    }
  }
  return { kind: 'observe', why: tested.length === 0 ? 'not enough queries yet' : 'no verdict yet' }
}

// ── The review pass ─────────────────────────────────────────────────────────

export interface TrialReview {
  reviewed: number
  kept: number
  removed: number
  ended: number
  waiting: number
}

async function writeResult(projectId: string, entry: TrialEntry, outcome: 'kept' | 'removed' | 'remove_failed' | 'ended', sentence: string): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        projectId,
        action: 'INDEX_TRIAL_RESULT',
        type: 'health',
        details: JSON.stringify({
          outcome,
          tableName: entry.table,
          columnName: entry.column,
          indexName: entry.indexName ?? null,
          findingId: entry.findingId ?? null,
          verdict: entry.verdict?.why ?? null,
          numbers: entry.verdict?.numbers ?? null,
          undoChangeId: entry.undoChangeId ?? null,
          // Names and numbers only: safe for a project kept in another region.
          sentence,
        }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})
}

/**
 * Remove a trial's index: DROP INDEX CONCURRENTLY as a governed change of its
 * own, under the build lock every autonomous repair takes, attributed to
 * autonomy.
 */
async function removeIndex(projectId: string, entry: TrialEntry): Promise<{ kind: 'removed'; changeId: string | null } | { kind: 'failed'; error: string }> {
  const { executeAction } = await import('@/lib/ai/minimal-executor')
  const { withBuildLock } = await import('@/lib/ai/build-runtime/build-lock')
  const { withChangeAttribution } = await import('@/lib/changes/attribution')
  const groupId = `index-trial:${entry.table}.${entry.column}:${randomUUID().slice(0, 8)}`
  const locked = await withChangeAttribution({ source: 'autonomy', groupId }, () =>
    withBuildLock(
      projectId,
      'modify',
      () =>
        executeAction(
          { action: 'DROP_INDEX', params: { indexName: entry.indexName, tableName: entry.table, online: true } },
          projectId,
          undefined,
          0,
          undefined,
          false,
        ),
      { skipCooldown: true },
    ),
  )
  if (locked.error) return { kind: 'failed', error: locked.error }
  const r = locked.result!
  if (!r.success) return { kind: 'failed', error: String(r.error ?? r.message) }
  return { kind: 'removed', changeId: ((r as any).change?.id as string | undefined) ?? null }
}

/**
 * Review every open trial of a project: accumulate the calls since the last
 * pass, judge, and keep or remove. Called on each live reconciler pass.
 *
 * A removal waits while an architecture change holds the table
 * (lib/evolution-engine/holds.ts), and, unless the index made queries slower,
 * while the project is mid-incident (lib/autonomy/change-freeze.ts).
 */
export async function reviewIndexTrials(projectId: string, opts: { nowMs?: number; run?: Run } = {}): Promise<TrialReview> {
  const out: TrialReview = { reviewed: 0, kept: 0, removed: 0, ended: 0, waiting: 0 }
  const rows = await prisma.projectPreference.findMany({ where: { projectId, type: LEDGER_TYPE }, select: { value: true } })
  for (const row of rows) {
    const stored = parseEntry(row.value)
    if (!stored || !stored.indexName || (stored.status !== 'observing' && stored.status !== 'undo_failed')) continue
    out.reviewed++
    const nowMs = opts.nowMs ?? Date.now()
    let entry: TrialEntry = stored

    const name = `${entry.table}.${entry.column}`
    let judgement: TrialJudgement
    if (entry.status === 'undo_failed' && entry.verdict && entry.verdict.why !== 'improved' && entry.verdict.why !== 'index_gone' && entry.verdict.why !== 'table_recreated') {
      judgement = { kind: 'remove', why: entry.verdict.why, finding: entry.verdict.finding, numbers: entry.verdict.numbers ?? null }
    } else {
      const reading = await readIndexTrial(projectId, entry.table, entry.column, entry.indexName!, opts.run)
      if (!entry.before && reading.statements === 'ok' && reading.index) {
        // The reading at build time failed: this one is the before side.
        await saveEntry(projectId, { ...entry, before: { reads: reading.reads, writes: reading.writes }, last: reading })
        out.waiting++
        continue
      }
      entry = accumulate(entry, reading)
      judgement = judgeTrial(entry, reading, nowMs)
    }

    if (judgement.kind === 'observe') {
      await saveEntry(projectId, entry)
      out.waiting++
      continue
    }
    const decidedAt = new Date(nowMs).toISOString()
    const until = new Date(nowMs + TRIAL_COOLDOWN_MS).toISOString()
    if (judgement.kind === 'ended') {
      // Someone took Backenly's index away: theirs to put back, not Backenly's.
      const gone = judgement.why === 'index_gone'
      entry = { ...entry, status: 'ended', verdict: { why: judgement.why, finding: judgement.finding, decidedAt }, ...(gone ? { cooldownUntil: until } : {}) }
      await saveEntry(projectId, entry)
      await writeResult(
        projectId,
        entry,
        'ended',
        gone
          ? `The index Backenly built on ${name} was removed before its trial ended. Backenly will not build it again on its own before ${until.slice(0, 10)}.`
          : `Backenly stopped measuring the index it built on ${name}: ${judgement.finding}.`,
      )
      out.ended++
      continue
    }
    if (judgement.kind === 'keep') {
      entry = { ...entry, status: 'kept', verdict: { why: 'improved', finding: judgement.finding, decidedAt, numbers: judgement.numbers } }
      await saveEntry(projectId, entry)
      await writeResult(projectId, entry, 'kept', `Backenly kept the index it built on ${name}: ${judgement.finding}.`)
      out.kept++
      continue
    }

    // Remove, unless something says to wait.
    const { repairHold } = await import('@/lib/evolution-engine/holds')
    const held = await repairHold(projectId, { table: entry.table, action: 'DROP_INDEX' }).catch(() => null)
    let frozen = false
    if (!held && judgement.why !== 'regressed') {
      const { heldForIncident } = await import('./change-freeze')
      frozen = await heldForIncident(projectId, { loop: 'reconciler', via: 'index_trial', wouldHaveApplied: 1 }).catch(() => false)
    }
    const verdict = { why: judgement.why, finding: judgement.finding, decidedAt: entry.verdict?.decidedAt ?? decidedAt, numbers: judgement.numbers }
    if (held || frozen) {
      await saveEntry(projectId, { ...entry, verdict })
      out.waiting++
      continue
    }
    const removed = await removeIndex(projectId, entry)
    if (removed.kind === 'removed') {
      entry = { ...entry, status: 'undone', verdict, undoChangeId: removed.changeId, undoError: undefined, cooldownUntil: until }
      await saveEntry(projectId, entry)
      await writeResult(projectId, entry, 'removed', `Backenly removed the index it built on ${name}: ${judgement.finding}.`)
      out.removed++
    } else {
      entry = { ...entry, status: 'undo_failed', verdict, undoError: removed.error.slice(0, 300), cooldownUntil: until }
      await saveEntry(projectId, entry)
      // Said once, when it first fails; later passes retry quietly.
      if (stored.status !== 'undo_failed') {
        await writeResult(
          projectId,
          entry,
          'remove_failed',
          `Backenly could not remove the index it built on ${name} (${removed.error.slice(0, 200)}) and will try again. ` +
            `It is coming out because ${judgement.finding}.`,
        )
      }
      out.waiting++
    }
  }
  return out
}
