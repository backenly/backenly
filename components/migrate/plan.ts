/**
 * What a move carries, and where each part of it stands at a moment.
 *
 * `MovePlan` is the shape the importer's report already has
 * (lib/import/supabase-importer.ts: tables with source and copied rows, auth
 * users, policies), plus files. `progressAt(plan, t)` turns a plan into the
 * state of every row at `t` seconds, as a pure function, so the console can
 * play a real move from the importer's events and the landing page can loop
 * the same picture from a clock, and both render through one ledger.
 *
 * Rows copy in batches of 500, the importer's BATCH_SIZE, so a counter steps
 * the way the real one does instead of spinning through every integer.
 */

import type { SourceId } from './sources'

export interface MoveTable {
  name: string
  rows: number
}

export interface MovePlan {
  source: SourceId
  /** The project's name where it is now, which it keeps on Backenly. */
  project: string
  /** Where it is now, in the source's own words: its region, or its project id. */
  sourceWhere: string
  /** The source's account or organization, which names the Backenly organization. */
  sourceOrg: string
  /** The Backenly region it moves into. */
  region: string
  /** What the source calls a table: Firestore has collections. */
  tableWord: { one: string; many: string }
  tables: MoveTable[]
  users?: number
  files?: { count: number; bytes: number; buckets: number }
  /** Access rules, rewritten for Backenly and held until a person approves them. */
  rules?: { count: number; word: string; short: string }
  /** What stays behind, said plainly. */
  staysBehind?: { count: number; word: string }
  /** The size of the whole move, for the estimate. */
  minutes: number
}

export const COURTSIDE_SUPABASE: MovePlan = {
  source: 'supabase',
  project: 'courtside',
  sourceWhere: 'East US (North Virginia)',
  sourceOrg: 'Courtside Labs',
  region: 'N. Virginia (us-east-1)',
  tableWord: { one: 'table', many: 'tables' },
  tables: [
    { name: 'bookings', rows: 48210 },
    { name: 'payments', rows: 39977 },
    { name: 'profiles', rows: 12904 },
    { name: 'coach_sessions', rows: 9654 },
    { name: 'reviews', rows: 6318 },
    { name: 'waitlist', rows: 1142 },
    { name: 'courts', rows: 86 },
    { name: 'coaches', rows: 41 },
    { name: 'clubs', rows: 12 },
  ],
  users: 12904,
  files: { count: 13467, bytes: 2.1e9, buckets: 2 },
  rules: { count: 18, word: 'row-level security policies', short: 'policies' },
  staysBehind: { count: 3, word: 'Edge Functions' },
  minutes: 4,
}

export const COURTSIDE_FIREBASE: MovePlan = {
  source: 'firebase',
  project: 'courtside',
  sourceWhere: 'courtside-7f3c2',
  sourceOrg: 'Courtside Labs',
  region: 'N. Virginia (us-east-1)',
  tableWord: { one: 'collection', many: 'collections' },
  tables: [
    { name: 'bookings', rows: 48210 },
    { name: 'payments', rows: 39977 },
    { name: 'members', rows: 12904 },
    { name: 'sessions', rows: 9654 },
    { name: 'reviews', rows: 6318 },
    { name: 'waitlist', rows: 1142 },
    { name: 'courts', rows: 86 },
    { name: 'coaches', rows: 41 },
  ],
  users: 12904,
  files: { count: 13467, bytes: 2.1e9, buckets: 1 },
  rules: { count: 14, word: 'Security Rules', short: 'rules' },
  staysBehind: { count: 4, word: 'Cloud Functions' },
  minutes: 5,
}

export const COURTSIDE_POSTGRES: MovePlan = {
  source: 'postgres',
  project: 'courtside',
  sourceWhere: 'Neon, US East (Ohio)',
  sourceOrg: 'Courtside Labs',
  region: 'N. Virginia (us-east-1)',
  tableWord: { one: 'table', many: 'tables' },
  tables: [
    { name: 'bookings', rows: 48210 },
    { name: 'payments', rows: 39977 },
    { name: 'members', rows: 12904 },
    { name: 'coach_sessions', rows: 9654 },
    { name: 'reviews', rows: 6318 },
    { name: 'waitlist', rows: 1142 },
    { name: 'courts', rows: 86 },
    { name: 'coaches', rows: 41 },
    { name: 'clubs', rows: 12 },
  ],
  rules: { count: 6, word: 'row-level security policies', short: 'policies' },
  minutes: 2,
}

export const DEMO_PLANS: Record<SourceId, MovePlan> = {
  supabase: COURTSIDE_SUPABASE,
  firebase: COURTSIDE_FIREBASE,
  postgres: COURTSIDE_POSTGRES,
}

/* ── Progress ──────────────────────────────────────────────────────────── */

export type RowPhase = 'waiting' | 'copying' | 'checking' | 'matched'

export interface RowProgress {
  phase: RowPhase
  done: number
  total: number
}

export interface MoveProgress {
  /** Reading the source before anything is created. */
  reading: boolean
  tables: RowProgress[]
  users?: RowProgress
  files?: RowProgress & { bytesDone: number; bytesTotal: number }
  rules?: { phase: 'waiting' | 'rewriting' | 'review'; count: number }
  matchedTables: number
  /** 0..1, weighted by the units that move. */
  fraction: number
  finished: boolean
}

const BATCH = 500
const LANES = 3

interface Span {
  start: number
  end: number
  check: number
}

interface Schedule {
  read: number
  tables: Span[]
  users?: Span
  files?: Span
  rulesStart: number
  rulesEnd: number
  total: number
}

/** When each part of a plan runs, in seconds at speed 1. Three tables copy at a time. */
export function scheduleOf(plan: MovePlan): Schedule {
  const read = 1.1
  const check = 0.55
  const lanes = Array.from({ length: LANES }, () => read)
  // Copy time grows with a table's rows (a little less than linearly, as
  // batches overlap), so a 12-row table is done in a blink and the largest
  // takes about four and a half seconds.
  const largest = Math.max(1, ...plan.tables.map((t) => t.rows))
  const tables = plan.tables.map((t) => {
    const lane = lanes.indexOf(Math.min(...lanes))
    const start = lanes[lane]
    const end = start + 0.4 + 4.2 * Math.pow(t.rows / largest, 0.8)
    lanes[lane] = end + check + 0.12
    return { start, end, check: end + check }
  })
  const tablesDone = Math.max(...tables.map((s) => s.check))
  const users = plan.users ? { start: read + 0.35, end: read + 4.2, check: read + 4.2 + check } : undefined
  const filesEnd = Math.max(tablesDone - 0.4, (users?.check ?? 0) + 0.6)
  const files = plan.files ? { start: read + 0.5, end: filesEnd, check: filesEnd + check } : undefined
  const rulesStart = tablesDone + 0.1
  const rulesEnd = rulesStart + (plan.rules ? 0.9 : 0)
  const total = Math.max(rulesEnd, files?.check ?? 0, users?.check ?? 0, tablesDone) + 0.2
  return { read, tables, users, files, rulesStart, rulesEnd, total }
}

function rowAt(span: Span, total: number, t: number, step = BATCH): RowProgress {
  if (t < span.start) return { phase: 'waiting', done: 0, total }
  if (t < span.end) {
    const p = (t - span.start) / (span.end - span.start)
    return { phase: 'copying', done: Math.min(total, Math.floor((p * total) / step) * step), total }
  }
  if (t < span.check) return { phase: 'checking', done: total, total }
  return { phase: 'matched', done: total, total }
}

/** The state of every row `t` seconds into the move. */
export function progressAt(plan: MovePlan, t: number): MoveProgress {
  const s = scheduleOf(plan)
  const tables = plan.tables.map((table, i) => rowAt(s.tables[i], table.rows, t))
  const users = plan.users && s.users ? rowAt(s.users, plan.users, t) : undefined
  const fileRow = plan.files && s.files ? rowAt(s.files, plan.files.count, t, 50) : undefined
  const files =
    plan.files && fileRow
      ? {
          ...fileRow,
          bytesTotal: plan.files.bytes,
          bytesDone: fileRow.total ? (fileRow.done / fileRow.total) * plan.files.bytes : 0,
        }
      : undefined
  const rules = plan.rules
    ? {
        phase: (t < s.rulesStart ? 'waiting' : t < s.rulesEnd ? 'rewriting' : 'review') as 'waiting' | 'rewriting' | 'review',
        count: plan.rules.count,
      }
    : undefined

  const units = [...tables, ...(users ? [users] : []), ...(files ? [files] : [])]
  const fraction = units.reduce((a, r) => a + r.done, 0) / Math.max(1, units.reduce((a, r) => a + r.total, 0))

  return {
    reading: t < s.read,
    tables,
    users,
    files,
    rules,
    matchedTables: tables.filter((r) => r.phase === 'matched').length,
    fraction,
    finished: t >= s.total,
  }
}

export function durationOf(plan: MovePlan): number {
  return scheduleOf(plan).total
}

/* ── Words and numbers ─────────────────────────────────────────────────── */

const NUM = new Intl.NumberFormat('en-US')
export const n = (v: number) => NUM.format(Math.round(v))

export function bytes(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`
  if (v >= 1e6) return `${Math.round(v / 1e6)} MB`
  return `${Math.round(v / 1e3)} KB`
}

export function rowsTotal(plan: MovePlan): number {
  return plan.tables.reduce((a, t) => a + t.rows, 0)
}

export function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`
}
