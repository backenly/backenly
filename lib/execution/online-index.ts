/**
 * ONLINE INDEX CHANGES — CREATE and DROP INDEX CONCURRENTLY, bounded
 * =================================================================
 *
 * A plain CREATE INDEX holds a SHARE lock on the table for the whole build:
 * reads go on, every insert, update and delete waits. On a table of millions of
 * rows that is minutes of failed writes, which is not something Backenly may
 * do to a live backend on its own. CREATE INDEX CONCURRENTLY builds alongside
 * the traffic instead: its SHARE UPDATE EXCLUSIVE lock conflicts with no read
 * or write, and while it waits for older transactions nothing queues behind it
 * but maintenance. DROP INDEX CONCURRENTLY is the same for removal: a plain DROP
 * INDEX takes ACCESS EXCLUSIVE, and while it waits for one long query every new
 * query on the table queues behind it.
 *
 * What CONCURRENTLY costs, and what is done about each:
 *
 *   no transaction block   It runs on a connection of its own, never inside a
 *                          caller's transaction. A governed change holds its
 *                          lock as a session advisory lock with no open
 *                          transaction (lib/changes/lock.ts), so the build does
 *                          not wait on the change that runs it.
 *   it waits               For transactions that started before it, at three
 *                          points. lock_timeout bounds each wait at
 *                          ONLINE_LOCK_TIMEOUT_MS and statement_timeout the
 *                          whole build at ONLINE_BUILD_TIMEOUT_MS. Neither wait
 *                          holds up the application's reads or writes.
 *   a failure leaves an    "the CREATE INDEX command will fail but leave behind
 *   invalid index          an invalid index. This index will be ignored for
 *                          querying purposes because it might be incomplete;
 *                          however it will still consume update overhead"
 *                          (PostgreSQL, CREATE INDEX). Every failure here drops
 *                          what it left, CONCURRENTLY too; one that cannot is
 *                          reported, and the next build of the same index drops
 *                          it first (executeCreateIndex).
 *   I/O                    Two passes over the table. One online build at a time
 *                          per database (an advisory lock, as Dexter, the
 *                          Postgres auto-indexer, serializes its builds): a busy
 *                          lock is a wait, never a failure.
 *
 * The statements are put on the record of whatever is capturing
 * (lib/execution/sql-recorder.ts), as if they had gone through Prisma.
 */

import type { PoolClient } from 'pg'
import { noteStatement } from './sql-recorder'

/** 'onix'. Session lock on the build's own connection: one online build per database. */
export const ONLINE_INDEX_LOCK_NAMESPACE = 0x6f6e6978
/** Longest wait for older transactions at any one point. */
export const ONLINE_LOCK_TIMEOUT_MS = 60_000
/** Longest a build may run. Autonomous builds are bounded to tables of 10 GB (lib/authority). */
export const ONLINE_BUILD_TIMEOUT_MS = 30 * 60_000

/** Shorter bounds, for tests. Positive whole numbers of milliseconds. */
export interface OnlineIndexTimeouts {
  lockTimeoutMs?: number
  buildTimeoutMs?: number
}

/**
 * The bounds in force. Each is written into a SET statement, and 0 turns a
 * Postgres timeout off, so anything but a positive whole number of
 * milliseconds is the default.
 */
export function onlineIndexBounds(t?: OnlineIndexTimeouts): Required<OnlineIndexTimeouts> {
  const ms = (v: unknown, fallback: number) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : fallback)
  return {
    lockTimeoutMs: ms(t?.lockTimeoutMs, ONLINE_LOCK_TIMEOUT_MS),
    buildTimeoutMs: ms(t?.buildTimeoutMs, ONLINE_BUILD_TIMEOUT_MS),
  }
}

export type OnlineIndexOutcome =
  | { kind: 'done' }
  | {
      kind: 'failed'
      /** Worth trying again later without a person. */
      transient: boolean
      /** False when nothing was attempted (another build held the lock). */
      started: boolean
      /** An invalid index the failure left that could not be dropped. */
      leftover: boolean
      code: string
      message: string
    }

async function onOwnConnection<T>(projectId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const { acquireWorkspaceClient } = await import('@/lib/services/workspace-pool')
  const client = await acquireWorkspaceClient(projectId)
  try {
    return await fn(client)
  } finally {
    // Destroyed, never returned to the pool: its timeouts and its advisory
    // lock go with it.
    client.release(true)
  }
}

/** Whether the index exists, and whether queries may use it. */
export async function indexValidity(
  q: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ valid: boolean }> }>,
  schema: string,
  indexName: string,
): Promise<{ valid: boolean } | null> {
  const r = await q(
    `SELECT ix.indisvalid AS valid
       FROM pg_class i
       JOIN pg_index ix ON ix.indexrelid = i.oid
       JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = $1 AND i.relname = $2`,
    [schema, indexName],
  )
  return r.rows[0] ? { valid: Boolean(r.rows[0].valid) } : null
}

function failed(
  err: any,
  what: 'build' | 'removal',
  leftover: boolean,
  { lockTimeoutMs, buildTimeoutMs }: Required<OnlineIndexTimeouts>,
): OnlineIndexOutcome {
  const code = String(err?.code ?? '')
  const unchanged = 'The table stayed available throughout.'
  const later = 'Backenly will try again later.'
  const base = { kind: 'failed' as const, started: true, leftover }
  switch (code) {
    case '55P03':
      return {
        ...base,
        transient: true,
        code: 'ONLINE_INDEX_LOCK_TIMEOUT',
        message: `The ${what} stopped because older transactions were still running after ${lockTimeoutMs / 1000} seconds. ${unchanged} ${later}`,
      }
    case '57014':
      return {
        ...base,
        transient: true,
        code: 'ONLINE_INDEX_TIMEOUT',
        message: `The ${what} ran past ${buildTimeoutMs / 60_000} minutes and was stopped. ${unchanged} ${later}`,
      }
    case '40P01':
      return { ...base, transient: true, code: 'ONLINE_INDEX_DEADLOCK', message: `The ${what} was stopped to resolve a deadlock. ${unchanged} ${later}` }
    case '23505':
      return { ...base, transient: false, code: 'DUPLICATE_VALUES', message: `The table holds duplicate values for the index's columns, so a unique index cannot be built: ${err.message}` }
    case '53100':
      return { ...base, transient: false, code: 'DISK_FULL', message: `The database ran out of disk space during the ${what}.` }
    default:
      return { ...base, transient: false, code: 'ONLINE_INDEX_FAILED', message: `The ${what} failed: ${err?.message ?? err}` }
  }
}

/**
 * Run `createSql` (a CREATE [UNIQUE] INDEX CONCURRENTLY statement naming
 * `"schema"."indexName"`'s index) online. Leaves nothing behind on failure, or
 * says so.
 */
export async function buildIndexOnline(
  projectId: string,
  schema: string,
  indexName: string,
  createSql: string,
  timeouts?: OnlineIndexTimeouts,
): Promise<OnlineIndexOutcome> {
  if (!/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(createSql)) {
    throw new Error('buildIndexOnline runs CREATE INDEX CONCURRENTLY only')
  }
  return onOwnConnection(projectId, async (c) => {
    const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::int4, 0) AS ok', [ONLINE_INDEX_LOCK_NAMESPACE])
    if (!lock.rows[0]?.ok) {
      return {
        kind: 'failed',
        transient: true,
        started: false,
        leftover: false,
        code: 'ONLINE_INDEX_BUSY',
        message: 'Another index is being built in this database. Backenly will try again on its next pass.',
      }
    }
    const bounds = onlineIndexBounds(timeouts)
    const q = (sql: string, params: unknown[]) => c.query(sql, params)
    const before = await indexValidity(q, schema, indexName)
    await c.query(`SET lock_timeout = ${bounds.lockTimeoutMs}`)
    await c.query(`SET statement_timeout = ${bounds.buildTimeoutMs}`)
    noteStatement(createSql)
    try {
      await c.query(createSql)
      return { kind: 'done' }
    } catch (err) {
      // What this build left, never an index that was there before it.
      let leftover = false
      if (!before) {
        const after = await indexValidity(q, schema, indexName).catch(() => null)
        if (after && !after.valid) {
          const drop = `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${indexName}"`
          noteStatement(drop)
          await c.query(drop).catch(() => {
            leftover = true
          })
        }
      }
      const out = failed(err, 'build', leftover, bounds)
      if (leftover && out.kind === 'failed') {
        out.message += ` It left an unusable copy of the index, which could not be removed now; the next build of it removes it first.`
      }
      return out
    }
  })
}

/** DROP INDEX CONCURRENTLY IF EXISTS, bounded. */
export async function dropIndexOnline(
  projectId: string,
  schema: string,
  indexName: string,
  timeouts?: OnlineIndexTimeouts,
): Promise<OnlineIndexOutcome> {
  return onOwnConnection(projectId, async (c) => {
    // A build of this index that is still running is left alone, and said so
    // at once instead of after lock_timeout. Postgres fills in index_relid only
    // for sessions of this role (or for pg_read_all_stats), so a build this
    // cannot see, or a view this cannot read, still ends at the lock timeout.
    const inProgress = await c.query<{ in_progress: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_progress_create_index p
           JOIN pg_class c ON c.oid = p.index_relid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2
       ) AS in_progress`,
      [schema, indexName],
    ).catch(() => ({ rows: [{ in_progress: false }] }))

    if (inProgress.rows[0]?.in_progress) {
      return {
        kind: 'failed',
        transient: true,
        started: false,
        leftover: false,
        code: 'ONLINE_INDEX_BUILD_IN_PROGRESS',
        message: `Index "${indexName}" on "${schema}" is already being built. Backenly will try again later.`,
      }
    }

    const bounds = onlineIndexBounds(timeouts)
    await c.query(`SET lock_timeout = ${bounds.lockTimeoutMs}`)
    await c.query(`SET statement_timeout = ${bounds.buildTimeoutMs}`)
    const sql = `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${indexName}"`
    noteStatement(sql)
    try {
      await c.query(sql)
      return { kind: 'done' }
    } catch (err) {
      return failed(err, 'removal', false, bounds)
    }
  })
}
