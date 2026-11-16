/**
 * ROW-EVENT RUNS PAST THE MONTH'S ALLOWANCE ARE NOT QUEUED, AND A BURST SAYS SO
 * ============================================================================
 *
 * Production QA re-test, 2026-11-16, #40: one 32,000-row insert queued about
 * 32,000 runs of an on_insert function where Free includes 10,000 a month, and
 * nothing said so. The queue ran the burst until the month's runs were used,
 * and then every run still queued was refused one at a time, each leaving a
 * failed run in the log.
 *
 * Pinned, with the real capture trigger, outbox, queue, sandbox executor and
 * run log, and a plan of 50 runs a month:
 *
 *  1. A burst larger than the runs left is queued with one notice in the
 *     function's run log; once the runs are used, the first refusal drops the
 *     rest of its queue with one record.
 *  2. With no runs left, row changes queue no run, and each drain batch leaves
 *     one "Not run" record for the function.
 *  3. deploy_code and the function list say a row function runs once per row.
 */

import { randomUUID } from 'crypto'
import type { UserEntitlements } from '@/lib/entitlements/types'

let mockEnt: UserEntitlements
jest.mock('@/lib/entitlements', () => ({
  ...jest.requireActual('@/lib/entitlements'),
  getAccountEntitlements: () => Promise.resolve(mockEnt),
  getOveragePolicy: () => Promise.resolve(null),
}))

import { prisma } from '@/lib/db/prisma'
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import { thisMonth } from '@/lib/entitlements/policy'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { executeAction } from '@/lib/ai/minimal-executor'

// One run at a time, so each run starts after the one before it was counted.
// Set before the queue is loaded, which reads it once.
process.env.FUNCTION_RUNS_PER_PROJECT = '1'
const { FUNCTION_JOBS_TABLE, ensureFunctionJobs, kickFunctionRuns } = require('@/lib/services/ai-functions/run-queue')
const { OUTBOX_TABLE, drainWebhookOutbox } = require('@/lib/webhooks/capture')

const CAP = 50
let ownerId = ''
let projectId = ''
let schema = ''

const count = async (table: string): Promise<number> => {
  const rows = (await queryWorkspaceSchema(projectId, `SELECT count(*)::int AS n FROM "${schema}"."${table}"`)) as Array<{ n: number }>
  return rows?.[0]?.n ?? 0
}

/** Set how many of this month's runs the account has used. */
async function used(n: number): Promise<void> {
  await prisma.accountAiUsage.upsert({
    where: { billingAccountId_date: { billingAccountId: ownerId, date: thisMonth() } },
    update: { aiFunctionInvocations: n },
    create: { billingAccountId: ownerId, date: thisMonth(), aiFunctionInvocations: n },
  })
}

async function settled(ms = 60_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    await kickFunctionRuns(projectId, async () => 0)
    if ((await count(FUNCTION_JOBS_TABLE)) === 0 && (await count(OUTBOX_TABLE)) === 0) return
    if (Date.now() - start > ms) throw new Error('the queue did not empty')
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function deploy(name: string, table: string): Promise<string> {
  const deployed = await deployFunctionCode(
    { userId: ownerId, projectId },
    { name, trigger: 'on_insert', table, code: `ctx.log('row', event.data.n); return {}` },
  )
  if (!deployed.ok) throw new Error(`deploy failed: ${JSON.stringify(deployed)}`)
  return (deployed.data as any).functionId
}

const runsOf = (functionId: string) => prisma.aiFunctionLog.findMany({ where: { functionId }, orderBy: { createdAt: 'asc' } })

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  mockEnt = { ...selfHostedEntitlements(), planName: 'SANDBOX', maxAiFunctionInvocationsPerMonth: CAP }
  ownerId = (await prisma.user.create({ data: { email: `fn-allowance-${randomUUID()}@test.invalid`, name: 'allowance' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `fn-allowance-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = workspaceSchemaName(projectId)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  for (const table of ['orders', 'refunds']) {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n integer NOT NULL)`)
  }
  await ensureFunctionJobs(projectId)
}, 120_000)

afterAll(async () => {
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: ownerId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

it('queues a burst larger than the runs left with one notice, runs what is left, and drops the rest with one record', async () => {
  const id = await deploy('count-order', 'orders')
  await used(CAP - 5)
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) SELECT g FROM generate_series(1, 30) g`)
  await drainWebhookOutbox()
  await settled()

  const records = await runsOf(id)
  const ran = records.filter((r) => r.success && r.triggerType !== 'notice')
  const notices = records.filter((r) => r.triggerType === 'notice')
  const failed = records.filter((r) => !r.success)

  expect(ran).toHaveLength(5)
  expect(notices).toHaveLength(1)
  expect(notices[0].logs[0]).toBe(
    "Row changes on orders have queued 30 function runs in this project, more than the 5 of this month's 50 the account has left (Free plan). Once those are used, the runs still queued are dropped, not run.",
  )
  expect(failed).toHaveLength(1)
  expect(failed[0].error).toBe(
    "Not run: You've used all 50 function runs your Free plan allows this month, across all of your projects. " +
      'So this insert on orders and the 24 runs still queued for this function were dropped.',
  )
  expect(await count(FUNCTION_JOBS_TABLE)).toBe(0)
}, 120_000)

it('queues no run once the month’s runs are used, and leaves one record per drain batch', async () => {
  const id = await deploy('count-refund', 'refunds')
  await used(CAP)
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."refunds" (n) SELECT g FROM generate_series(1, 12) g`)
  await drainWebhookOutbox()
  expect(await count(FUNCTION_JOBS_TABLE)).toBe(0)
  await settled()

  const records = await runsOf(id)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    success: false,
    triggerType: 'insert',
    error: "Not run: 12 inserts on refunds arrived after this month's 50 function runs were used (Free plan), so no run was queued for them.",
  })
}, 120_000)

it('says in deploy_code and in the list that a row function runs once per row', async () => {
  const deployed = await deployFunctionCode(
    { userId: ownerId, projectId },
    { name: 'audit-refund', trigger: 'on_insert', table: 'refunds', code: `return {}` },
  )
  expect(deployed.ok).toBe(true)
  expect(deployed.summary).toContain(
    "It runs once for each row inserted, so a bulk insert of 10,000 rows is 10,000 runs, each counted toward the month's function runs",
  )

  const list = (await executeAction({ action: 'LIST_AI_FUNCTIONS', params: {} } as any, projectId, undefined, 0, undefined, false)) as any
  expect(list.message).toMatch(/\*\*audit-refund\*\*[\s\S]*?Trigger: `on_db_insert:refunds` \(once per row: a bulk write runs it for every row\)/)
}, 60_000)
