/**
 * A HOT TABLE'S INDEX WAITS FOR A PERSON
 * --------------------------------------
 * `infra_hot_table` was rated auto and sat on the legacy autonomy bridge
 * (LEGACY_AUTONOMY_COMPAT_TYPES), so the loop built its index on its own, with
 * none of create_index's bounds: no table-size or storage limit, no hold after
 * a removal, no trial judged on the queries. Its evidence is how often a table
 * is scanned, which does not show that its queries are slow, and no sensor
 * stands behind it, so it cannot meet the authority decision either.
 *
 * It is approved now, by a person, and built online as before. A query
 * measured as slow is still indexed on Backenly's own authority, bounded and
 * judged (slow_query_missing_index → create_index).
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { classifyFix } from '@/lib/core/fix-classifier'
import { authorityPathFor } from '@/lib/authority/action-classes'
import { executeApprovedFix, processOpenFindings } from '@/lib/core/auto-fix-engine'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let planId: string
let projectId: string
let schema: string
let findingId: string

const details = () => ({
  title: 'Hot table: orders',
  source: 'infra_intelligence',
  table: 'orders',
  tableName: 'orders',
  columnName: 'customer_ref',
  seqScans: 4200,
  idxHitPct: 3,
  fix: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_ref ON "${schema}"."orders" ("customer_ref");`,
})

async function indexed(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
      FROM pg_index i
      JOIN pg_class c     ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND a.attname = '${column}'`)
  return rows[0].n > 0
}

const audits = (action: string) => prisma.auditLog.count({ where: { projectId, action } })

beforeAll(async () => {
  userId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `hot-index+${userId.slice(0, 8)}@backenly.test`, name: 'hot index', password: 'not-a-real-hash' },
  })
  // The most permissive setting a plan allows, so only the rating holds it back.
  planId = (await prisma.plan.create({
    data: {
      name: `HOT_INDEX_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })).id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })
  projectId = randomUUID()
  schema = `workspace_${projectId}`
  await prisma.project.create({ data: { id: projectId, name: 'hot-index', userId, autonomyLevel: 'AGGRESSIVE' } as any })
  await q(`CREATE SCHEMA "${schema}"`)
  await q(`CREATE TABLE "${schema}"."orders" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_ref text)`)
  await q(`INSERT INTO "${schema}"."orders" (customer_ref) SELECT 'c' || i FROM generate_series(1, 1000) i`)
  // Analyzed, as autovacuum leaves a live table: building an index refreshes the
  // row estimate, and a never-analyzed table would read as changed by the fix.
  await q(`ANALYZE "${schema}"."orders"`)
  await prisma.table.create({ data: { projectId, name: 'orders', schema } as any })
  findingId = (await prisma.healthFinding.create({
    data: { projectId, type: 'infra_hot_table_orders', severity: 'warning', status: 'open', autoFixed: false, details: details() as any },
  })).id
}, 120_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.plan.deleteMany({ where: { id: planId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe("a hot table's index", () => {
  it('has no autonomous route: it is rated for approval and is not on the legacy bridge', () => {
    expect(classifyFix('infra_hot_table_orders', details()).decision).toBe('approval')
    expect(authorityPathFor('infra_hot_table')).toBe('freeze')
    // Without a column there is still nothing to run, only advice.
    expect(classifyFix('infra_hot_table_orders', { tableName: 'orders' }).decision).toBe('notify_only')
  })

  it('is put in front of a person by the loop, and nothing is built', async () => {
    const results = await processOpenFindings(projectId)
    const mine = results.find((r) => r.findingId === findingId)
    expect(mine?.outcome).toBe('pending_approval')
    expect(mine?.message).toBe(classifyFix('infra_hot_table_orders', details()).reason)
    expect((await prisma.healthFinding.findUniqueOrThrow({ where: { id: findingId } })).status).toBe('pending_approval')
    expect(await indexed('orders', 'customer_ref')).toBe(false)
    expect(await audits('AUTHORITY_LEGACY_COMPATIBILITY')).toBe(0)
    expect(await audits('HEALTH_AUTO_FIXED')).toBe(0)
  }, 120_000)

  it("is built once a person approves it", async () => {
    const applied = await executeApprovedFix(findingId, projectId)
    expect(applied.success).toBe(true)
    expect(await indexed('orders', 'customer_ref')).toBe(true)
  }, 120_000)
})
