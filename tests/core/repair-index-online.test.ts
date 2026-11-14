/**
 * BACKENLY'S OWN INDEX REPAIRS ARE BUILT ONLINE
 * --------------------------------------------
 * Against a real PostgreSQL, because every claim here is about what PostgreSQL
 * does: which lock a build takes, and what a failed CREATE INDEX CONCURRENTLY
 * leaves behind (lib/execution/online-index.ts).
 *
 *   • a repair index is built CONCURRENTLY: a write to the table goes through
 *     while the build waits, where a plain CREATE INDEX queues it
 *   • a failed online build leaves no invalid index behind
 *   • an invalid copy left by an earlier build is replaced, never reported as
 *     "already exists"
 *   • one online build per database at a time; a busy lock is a wait
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { executeAction, type AIAction } from '@/lib/ai/minimal-executor'
import { buildFixAction } from '@/lib/core/fix-actions'
import {
  buildIndexOnline,
  dropIndexOnline,
  onlineIndexBounds,
  ONLINE_BUILD_TIMEOUT_MS,
  ONLINE_INDEX_LOCK_NAMESPACE,
  ONLINE_LOCK_TIMEOUT_MS,
} from '@/lib/execution/online-index'
import { withSqlCapture } from '@/lib/execution/sql-recorder'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

let userId: string
let projectId: string
let schema: string
const clients: Client[] = []

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  clients.push(c)
  return c
}

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

async function index(name: string): Promise<{ valid: boolean } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ valid: boolean }>>(
    `SELECT ix.indisvalid AS valid FROM pg_class i JOIN pg_index ix ON ix.indexrelid = i.oid
       JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = $1 AND i.relname = $2`,
    schema,
    name,
  )
  return rows[0] ?? null
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A CREATE INDEX statement waiting on a lock, in another session. */
const buildWaiting = (watcher: Client) => async () =>
  (
    await watcher.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE query ILIKE 'CREATE%INDEX%' AND query LIKE $1 AND wait_event_type = 'Lock'`,
      [`%"${schema}"%`],
    )
  ).rows[0].n > 0

const run = (action: { action: string; params: Record<string, unknown> }) =>
  executeAction({ action: action.action as AIAction['action'], params: action.params }, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `repair-index-online-${Date.now()}@example.test`, password: 'x', name: 'repair index online' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'repair-index-online-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."orders" (
    id serial PRIMARY KEY, ref_a text, ref_b text, ref_c text, kind text, dup text
  )`)
  // kind: 'common' on 99% of rows. A query for it is answered by reading the
  // table whatever indexes exist.
  await raw(`INSERT INTO "${schema}"."orders"(ref_a, ref_b, ref_c, kind, dup)
    SELECT md5(i::text), 'b' || (i % 40000), 'c' || (i % 50000),
           CASE WHEN i % 100 = 0 THEN 'rare' ELSE 'common' END, 'd' || (i % 10)
      FROM generate_series(1, 200000) i`)
  await raw(`ANALYZE "${schema}"."orders"`)
  // Registered as a table Backenly built is, so the executor finds it.
  await prisma.table.create({ data: { projectId, name: 'orders', schema, description: 'fixture' } })
}, 180_000)

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.projectPreference.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('a repair index is built online', () => {
  test('a write to the table goes through while the build waits', async () => {
    const action = buildFixAction('slow_query_missing_index', { tableName: 'orders', columnName: 'ref_a' })!
    // An open transaction that wrote to the table: every index build has to
    // wait for it, which holds the build at its lock for as long as it is open.
    const blocker = await connect()
    await blocker.query('BEGIN')
    await blocker.query(`INSERT INTO "${schema}"."orders"(ref_a) VALUES ('blocker')`)

    const watcher = await connect()
    const building = run(action)
    await waitFor(buildWaiting(watcher), 'the build to wait on the open transaction')

    // A plain CREATE INDEX asks for SHARE, and this insert queues behind that
    // request. CONCURRENTLY asks for SHARE UPDATE EXCLUSIVE, which no write
    // conflicts with.
    const writer = await connect()
    await writer.query(`SET lock_timeout = '200ms'`)
    await expect(writer.query(`INSERT INTO "${schema}"."orders"(ref_a) VALUES ('during the build')`)).resolves.toBeTruthy()

    await blocker.query('COMMIT')
    const res = await building
    expect(res.success).toBe(true)
    expect(await index('idx_orders_ref_a')).toEqual({ valid: true })
  }, 60_000)

  test('a failed online build leaves no invalid index behind', async () => {
    const res = await run({
      action: 'CREATE_INDEX',
      params: { tableName: 'orders', columns: ['dup'], unique: true, online: true, indexName: 'uniq_orders_dup' },
    })
    expect(res.success).toBe(false)
    expect(res.message).toContain('duplicate values')
    expect(await index('uniq_orders_dup')).toBeNull()
  }, 60_000)

  test('an invalid copy left by an earlier build is replaced, never taken for the index', async () => {
    // Leave one: a concurrent build that gives up waiting for a writer has
    // already put an invalid index in the catalog.
    const blocker = await connect()
    await blocker.query('BEGIN')
    await blocker.query(`INSERT INTO "${schema}"."orders"(ref_b) VALUES ('blocker')`)
    const other = await connect()
    await other.query(`SET lock_timeout = '300ms'`)
    await expect(other.query(`CREATE INDEX CONCURRENTLY "idx_orders_ref_b" ON "${schema}"."orders" ("ref_b")`)).rejects.toThrow()
    await blocker.query('COMMIT')
    expect(await index('idx_orders_ref_b')).toEqual({ valid: false })

    const plain = await run({ action: 'CREATE_INDEX', params: { tableName: 'orders', columnName: 'ref_b' } })
    expect(plain.success).toBe(false)
    expect((plain as any).code).toBe('INDEX_INVALID')

    const online = await run(buildFixAction('slow_query_missing_index', { tableName: 'orders', columnName: 'ref_b' })!)
    expect(online.success).toBe(true)
    expect(await index('idx_orders_ref_b')).toEqual({ valid: true })
  }, 60_000)

  test('one online build per database: a busy lock is a wait, not a failure', async () => {
    const holder = await connect()
    await holder.query('SELECT pg_advisory_lock($1::int4, 0)', [ONLINE_INDEX_LOCK_NAMESPACE])
    const out = await buildIndexOnline(projectId, schema, 'idx_orders_kind_busy', `CREATE INDEX CONCURRENTLY "idx_orders_kind_busy" ON "${schema}"."orders" ("kind")`)
    await holder.query('SELECT pg_advisory_unlock($1::int4, 0)', [ONLINE_INDEX_LOCK_NAMESPACE])
    expect(out.kind).toBe('failed')
    expect(out.kind === 'failed' && out.code).toBe('ONLINE_INDEX_BUSY')
    expect(out.kind === 'failed' && out.started).toBe(false)
    expect(out.kind === 'failed' && out.transient).toBe(true)
    expect(await index('idx_orders_kind_busy')).toBeNull()
  }, 30_000)

  test('the indisready = true unique case: invalid unique index enforces uniqueness and is replaced cleanly', async () => {
    // 1. Builder starts CREATE UNIQUE INDEX CONCURRENTLY on orders(ref_a)
    const builder = await connect()
    const buildPromise = builder.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "uniq_orders_case" ON "${schema}"."orders" ("ref_a")`,
    )

    // 2. Wait until Phase 1 commits (index catalog entry appears in pg_class)
    await waitFor(async () => {
      const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        schema,
        'uniq_orders_case',
      )
      return (r[0]?.n ?? 0) > 0
    }, 'Phase 1 catalog entry to appear')

    // 3. Blocker holds an open snapshot AFTER Phase 1 committed.
    // Phase 1 does not wait on blocker, but Phase 4 will wait on it!
    const blocker = await connect()
    await blocker.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await blocker.query('SELECT 1')

    // 4. Wait until Phase 3 commits (indisready = true)
    await waitFor(async () => {
      const r = await prisma.$queryRawUnsafe<Array<{ ready: boolean }>>(
        `SELECT ix.indisready AS ready
           FROM pg_class i
           JOIN pg_index ix ON ix.indexrelid = i.oid
           JOIN pg_namespace n ON n.oid = i.relnamespace
          WHERE n.nspname = $1 AND i.relname = $2`,
        schema,
        'uniq_orders_case',
      )
      return r[0]?.ready === true
    }, 'Phase 3 indisready = true')

    // 5. Cancel the build while it is waiting in Phase 4 for blocker. The
    // build's error can arrive before the cancel returns, so it is awaited
    // from before the cancel; otherwise Jest sees an unhandled rejection.
    const buildCancelled = expect(buildPromise).rejects.toThrow(/canceling statement/)
    await raw(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE query LIKE '%"uniq_orders_case"%' AND pid <> pg_backend_pid()`,
    )
    await buildCancelled
    await blocker.query('COMMIT')

    // 6. Confirm Postgres left the index in the catalog with indisvalid = false AND indisready = true
    const rows = await prisma.$queryRawUnsafe<Array<{ valid: boolean; ready: boolean }>>(
      `SELECT ix.indisvalid AS valid, ix.indisready AS ready
         FROM pg_class i
         JOIN pg_index ix ON ix.indexrelid = i.oid
         JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE n.nspname = $1 AND i.relname = $2`,
      schema,
      'uniq_orders_case',
    )
    expect(rows[0]).toEqual({ valid: false, ready: true })

    // 7. In Postgres 16, an invalid index with indisready = true enforces uniqueness against writes!
    const dupWriter = await connect()
    await expect(
      dupWriter.query(`INSERT INTO "${schema}"."orders"(ref_a) VALUES ('dup_a_val'), ('dup_a_val')`),
    ).rejects.toThrow(/duplicate key|unique constraint/i)

    // 8. Rebuild online replaces the invalid unique index with a valid one
    const res = await run({
      action: 'CREATE_INDEX',
      params: { tableName: 'orders', columns: ['ref_a'], unique: true, online: true, indexName: 'uniq_orders_case' },
    })
    expect(res.success).toBe(true)
    expect(await index('uniq_orders_case')).toEqual({ valid: true })

    // Clean up
    await raw(`DROP INDEX IF EXISTS "${schema}"."uniq_orders_case"`)
  }, 60_000)

  test("a build that's still running doesn't get dropped", async () => {
    // Blocker holds an open transaction that wrote to orders
    const blocker = await connect()
    await blocker.query('BEGIN')
    await blocker.query(`INSERT INTO "${schema}"."orders"(ref_a) VALUES ('in_prog_blocker')`)

    // Builder starts CREATE INDEX CONCURRENTLY; it will pause waiting for blocker
    const builder = await connect()
    const buildPromise = builder.query(
      `CREATE INDEX CONCURRENTLY "idx_orders_in_prog" ON "${schema}"."orders" ("ref_a")`,
    )

    // Wait until it appears in pg_stat_progress_create_index
    await waitFor(async () => {
      const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n
           FROM pg_stat_progress_create_index p
           JOIN pg_class c ON c.oid = p.index_relid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        schema,
        'idx_orders_in_prog',
      )
      return (r[0]?.n ?? 0) > 0
    }, 'build to appear in pg_stat_progress_create_index')

    // dropIndexOnline must immediately return transient "already being built" without waiting
    const start = Date.now()
    const out = await dropIndexOnline(projectId, schema, 'idx_orders_in_prog')
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(out.kind).toBe('failed')
    expect(out.transient).toBe(true)
    expect(out.code).toBe('ONLINE_INDEX_BUILD_IN_PROGRESS')
    expect(out.message).toContain('already being built')

    // Finish blocker so builder completes cleanly
    await blocker.query('COMMIT')
    await buildPromise
    expect(await index('idx_orders_in_prog')).toEqual({ valid: true })
  }, 60_000)

  test('a timeout behind an open writer comes back as leftover', async () => {
    // An open transaction that wrote to orders
    const writer = await connect()
    await writer.query('BEGIN')
    await writer.query(`INSERT INTO "${schema}"."orders"(ref_a) VALUES ('leftover_writer')`)

    // buildIndexOnline with short timeouts: the build times out waiting for the writer,
    // and the cleanup DROP INDEX CONCURRENTLY also times out waiting for the same writer!
    const out = await buildIndexOnline(
      projectId,
      schema,
      'idx_orders_leftover',
      `CREATE INDEX CONCURRENTLY "idx_orders_leftover" ON "${schema}"."orders" ("ref_a")`,
      { lockTimeoutMs: 150, buildTimeoutMs: 300 },
    )

    await writer.query('COMMIT')

    expect(out.kind).toBe('failed')
    expect(out.kind === 'failed' && out.leftover).toBe(true)
    expect(out.kind === 'failed' && out.message).toContain('left an unusable copy of the index')

    // Clean up the leftover invalid index
    await raw(`DROP INDEX IF EXISTS "${schema}"."idx_orders_leftover"`)
  }, 60_000)

  test('both statements show up in withSqlCapture', async () => {
    // Leave an invalid index first
    const blocker = await connect()
    await blocker.query('BEGIN')
    await blocker.query(`INSERT INTO "${schema}"."orders"(ref_a) VALUES ('cap_blocker')`)
    const other = await connect()
    await other.query(`SET lock_timeout = '200ms'`)
    await other.query(`SET statement_timeout = '400ms'`)
    await expect(
      other.query(`CREATE INDEX CONCURRENTLY "idx_orders_captured" ON "${schema}"."orders" ("ref_a")`),
    ).rejects.toThrow()
    await blocker.query('COMMIT')
    expect(await index('idx_orders_captured')).toEqual({ valid: false })

    // Rebuild online under withSqlCapture: both DROP and CREATE must be captured
    const { statements } = await withSqlCapture(async () => {
      return await run({
        action: 'CREATE_INDEX',
        params: { tableName: 'orders', columnName: 'ref_a', indexName: 'idx_orders_captured', online: true },
      })
    })

    const drops = statements.filter((s) => s.sql.includes('DROP INDEX CONCURRENTLY'))
    const creates = statements.filter((s) => s.sql.includes('CREATE INDEX CONCURRENTLY'))
    expect(drops.length).toBeGreaterThanOrEqual(1)
    expect(creates.length).toBeGreaterThanOrEqual(1)
    expect(drops[0].sql).toContain('idx_orders_captured')
    expect(creates[0].sql).toContain('idx_orders_captured')
  }, 60_000)

  test('a timeout that is not a positive whole number of milliseconds is the default', () => {
    const defaults = { lockTimeoutMs: ONLINE_LOCK_TIMEOUT_MS, buildTimeoutMs: ONLINE_BUILD_TIMEOUT_MS }
    expect(onlineIndexBounds()).toEqual(defaults)
    // 0 would turn the Postgres timeout off.
    expect(onlineIndexBounds({ lockTimeoutMs: 0, buildTimeoutMs: -1 })).toEqual(defaults)
    expect(onlineIndexBounds({ lockTimeoutMs: 1.5, buildTimeoutMs: Number.NaN })).toEqual(defaults)
    // Each value is written into a SET statement.
    expect(onlineIndexBounds({ lockTimeoutMs: '1; SELECT 1' as unknown as number })).toEqual(defaults)
    expect(onlineIndexBounds({ lockTimeoutMs: 150, buildTimeoutMs: 300 })).toEqual({ lockTimeoutMs: 150, buildTimeoutMs: 300 })
  })
})
