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
import { buildIndexOnline, ONLINE_INDEX_LOCK_NAMESPACE } from '@/lib/execution/online-index'

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
})
