/**
 * AN INDEX BACKENLY BUILDS BECAUSE QUERIES MEASURED SLOW IS JUDGED ON THEM
 * -----------------------------------------------------------------------
 * Against a real PostgreSQL with pg_stat_statements (the autonomy job loads
 * it), because the verdict rests on what PostgreSQL measured: the statements'
 * times and pages before and after the build, and whether the planner used the
 * index (lib/autonomy/index-trials.ts).
 *
 *   • a trial keeps an index that made its queries faster, and says so
 *   • it removes, online, one PostgreSQL never used, and leaves building it
 *     again to a person for 30 days
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { executeAction, type AIAction } from '@/lib/ai/minimal-executor'
import { buildFixAction } from '@/lib/core/fix-actions'
import { indexAttempts, loadIndexTrial, readIndexTrial, reviewIndexTrials, startIndexTrial } from '@/lib/autonomy/index-trials'

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

const run = (action: { action: string; params: Record<string, unknown> }) =>
  executeAction({ action: action.action as AIAction['action'], params: action.params }, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `index-trials-${Date.now()}@example.test`, password: 'x', name: 'index trials' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'index-trials-test', userId } })
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

describe('an index built because queries measured slow is judged on those queries', () => {
  const query = async (c: Client, column: string, values: string[]) => {
    for (const v of values) await c.query(`SELECT id FROM "${schema}"."orders" WHERE "${column}" = $1`, [v])
  }
  const later = () => Date.now() + 31 * 60_000

  async function buildAndOpen(column: string): Promise<string> {
    const res = await run(buildFixAction('slow_query_missing_index', { tableName: 'orders', columnName: column })!)
    expect(res.success).toBe(true)
    const indexName = `idx_orders_${column}`
    const reading = await readIndexTrial(projectId, 'orders', column, indexName)
    expect(reading.statements).toBe('ok')
    expect(Object.keys(reading.reads).length).toBeGreaterThan(0)
    await startIndexTrial({ projectId, table: 'orders', column, indexName, findingId: null, changeIds: [], reading })
    return indexName
  }

  test('keeps an index that made its queries faster, and says so in the activity feed', async () => {
    const c = await connect()
    const values = Array.from({ length: 25 }, (_, i) => `c${i * 7}`)
    await query(c, 'ref_c', values)
    await buildAndOpen('ref_c')
    await query(c, 'ref_c', values)

    const review = await reviewIndexTrials(projectId, { nowMs: later() })
    expect(review.kept).toBe(1)
    const entry = await loadIndexTrial(projectId, 'orders', 'ref_c')
    expect(entry?.status).toBe('kept')
    expect(entry?.verdict?.why).toBe('improved')
    expect(await index('idx_orders_ref_c')).toEqual({ valid: true })

    const row = await prisma.auditLog.findFirst({ where: { projectId, action: 'INDEX_TRIAL_RESULT' }, orderBy: { timestamp: 'desc' } })
    expect(JSON.parse(String(row?.details)).sentence).toMatch(/^Backenly kept the index it built on orders\.ref_c: queries filtering orders\.ref_c went from /)
  }, 120_000)

  test('removes, online, an index PostgreSQL never used, and leaves the next one to a person', async () => {
    const c = await connect()
    // 99% of the rows match: reading the table is cheaper than the index.
    const values = Array.from({ length: 25 }, () => 'common')
    await query(c, 'kind', values)
    await buildAndOpen('kind')
    await query(c, 'kind', values)

    const review = await reviewIndexTrials(projectId, { nowMs: later() })
    expect(review.removed).toBe(1)
    expect(await index('idx_orders_kind')).toBeNull()
    const entry = await loadIndexTrial(projectId, 'orders', 'kind')
    expect(entry?.status).toBe('undone')
    expect(entry?.verdict?.why).toBe('unused')

    const row = await prisma.auditLog.findFirst({ where: { projectId, action: 'INDEX_TRIAL_RESULT' }, orderBy: { timestamp: 'desc' } })
    expect(JSON.parse(String(row?.details)).sentence).toBe(
      'Backenly removed the index it built on orders.kind: PostgreSQL did not use it for any of the 25 queries ' +
        'that filtered orders.kind since it was built, and an unused index only slows writes.',
    )

    const attempts = await indexAttempts(projectId, 'orders', 'kind')
    expect(attempts.removed?.by).toBe('backenly')
    expect(Date.parse(attempts.removed!.until) - Date.now()).toBeGreaterThan(29 * 86_400_000)
  }, 120_000)
})
