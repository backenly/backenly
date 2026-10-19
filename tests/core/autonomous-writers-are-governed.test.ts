/**
 * Every autonomous repair goes through the governed kernel, held during an
 * incident, and nothing else changes a schema on its own.
 *
 * Asserted against a real database. Only the health signal is replaced, so a
 * project can be put mid-incident on demand; every query and every catalog
 * read is real.
 *
 *   the freeze           one check, recorded the same way for every path
 *   the repair loop      holds its repairs during an incident
 *   the post-build pass  reports drift and re-adds nothing
 *   coevolution          files an index signal for the owner and creates none
 *   the observer         heals no function the dial or a freeze holds back,
 *                        and leaves a finding the loop escalated with a person
 */

const mockAnomalous = new Set<string>()
jest.mock('@/lib/autonomy/telemetry', () => {
  const actual = jest.requireActual('@/lib/autonomy/telemetry')
  return {
    ...actual,
    computeHealthSignal: jest.fn(async (projectId: string) =>
      mockAnomalous.has(projectId)
        ? { state: 'anomalous', reasons: ['Response time spiked to 480ms (p95).'] }
        : { state: 'healthy', reasons: [] }),
  }
})
const mockHeal = jest.fn(async () => ({ scanned: 1, restored: 1, regenerated: 0, failed: 0 }))
jest.mock('@/lib/services/ai-functions/executor', () => {
  const actual = jest.requireActual('@/lib/services/ai-functions/executor')
  return { ...actual, healErroredAiFunctions: (...args: unknown[]) => (mockHeal as any)(...args) }
})

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { heldForIncident } from '@/lib/autonomy/change-freeze'
import { runReconcilerLive } from '@/lib/autonomy/reconciler'
import { reportSchemaDrift } from '@/lib/ai/build-runtime/post-build-orchestrator'
import { runAndStoreFrontendCoevolution } from '@/lib/ai/frontend-coevolution'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { captureSchemaSnapshot } from '@/lib/services/workspace-schema-snapshot'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let planId: string
const projects: string[] = []

async function project(name: string): Promise<{ projectId: string; schema: string }> {
  const projectId = randomUUID()
  const schema = `workspace_${projectId}`
  await prisma.project.create({ data: { id: projectId, name, userId, autonomyLevel: 'AGGRESSIVE' } as any })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  projects.push(projectId)
  return { projectId, schema }
}

async function indexed(schema: string, table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND a.attname = '${column}'
  `)
  return rows[0].n > 0
}

async function columns(schema: string, table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    schema,
    table,
  )
  return rows.map((r) => r.column_name)
}

const freezes = async (projectId: string) =>
  (await prisma.auditLog.findMany({ where: { projectId, action: 'AUTONOMY_CHANGE_FREEZE' }, select: { details: true } }))
    .map((r) => JSON.parse(String(r.details)))

beforeAll(async () => {
  userId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `writers+${userId.slice(0, 8)}@backenly.test`, name: 'governed writers', password: 'not-a-real-hash' },
  })
  const plan = await prisma.plan.create({
    data: { name: `WRITERS_${userId.slice(0, 8)}`, priceCents: 0, autonomyScanIntervalMin: 1, autonomyMaxLevel: 'AGGRESSIVE', autonomyMaxActionsPerWindow: null } as any,
  })
  planId = plan.id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })
}, 120_000)

afterAll(async () => {
  for (const projectId of projects) {
    await q(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.platformNotification.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.plan.deleteMany({ where: { id: planId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe('the change freeze', () => {
  it('holds a mid-incident project, and records which path it held', async () => {
    const { projectId } = await project('freeze')
    expect(await heldForIncident(projectId, { loop: 'maintenance', via: 'function_heal', wouldHaveApplied: 2 })).toBe(false)
    expect(await freezes(projectId)).toEqual([])

    mockAnomalous.add(projectId)
    expect(await heldForIncident(projectId, { loop: 'maintenance', via: 'function_heal', wouldHaveApplied: 2 })).toBe(true)
    expect(await freezes(projectId)).toEqual([
      expect.objectContaining({ loop: 'maintenance', via: 'function_heal', wouldHaveApplied: 2, health: ['Response time spiked to 480ms (p95).'] }),
    ])
  })

  it('holds the repair loop, which repairs nothing while it lasts', async () => {
    const { projectId, schema } = await project('loop-frozen')
    await q(`CREATE TABLE "${schema}"."line_items" (id uuid PRIMARY KEY, order_id uuid)`)
    await prisma.table.create({ data: { projectId, name: 'line_items', schema, description: 'fixture' } })
    mockAnomalous.add(projectId)

    const res = await runReconcilerLive(projectId)
    expect(res?.frozen).toBe(true)
    expect(await indexed(schema, 'line_items', 'order_id')).toBe(false)
    expect((await freezes(projectId)).map((d) => d.loop)).toEqual(['reconciler'])
  }, 180_000)
})

describe('the post-build pass', () => {
  it('reports a column gone since the snapshot, and does not put it back', async () => {
    const { projectId, schema } = await project('post-build')
    await q(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY, body text, author_note text)`)
    await prisma.table.create({ data: { projectId, name: 'notes', schema, description: 'fixture' } })
    expect(await captureSchemaSnapshot(projectId, 'post_migration')).not.toBeNull()
    // Removed after the snapshot, as a direct drop or an unrecorded change would.
    await q(`ALTER TABLE "${schema}"."notes" DROP COLUMN author_note`)

    await reportSchemaDrift(projectId)
    expect(await columns(schema, 'notes')).toEqual(['body', 'id'])
  }, 120_000)
})

describe('coevolution', () => {
  it('files a filtered column for the owner and creates no index', async () => {
    const { projectId, schema } = await project('coevolution')
    await q(`CREATE TABLE "${schema}"."listings" (id uuid PRIMARY KEY, customer_ref text)`)
    await prisma.table.create({ data: { projectId, name: 'listings', schema, description: 'fixture' } })
    // Twelve API calls that all filter listings by customer_ref: the signal for an index.
    await prisma.auditLog.createMany({
      data: Array.from({ length: 12 }, () => ({
        projectId,
        action: 'v1:GET:/db/listings',
        type: 'api_call',
        details: JSON.stringify({ table: 'listings', queryParams: { customer_ref: 'c1' }, status: 200, rowCount: 1 }),
        timestamp: new Date(),
      })),
    })

    await runAndStoreFrontendCoevolution(projectId, userId)
    expect(await indexed(schema, 'listings', 'customer_ref')).toBe(false)
    const filed = await prisma.healthFinding.findFirst({ where: { projectId, type: 'coevo_missing_index_listings' }, select: { details: true } })
    expect(filed).not.toBeNull()
    expect((filed!.details as any).requiresApproval).toBe(true)
  }, 120_000)
})

describe('the observer', () => {
  async function erroredFunction(projectId: string) {
    await prisma.aiFunction.create({
      data: { projectId, name: 'nightly-sync', description: 'fixture', generatedCode: 'export default async function () {}', triggerType: 'manual', status: 'error', lastError: 'TypeError: boom' },
    })
  }

  it('heals no function while the dial is Off or the project is mid-incident', async () => {
    const { projectId, schema } = await project('function-heal')
    await q(`CREATE TABLE "${schema}"."todos" (id uuid PRIMARY KEY, title text)`)
    await prisma.table.create({ data: { projectId, name: 'todos', schema, description: 'fixture' } })
    await erroredFunction(projectId)

    await prisma.project.update({ where: { id: projectId }, data: { autonomyLevel: 'OFF' } as any })
    mockHeal.mockClear()
    await runObserverForProject(projectId)
    expect(mockHeal).not.toHaveBeenCalled()

    await prisma.project.update({ where: { id: projectId }, data: { autonomyLevel: 'AGGRESSIVE' } as any })
    mockAnomalous.add(projectId)
    await runObserverForProject(projectId)
    expect(mockHeal).not.toHaveBeenCalled()
    expect((await freezes(projectId)).map((d) => d.via)).toContain('function_heal')

    mockAnomalous.delete(projectId)
    await runObserverForProject(projectId)
    expect(mockHeal).toHaveBeenCalledTimes(1)
  }, 180_000)

  it('leaves a finding the repair loop escalated with a person, and keeps one row per gap', async () => {
    const { projectId, schema } = await project('escalated')
    await q(`CREATE TABLE "${schema}"."line_items" (id uuid PRIMARY KEY, order_id uuid)`)
    await q(`CREATE TABLE "${schema}"."shipments" (id uuid PRIMARY KEY, order_id uuid)`)
    for (const name of ['line_items', 'shipments']) await prisma.table.create({ data: { projectId, name, schema, description: 'fixture' } })
    // What ensureFinding leaves when a repair did not hold: waiting for a person, with why.
    const escalated = await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'missing_fk_index',
        severity: 'warning',
        status: 'pending_approval',
        autoFixed: false,
        details: { tableName: 'line_items', columnName: 'order_id', recurrence: { recurrenceCount: 3, note: 'fix did not hold' } } as any,
      },
    })

    await runObserverForProject(projectId)

    const after = await prisma.healthFinding.findUnique({ where: { id: escalated.id } })
    expect(after?.status).toBe('pending_approval')
    expect((after?.details as any).recurrence).toEqual({ recurrenceCount: 3, note: 'fix did not hold' })
    // The other table's gap is a row of its own, not written over the escalated one.
    const rows = await prisma.healthFinding.findMany({ where: { projectId, type: 'missing_fk_index' }, select: { details: true } })
    expect(rows.map((r) => (r.details as any).tableName).sort()).toEqual(['line_items', 'shipments'])
  }, 180_000)
})
