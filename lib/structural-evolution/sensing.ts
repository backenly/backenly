/**
 * SENSING — the measured half of the evidence
 * ===========================================
 *
 * `concerns.ts` decides; this reads what it decides on. Four sources, each with
 * a bounded cost and each able to say "I could not look" rather than "I found
 * nothing":
 *
 *   rows       a capped, deterministic sample of which candidate columns are
 *              set on which rows, read as the platform (row-level security
 *              would otherwise hide every row and report a perfectly sparse,
 *              perfectly wrong table)
 *   history    workspace schema snapshots: when each column first appeared,
 *              and every later change to it
 *   repairs    health findings located on a column of the table
 *   traffic    requests the data plane served for the table, from the
 *              request log the rest of autonomy already reads
 *
 * ── Why the sample is REPEATABLE ────────────────────────────────────────────
 *
 * A proposal that appears on one read and vanishes on the next is worse than no
 * proposal: the owner cannot tell a changing backend from a noisy instrument.
 * `TABLESAMPLE ... REPEATABLE` returns the same sample for the same table
 * contents, so the evidence moves when the data moves and not otherwise. Small
 * tables are read in full, in key order, for the same reason.
 *
 * Nothing here is part of a plan's identity. Consent binds to the SQL a ladder
 * will run, which is derived from the catalog alone; sampled numbers explain a
 * proposal and are never hashed into one.
 *
 * Read-only.
 */

import { prisma } from '@/lib/db'
import type { TableFacts } from './facts'
import {
  creationColumn,
  timestampColumns,
  type ColumnHistory,
  type ConcernChangeEvent,
  type Consumer,
  type PresenceSample,
  type RepairRecord,
} from './concerns'

/** Rows read per table. Enough to measure co-presence; never a scan of a big table. */
export const SAMPLE_ROWS = 5_000
/** Columns sampled per table. A wider table is measured on its first N candidates. */
export const MAX_SAMPLED_COLUMNS = 64
/** Snapshots read for history. The most recent ones. */
export const MAX_SNAPSHOTS = 500

const q = (name: string) => `"${name.replace(/"/g, '""')}"`

// ── Rows ─────────────────────────────────────────────────────────────────────

export type SampleResult = { sample: PresenceSample } | { unavailable: string }

export async function samplePresence(facts: TableFacts, columns: string[]): Promise<SampleResult> {
  const cols = columns.slice(0, MAX_SAMPLED_COLUMNS)
  if (cols.length < 2) return { unavailable: 'fewer than two candidate columns to compare' }

  const created = creationColumn(facts)
  const stamps = created ? timestampColumns(facts, cols) : []
  const bits = cols.map(c => `CASE WHEN ${q(c)} IS NULL THEN '0' ELSE '1' END`).join(' || ')
  const lagSql = stamps.map(
    (s, i) => `, EXTRACT(EPOCH FROM (${q(s)}::timestamptz - ${q(created!)}::timestamptz))::float8 AS lag_${i}`,
  )
  const from = `${q(facts.schema)}.${q(facts.table)}`
  const live = facts.stats?.liveRows ?? 0
  const pk = facts.primaryKey.length === 1 ? q(facts.primaryKey[0]) : null

  // Large tables are sampled; small ones are read in full, in key order. Both
  // are deterministic for unchanged contents — see the module header.
  const sampled = live > SAMPLE_ROWS * 4
  const pct = sampled ? Math.min(100, Math.max(0.01, (100 * SAMPLE_ROWS * 2) / live)) : 100
  const sql =
    `SELECT (${bits}) AS bits${lagSql.join('')} FROM ${from}` +
    (sampled ? ` TABLESAMPLE BERNOULLI (${pct.toFixed(4)}) REPEATABLE (42)` : pk ? ` ORDER BY ${pk}` : '') +
    ` LIMIT ${SAMPLE_ROWS}`

  try {
    const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
    const rows = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '15s'`)
      // As the platform: every workspace table is FORCE ROW LEVEL SECURITY, and
      // a sample read as nobody would see no rows and call every column absent.
      await tx.$executeRawUnsafe(
        rlsSessionSql(1),
        ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(sql)
    })
    const lags: Record<string, number[]> = {}
    stamps.forEach((s, i) => {
      lags[s] = rows
        .map(r => r[`lag_${i}`])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    })
    return {
      sample: {
        columns: cols,
        rows: rows.map(r => String(r.bits ?? '')),
        lags,
        creationColumn: created,
        method: sampled ? 'sample' : 'full',
      },
    }
  } catch (err) {
    return { unavailable: `rows could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── History ──────────────────────────────────────────────────────────────────

interface SnapshotColumn { name: string; type?: string; nullable?: boolean; default?: string | null }
interface SnapshotTable { name: string; columns?: SnapshotColumn[] }
export interface SnapshotRow { versionNum: number; createdAt: Date; tables: unknown }

/** Read the snapshot series once per analysis; every table's history comes from it. */
export async function readSnapshots(projectId: string): Promise<SnapshotRow[] | { unavailable: string }> {
  try {
    const rows = await prisma.workspaceSchemaSnapshot.findMany({
      where: { projectId },
      orderBy: { versionNum: 'desc' },
      take: MAX_SNAPSHOTS,
      select: { versionNum: true, createdAt: true, tables: true },
    })
    return rows.reverse()
  } catch (err) {
    return { unavailable: `schema history could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * One table's column births and changes, from the snapshot series. Pure.
 *
 * A column present in the first snapshot that shows the table was born with
 * it — unless that is also the first snapshot of the whole series, in which
 * case the table predates history and its first columns' birth is UNKNOWN,
 * not "original". That difference is what keeps `cohort` from claiming a
 * column was bolted on when it may have been there from day one.
 */
export function columnHistory(
  snapshots: SnapshotRow[] | { unavailable: string },
  table: string,
): ColumnHistory {
  if (!Array.isArray(snapshots)) {
    return { available: false, reason: snapshots.unavailable, hostBirthVersion: null, births: {}, events: [] }
  }
  const series = snapshots
    .map(s => ({
      version: s.versionNum,
      at: new Date(s.createdAt).toISOString(),
      table: (Array.isArray(s.tables) ? (s.tables as SnapshotTable[]) : []).find(t => t?.name === table),
    }))
    .filter(s => s.table && Array.isArray(s.table.columns))

  if (snapshots.length < 2 || series.length === 0) {
    return {
      available: false,
      reason:
        snapshots.length < 2
          ? 'fewer than two schema snapshots exist, so no change can be dated'
          : `${table} does not appear in the schema history`,
      hostBirthVersion: null,
      births: {},
      events: [],
    }
  }

  const predates = series[0].version === snapshots[0].versionNum
  const hostBirthVersion = predates ? null : series[0].version
  const births: ColumnHistory['births'] = {}
  for (const c of series[0].table!.columns!) {
    births[c.name] = predates ? { version: null, at: null } : { version: series[0].version, at: series[0].at }
  }

  const events: ConcernChangeEvent[] = []
  for (let i = 1; i < series.length; i++) {
    const prev = new Map(series[i - 1].table!.columns!.map(c => [c.name, c]))
    const added: string[] = []
    const altered: string[] = []
    for (const c of series[i].table!.columns!) {
      const before = prev.get(c.name)
      if (!before) {
        added.push(c.name)
        if (!births[c.name]) births[c.name] = { version: series[i].version, at: series[i].at }
      } else if (before.type !== c.type || before.nullable !== c.nullable || (before.default ?? null) !== (c.default ?? null)) {
        altered.push(c.name)
      }
    }
    if (added.length + altered.length > 0) {
      events.push({
        version: series[i].version,
        at: series[i].at,
        columns: [...added, ...altered],
        kinds: [...(added.length ? ['added' as const] : []), ...(altered.length ? ['altered' as const] : [])],
      })
    }
  }

  return { available: true, hostBirthVersion, births, events }
}

// ── Repairs ──────────────────────────────────────────────────────────────────

/**
 * The table and column a finding is located on.
 *
 * Same reading of `details` as subsystem-recurrence.ts's `findingTable`, plus
 * the column. Restated rather than imported: that module pulls the reconciler's
 * import graph in with it, and this one is read on every dashboard visit.
 */
export function findingLocation(details: unknown): { table: string; column: string | null } | null {
  const d = (details ?? {}) as Record<string, unknown>
  const direct = (d.tableName ?? d.table) as unknown
  const col = (d.columnName ?? d.column) as unknown
  if (typeof direct === 'string' && direct) {
    return { table: direct, column: typeof col === 'string' && col ? col : null }
  }
  const loc = d.location
  if (typeof loc === 'string' && loc && !loc.includes('/') && !loc.includes(':')) {
    const [table, column] = loc.split('.')
    return { table, column: column ?? null }
  }
  return null
}

export async function readRepairs(projectId: string, since: Date): Promise<Array<RepairRecord & { table: string }>> {
  const rows = await prisma.healthFinding
    .findMany({
      where: { projectId, detectedAt: { gte: since } },
      select: { id: true, type: true, details: true, detectedAt: true },
      take: 2_000,
    })
    .catch(() => [] as Array<{ id: string; type: string; details: unknown; detectedAt: Date }>)
  const out: Array<RepairRecord & { table: string }> = []
  for (const r of rows) {
    const at = findingLocation(r.details)
    if (!at?.column) continue
    out.push({ findingId: r.id, type: r.type, table: at.table, column: at.column, at: r.detectedAt.toISOString() })
  }
  return out
}

// ── Traffic ──────────────────────────────────────────────────────────────────

/**
 * Requests served per table in the window, or null when the log is unreadable.
 *
 * Production traffic only (`branchId IS NULL`), the same population every
 * other autonomy signal reads, so a load test against a preview branch never
 * makes `orders` look hot.
 */
export async function readRequestsByTable(projectId: string, since: Date): Promise<Map<string, number> | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ t: string; n: bigint }>>(
      `SELECT substring(path FROM '^/db/([A-Za-z0-9_]+)') AS t, count(*)::bigint AS n
         FROM api_request_logs
        WHERE "projectId" = $1 AND "branchId" IS NULL AND "timestamp" >= $2 AND path LIKE '/db/%'
        GROUP BY 1`,
      projectId,
      since,
    )
    const m = new Map<string, number>()
    for (const r of rows) if (r.t) m.set(r.t, Number(r.n))
    return m
  } catch {
    return null
  }
}

// ── Consumers ────────────────────────────────────────────────────────────────

const word = (name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)

export interface ProjectConsumers {
  functions: Array<{ id: string; name: string; code: string }>
  triggers: Array<{ id: string; name: string; sourceTable: string; targetTable: string | null; body: string }>
}

export async function readProjectConsumers(projectId: string): Promise<ProjectConsumers> {
  const [functions, triggers] = await Promise.all([
    prisma.aiFunction
      .findMany({ where: { projectId, status: 'active' }, select: { id: true, name: true, generatedCode: true } })
      .catch(() => [] as Array<{ id: string; name: string; generatedCode: string }>),
    prisma.appTrigger
      .findMany({
        where: { projectId, enabled: true },
        select: { id: true, name: true, sourceTable: true, targetTable: true, conditions: true, fieldMappings: true, staticFields: true },
      })
      .catch(() => [] as Array<Record<string, any>>),
  ])
  return {
    functions: functions.map(f => ({ id: f.id, name: f.name, code: f.generatedCode ?? '' })),
    triggers: (triggers as Array<Record<string, any>>).map(t => ({
      id: String(t.id),
      name: String(t.name),
      sourceTable: String(t.sourceTable),
      targetTable: t.targetTable ? String(t.targetTable) : null,
      body: JSON.stringify([t.conditions ?? null, t.fieldMappings ?? null, t.staticFields ?? null]),
    })),
  }
}

/**
 * Who reads or writes these columns, among the consumers Backenly can see.
 *
 * A function is matched on column names alone — it may reach `orders` through a
 * client call that never names the table. That over-reports a function that
 * happens to use the same word, which is the safe direction for a list whose
 * purpose is "what a person must check before dropping a column".
 */
export function consumersOf(all: ProjectConsumers, table: string, columns: string[]): Consumer[] {
  const out: Consumer[] = []
  for (const f of all.functions) {
    const hit = columns.filter(c => word(c).test(f.code))
    if (hit.length > 0) out.push({ kind: 'ai_function', id: f.id, name: f.name, columns: hit })
  }
  for (const t of all.triggers) {
    if (t.sourceTable !== table && t.targetTable !== table) continue
    const hit = columns.filter(c => word(c).test(t.body))
    if (hit.length > 0) out.push({ kind: 'app_trigger', id: t.id, name: t.name, columns: hit })
  }
  return out
}
