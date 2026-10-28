/**
 * ROW-EVENT FUNCTIONS FIRE FOR EVERY WRITER, NOT ONLY THE LEGACY ROUTES
 * =====================================================================
 * on_insert / on_update / on_delete functions were documented as running
 * "every time a row is inserted / updated / deleted" — but they were fired
 * inline by the legacy /database/* route handlers only. PostgREST (/api/v2
 * and /api/v1/{id}/db/*), MCP writes and SQL inside functions never pass
 * through those handlers, so the documented data plane never fired them.
 *
 * The fix rides the webhook capture: a database trigger writes every row
 * change to the outbox, and the drain now fires row-event functions from the
 * same captured event — so "fires for every writer" has one implementation.
 * This suite writes rows with PLAIN SQL (the one writer the old inline calls
 * could never see) and drives the real capture, drain, and sandbox executor.
 * No mocks.
 */

import { randomUUID } from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import {
  OUTBOX_TABLE,
  drainWebhookOutbox,
  listCapturedTables,
  syncCaptureForFunctionChange,
} from '@/lib/webhooks/capture'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let schema = ''
let insertFnId = ''
let updateFnId = ''

async function outboxCount(): Promise<number> {
  const rows = (await queryWorkspaceSchema(
    projectId,
    `SELECT count(*)::int AS n FROM "${schema}"."${OUTBOX_TABLE}"`,
  )) as Array<{ n: number }>
  return rows?.[0]?.n ?? 0
}

async function pollLogs(functionId: string, atLeast: number, ms = 10_000) {
  const start = Date.now()
  for (;;) {
    const rows = await prisma.aiFunctionLog.findMany({ where: { functionId } })
    if (rows.length >= atLeast || Date.now() - start > ms) return rows
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `fn-rowev-${randomUUID()}@test.invalid`, name: 'Row Events Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `fn-rowev-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = workspaceSchemaName(projectId)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."orders" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), total integer NOT NULL)`,
  )
}, 120_000)

afterAll(async () => {
  await prisma.aiFunctionLog.deleteMany({ where: { function: { projectId } } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('deploying a row-event function installs the capture', () => {
  it('deploy_code on on_insert puts the trigger on the tables, with no webhook in sight', async () => {
    const res = await deployFunctionCode(
      { userId: ownerId, projectId },
      {
        name: 'on-order',
        trigger: 'on_insert',
        table: 'orders',
        code: `ctx.log('order', event.data.id); return { seen: event.data.id }`,
      },
    )
    expect(res.ok).toBe(true)
    insertFnId = (res.data as any).functionId

    const res2 = await deployFunctionCode(
      { userId: ownerId, projectId },
      {
        name: 'on-order-change',
        trigger: 'on_update',
        table: 'orders',
        code: `ctx.log('total went', event.old && event.old.total, '->', event.data.total); return { ok: true }`,
      },
    )
    expect(res2.ok).toBe(true)
    updateFnId = (res2.data as any).functionId

    expect(await listCapturedTables(projectId)).toContain('orders')
  }, 120_000)
})

describe('a write the route handlers never see fires the function', () => {
  it('a plain SQL INSERT lands in the outbox and the drain runs the function exactly once', async () => {
    await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (total) VALUES (42)`)
    expect(await outboxCount()).toBeGreaterThanOrEqual(1)

    await drainWebhookOutbox()

    const logs = await pollLogs(insertFnId, 1)
    expect(logs).toHaveLength(1) // fired once — not inline-plus-capture twice
    expect(logs[0].success).toBe(true)
    expect(logs[0].logs.join(' ')).toContain('order')
    expect(await outboxCount()).toBe(0) // drained, not wedged
  }, 120_000)

  it('an UPDATE carries the old row into event.old', async () => {
    await executeInWorkspaceSchema(projectId, `UPDATE "${schema}"."orders" SET total = 99 WHERE total = 42`)
    await drainWebhookOutbox()

    const logs = await pollLogs(updateFnId, 1)
    expect(logs.length).toBeGreaterThanOrEqual(1)
    expect(logs[0].success).toBe(true)
    expect(logs[0].logs.join(' ')).toContain('total went 42 -> 99')
  }, 120_000)
})

describe('switching the last subscriber off takes the capture down', () => {
  it('inactive functions leave no trigger, and new writes capture nothing', async () => {
    await prisma.aiFunction.updateMany({ where: { projectId }, data: { status: 'inactive' } })
    await syncCaptureForFunctionChange(projectId, 'on_db_insert')

    expect(await listCapturedTables(projectId)).toEqual([])

    await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (total) VALUES (7)`)
    expect(await outboxCount()).toBe(0)
  }, 120_000)
})
