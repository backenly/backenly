/**
 * Carrying out an import plan (lib/import/pg-plan.ts) into a new project.
 *
 * The steps, each reusable by any driver whose source is Postgres:
 *
 *   createTables   every table through the governed kernel (CREATE_TABLE, as
 *                  written) inside ONE governed change, so History shows the
 *                  import's tables as one entry and a failure part-way puts the
 *                  project back to empty; each table is then closed to all but
 *                  the server key (an explicit admin_only rule, which the
 *                  auto-RLS reconciler never reopens) until a person approves
 *                  the rules that came with it (lib/import/rules.ts);
 *   copyRows       a server-side cursor per table inside the source's one
 *                  read-only snapshot, inserted in batches under the service
 *                  role, with progress after every batch;
 *   addDeferredKeys the foreign keys rows could not satisfy while arriving;
 *   verify         destination counts against the source's.
 *
 * Row data never reaches a log, a job row or a change record: the copy runs on
 * a pool of its own, outside the SQL recorder the change ledger reads.
 */

import { createHmac } from 'crypto'
import type { Pool } from 'pg'
import type { ImportPlan, PlannedTable } from './pg-plan'
import type { SourceReader } from './net'
import { waitForHeadroom, yieldToServer } from './pressure'
import { SourceWireError } from './source-guard'

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

/** Thrown when the person cancels or the job runs out of time; the job says which. */
export class ImportAborted extends Error {
  constructor(readonly reason: 'canceled' | 'timeout' | 'stopped' = 'canceled') {
    super(reason === 'timeout' ? 'The import ran out of time.' : 'The import was canceled.')
    this.name = 'ImportAborted'
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const reason = signal.reason
  throw reason instanceof ImportAborted ? reason : new ImportAborted('canceled')
}

/**
 * The uuid a row keyed by `value` in `table` receives, the same for the row
 * itself and for every row pointing at it (see pg-plan.ts). Keyed with a
 * secret held for this import only, so the ids are not guessable from the old
 * keys. Version-4 shaped.
 */
export function derivedUuid(secret: Buffer, table: string, value: string): string {
  const h = createHmac('sha256', secret).update(table).update('\u0000').update(value).digest()
  h[6] = (h[6] & 0x0f) | 0x40
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** The executor's CREATE_TABLE parameters for one planned table. */
export function createTableParams(t: PlannedTable): Record<string, unknown> {
  return {
    tableName: t.name,
    asWritten: true,
    // Nothing the source did not have: no blueprint columns, no buckets by name.
    noAutoProvision: true,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.sqlType ? { sqlType: c.sqlType } : {}),
      ...(c.notNull ? { notNull: true } : {}),
      ...(c.unique ? { unique: true } : {}),
      ...(c.default !== undefined ? { default: c.default } : {}),
      ...(c.references ? { references: c.references } : {}),
    })),
  }
}

export interface CreateTablesContext {
  /** The History entry's title: "Move in from Supabase: 12 tables". */
  title: string
  signal: AbortSignal
  onTableCreated?: (name: string) => void
  /** More schema work for the same change (the end users table). */
  extra?: () => Promise<void>
}

/**
 * Create every planned table, closed to all but the server key, as one
 * governed change. Throws (and the ledger puts the project back) when any
 * table cannot be created as planned.
 */
export async function createTables(projectId: string, plan: ImportPlan, ctx: CreateTablesContext): Promise<void> {
  const { withGovernedChange } = await import('@/lib/changes/ledger')
  const { executeAction } = await import('@/lib/ai/minimal-executor')
  await withGovernedChange({ projectId, title: ctx.title }, async () => {
    for (const t of plan.tables) {
      throwIfAborted(ctx.signal)
      const made = await executeAction({ action: 'CREATE_TABLE', params: createTableParams(t) } as any, projectId, undefined, 0, undefined, false)
      if (!made.success) throw new Error(`Backenly could not create ${t.name}: ${firstLine(made.message ?? made.error)}`)
      // Closed by a rule someone chose (not "closed by default"), so nothing opens it before a person does.
      const closed = await executeAction(
        { action: 'SET_PERMISSION', params: { tableName: t.name, template: 'admin_only', confirmed: true } } as any,
        projectId,
        undefined,
        0,
        undefined,
        false,
      )
      if (!closed.success) throw new Error(`Backenly could not close ${t.name} to all but the server key: ${firstLine(closed.message ?? closed.error)}`)
      ctx.onTableCreated?.(t.name)
    }
    if (ctx.extra) await ctx.extra()
  })
}

function firstLine(text: unknown): string {
  return String(text ?? 'no reason given').split('\n')[0].replace(/^[\s\u2705\u26D4\u26A0\uFE0F]+/, '').slice(0, 300)
}

// ── Rows ──────────────────────────────────────────────────────────────────────

/** Rows per FETCH and per INSERT; fewer for a wide table, to stay under PostgreSQL's 65,535 parameters. */
export function batchSizeFor(columnCount: number): number {
  return Math.max(1, Math.min(1000, Math.floor(60_000 / Math.max(1, columnCount))))
}

/**
 * About how much one batch of rows may hold in this process's memory. A FETCH
 * is bounded by rows, never by bytes, so the batch size follows the rows'
 * measured size: a table of wide JSON or binary values is read a few rows at
 * a time (lib/import/pressure.ts says why memory is scarce here). This is the
 * aim; the ceiling is lib/import/source-guard.ts, which ends the connection
 * when one row, or one batch, is larger than the source made it look.
 */
export const BATCH_TARGET_BYTES = 8 * 1024 * 1024

/** The first batch: sized from the source's own average row (pg_table_size / rows), or a cautious few. */
export function initialBatchSize(t: Pick<PlannedTable, 'rows' | 'bytes' | 'copy'>): number {
  const max = batchSizeFor(t.copy.length)
  if (!(t.rows > 0) || !(t.bytes > 0)) return Math.min(max, 50)
  const average = t.bytes / t.rows
  return clampBatch(Math.floor(BATCH_TARGET_BYTES / Math.max(1, average)), max)
}

/**
 * The next batch, from what the last one measured: as many rows as fit the
 * target at the measured average, growing at most twofold per batch.
 */
export function nextBatchSize(current: number, rows: number, bytes: number, columnCount: number): number {
  const max = batchSizeFor(columnCount)
  if (rows <= 0) return clampBatch(current, max)
  const average = Math.max(1, bytes / rows)
  const fits = Math.floor(BATCH_TARGET_BYTES / average)
  return clampBatch(Math.min(fits, current * 2), max)
}

function clampBatch(n: number, max: number): number {
  return Math.max(1, Math.min(max, Number.isFinite(n) ? n : 1))
}

/** About how many bytes a fetched batch holds: text and binary by length, JSON by its text, the rest as 8. */
export function approxBytes(rows: readonly unknown[][]): number {
  let total = 0
  for (const row of rows) for (const value of row) total += valueBytes(value)
  return total
}

function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length
  if (Buffer.isBuffer(value)) return value.length
  if (typeof value === 'object' && !(value instanceof Date)) {
    try {
      return JSON.stringify(value)?.length ?? 8
    } catch {
      return 8
    }
  }
  return 8
}

export interface CopyContext {
  signal: AbortSignal
  /** The secret derivedUuid keys with, held for this import only. */
  secret: Buffer
  /** Called after every batch with the table's running total. */
  onRows: (table: string, copied: number) => void
}

/** One source row → the destination values, in `t.copy` order. Exported for the tests. */
export function rowValues(t: PlannedTable, row: unknown[], secret: Buffer): unknown[] {
  return t.copy.map((target) => {
    const v = row[target.from]
    if (v === null || v === undefined) return null
    const text = typeof v === 'string' ? v : String(v)
    return target.derive ? derivedUuid(secret, target.derive.table, text) : text
  })
}

async function insertBatch(pool: Pool, schema: string, t: PlannedTable, rows: unknown[][]): Promise<number> {
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  const cols = t.copy.map((c) => q(c.column)).join(', ')
  const width = t.copy.length
  const tuples: string[] = []
  const params: unknown[] = []
  for (const r of rows) {
    const ph: string[] = []
    for (let i = 0; i < width; i++) {
      params.push(r[i])
      ph.push(`$${params.length}`)
    }
    tuples.push(`(${ph.join(', ')})`)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // A source time with no zone (timestamp without time zone) landing in a
    // timestamptz column is read as UTC, as the source printed it, never in
    // whatever zone this database server happens to run in.
    await client.query(`SET LOCAL TIME ZONE 'UTC'`)
    // The table is closed to everyone but the service role (createTables); the copy is the service role.
    await client.query(rlsSessionSql(), rlsSessionParams({ isServiceRole: true }))
    const res = await client.query(`INSERT INTO ${q(schema)}.${q(t.name)} (${cols}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params)
    await client.query('COMMIT')
    return res.rowCount ?? 0
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** A database error about the DESTINATION, in Backenly's words: never a row's value. */
export function destinationError(table: string, err: unknown): Error {
  const e = err as { code?: string; message?: string } | null
  const code = e?.code ?? ''
  const what: Record<string, string> = {
    '23505': 'two rows had the same value where it must be unique',
    '23503': 'a row pointed at a row that is not there',
    '23502': 'a required value was missing',
    '22P02': "a value did not fit its column's type",
    '22001': 'a value was longer than its column allows',
    '22003': "a number did not fit its column's type",
    '22007': 'a date or time could not be read',
    '22008': 'a date or time was out of range',
    '42703': 'a column was missing',
    '42P01': 'the table was missing',
    '57014': 'it took too long',
  }
  const reason = what[code] ?? (code ? `PostgreSQL error ${code}` : 'the write failed')
  return new Error(`Copying rows into ${table} failed: ${reason}.`)
}

/**
 * Copy every table's rows, parents first. `source` is the snapshot every
 * table is read from; the destination is the project's own database, in its
 * region. Returns the rows each table received.
 */
export async function copyRows(
  source: SourceReader,
  projectId: string,
  plan: ImportPlan,
  ctx: CopyContext,
): Promise<Map<string, number>> {
  const { projectPool } = await import('@/lib/data-plane/regional')
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const pool = await projectPool(projectId, 'import', { max: 4 })
  const schema = workspaceSchemaName(projectId)
  const copied = new Map<string, number>()

  for (const [i, t] of plan.tables.entries()) {
    throwIfAborted(ctx.signal)
    let n = 0
    copied.set(t.name, 0)
    ctx.onRows(t.name, 0)
    if (t.copy.length === 0) continue
    const cursor = `bkn_import_${i}`
    let batch = initialBatchSize(t)
    await source.query(
      `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${t.select.join(', ')} FROM ${q(t.sourceSchema)}.${q(t.sourceName)}`,
    )
    try {
      for (;;) {
        throwIfAborted(ctx.signal)
        await waitForHeadroom(ctx.signal)
        const rows = await source.queryArrays(`FETCH FORWARD ${batch} FROM ${cursor}`).then(
          (r) => r.rows,
          (err) => {
            throw err instanceof SourceWireError ? new SourceWireError(`Reading ${t.sourceName}: ${err.message}`) : err
          },
        )
        if (rows.length === 0) break
        const values = rows.map((r) => rowValues(t, r, ctx.secret))
        try {
          await insertBatch(pool, schema, t, values)
        } catch (err) {
          throw destinationError(t.name, err)
        }
        n += rows.length
        copied.set(t.name, n)
        ctx.onRows(t.name, n)
        batch = nextBatchSize(batch, rows.length, approxBytes(rows), t.copy.length)
        await yieldToServer()
      }
    } finally {
      await source.query(`CLOSE ${cursor}`).catch(() => {})
    }
  }
  return copied
}

// ── Keys added after the rows ────────────────────────────────────────────────

/**
 * Add the keys that rows could not satisfy while arriving. Run inside the
 * import's closing governed change. A key that cannot be added (an orphan row
 * in the source, a skipped user) is said, not fatal.
 */
export async function addDeferredKeys(projectId: string, plan: ImportPlan, signal: AbortSignal): Promise<string[]> {
  const { executeAction } = await import('@/lib/ai/minimal-executor')
  const warnings: string[] = []
  for (const t of plan.tables) {
    for (const fk of t.deferredForeignKeys) {
      throwIfAborted(signal)
      const r = await executeAction(
        {
          action: 'ADD_CONSTRAINT',
          params: { tableName: t.name, columnName: fk.column, constraintType: 'foreign_key', references: fk.references, confirmed: true },
        } as any,
        projectId,
        undefined,
        0,
        undefined,
        false,
      )
      if (!r.success) {
        warnings.push(`The foreign key ${t.name}.${fk.column} → ${fk.references.table} was not added: some rows point at rows that did not move.`)
      }
    }
  }
  return warnings
}

// ── Verification ──────────────────────────────────────────────────────────────

/** Rows each destination table holds now. Read as the service role: the tables are closed. */
export async function destinationCounts(projectId: string, tables: string[]): Promise<Map<string, number>> {
  const { projectPool } = await import('@/lib/data-plane/regional')
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  const pool = await projectPool(projectId, 'import', { max: 4 })
  const schema = workspaceSchemaName(projectId)
  const out = new Map<string, number>()
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(rlsSessionSql(), rlsSessionParams({ isServiceRole: true }))
    for (const name of tables) {
      const r = await client.query(`SELECT count(*)::bigint::text AS n FROM ${q(schema)}.${q(name)}`)
      out.set(name, Number(r.rows[0]?.n ?? 0))
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return out
}

/** Exact counts of the source tables, inside the same snapshot the rows came from. */
export async function sourceCounts(source: SourceReader, plan: ImportPlan): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const t of plan.tables) {
    const r = await source.query<{ n: string }>(`SELECT count(*)::bigint::text AS n FROM ${q(t.sourceSchema)}.${q(t.sourceName)}`)
    out.set(t.name, Number(r.rows[0]?.n ?? 0))
  }
  return out
}
