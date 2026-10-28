/**
 * The observer repairs nothing. The repair loop is the one writer.
 *
 * Found in staging qualification: a minute after an agent added a reference
 * column, the observer's settled pass created the column's index inline. The
 * repair loop had frozen changes for an incident that same minute, but the
 * observer's path asked only the flag and the dial, so the index went in
 * anyway, outside the change ledger. Restoring the agent's change was then
 * refused, because the table had changed since and no change said how.
 *
 * Asserted against a real schema and the real loop: the observer leaves the
 * schema as it found it and the finding open, and the loop then makes the
 * repair as a governed change on that same finding.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { runObserverForProject } from '@/lib/services/workspace-observer'
import { runReconcilerLive } from '@/lib/autonomy/reconciler'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let planId: string
let schema: string

// jest.setup.js runs every suite in integration mode, where the change ledger
// records nothing. This one is about what the ledger records, so it runs the
// executor as the product does, as the ledger's own suites do.
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `observer-loop+${userId.slice(0, 8)}@backenly.test`,
      name: 'observer leaves repairs to the loop',
      password: 'not-a-real-hash',
    },
  })
  // What seed-billing gives every tier: 1-minute cadence, AGGRESSIVE ceiling,
  // no per-window cap. The dial allows the repair, so nothing but the
  // observer's own rule keeps it from making it.
  const plan = await prisma.plan.create({
    data: {
      name: `OBSERVER_LOOP_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })
  planId = plan.id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })
  await prisma.project.create({
    data: { id: projectId, name: 'observer-loop', userId, autonomyLevel: 'AGGRESSIVE' } as any,
  })

  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await q(`CREATE TABLE "${schema}"."line_items" (id uuid PRIMARY KEY, order_id uuid)`)
  await prisma.table.create({ data: { projectId, name: 'line_items', schema, description: 'fixture' } })
}, 180_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  // The change ledger's rows go only with their project.
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.plan.deleteMany({ where: { id: planId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

async function orderIdIndexed(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = '${schema}' AND c.relname = 'line_items' AND a.attname = 'order_id'
  `)
  return rows[0].n > 0
}

const orderIdFinding = async () =>
  (
    await prisma.healthFinding.findMany({
      where: { projectId, type: 'missing_fk_index' },
      select: { id: true, status: true, details: true },
    })
  ).filter((f) => (f.details as any)?.tableName === 'line_items' && (f.details as any)?.columnName === 'order_id')

describe('the observer leaves every repair to the repair loop', () => {
  it('records the gap and changes nothing, even with the dial allowing the repair', async () => {
    await runObserverForProject(projectId)

    const found = await orderIdFinding()
    expect(found).toHaveLength(1)
    expect(found[0].status).toBe('open')
    // Nothing held the repair back, so there is no refusal to report.
    expect((found[0].details as any).notAppliedBecause).toBeUndefined()

    expect(await orderIdIndexed()).toBe(false)
    const rls = await prisma.$queryRawUnsafe<Array<{ on: boolean }>>(
      `SELECT relrowsecurity AS on FROM pg_class WHERE oid = '"${schema}".line_items'::regclass`,
    )
    expect(rls[0].on).toBe(false)

    // No inline repair ran, so the compatibility bridge was never used and no
    // change was made.
    expect(await prisma.auditLog.count({ where: { projectId, action: 'AUTHORITY_LEGACY_COMPATIBILITY' } })).toBe(0)
    expect(await prisma.backendChange.count({ where: { projectId } })).toBe(0)
  }, 180_000)

  it('the loop then makes the repair as a governed change on that finding', async () => {
    const res = await runReconcilerLive(projectId)
    expect(res).not.toBeNull()
    expect(res!.frozen).toBe(false)

    expect(await orderIdIndexed()).toBe(true)

    // The observer's open row is the one the loop acted on, not a second one.
    const found = await orderIdFinding()
    expect(found).toHaveLength(1)
    expect(found[0].status).toBe('auto_fixed')

    // A fix runs as governed changes grouped under its finding (runAutoFix).
    const changes = await prisma.backendChange.findMany({
      where: { projectId, groupId: { startsWith: `fix:${found[0].id}:` } },
      select: { source: true, kind: true },
    })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((c) => c.source === 'autonomy' && c.kind === 'change')).toBe(true)

    // And the loop's own record of it, re-checked against the catalog.
    const fixed = (await prisma.auditLog.findMany({ where: { projectId, action: 'HEALTH_AUTO_FIXED' }, select: { details: true } }))
      .map((r) => JSON.parse(String(r.details)))
      .filter((d) => d.findingId === found[0].id)
    expect(fixed).toHaveLength(1)
    expect(fixed[0]).toMatchObject({ tableName: 'line_items', columnName: 'order_id', verification: 'confirmed' })
  }, 300_000)
})
