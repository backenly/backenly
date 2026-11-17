/**
 * A FUNCTION SWITCHED OFF STAYS OFF, AND STOPS AT ONCE
 * ====================================================
 *
 * Production QA re-test, 2026-11-16, new finding N7: an on_insert function
 * switched off in the middle of a 32,000-row burst kept running the burst and
 * counting the runs against the month (7,208 → 7,412 of 10,000) until it was
 * deleted, and the queue grew after the switch. Each finished run wrote its
 * status outright ('active', or 'error', which still runs), so a run that
 * started before the switch-off switched the function back on when it ended;
 * the drain then matched the function again and queued more of the burst.
 *
 * Real capture trigger, outbox, queue, sandbox executor and run log. Pinned:
 *
 *  1. A run that started before the switch-off, ending well or badly, leaves
 *     the function off.
 *  2. Switched off in the middle of a burst, no run starts after it, nothing
 *     stays queued for it, and the answer says how many queued runs it dropped.
 *  3. The console's switch drops them too, and says how many.
 */

let mockUserId = ''
jest.mock('@/lib/auth/middleware', () => ({
  ...jest.requireActual('@/lib/auth/middleware'),
  authenticateRequest: async () => ({ authenticated: true, userId: mockUserId }),
}))

import '../helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'
import { OUTBOX_TABLE, drainWebhookOutbox } from '@/lib/webhooks/capture'
import { FUNCTION_JOBS_TABLE, ensureFunctionJobs, kickFunctionRuns } from '@/lib/services/ai-functions/run-queue'
import { executeAction } from '@/lib/ai/minimal-executor'
import { PUT as powerRoute } from '@/app/api/projects/[id]/ai-functions/[functionId]/route'

let ownerId = ''
let projectId = ''
let schema = ''

const count = async (table: string, where = 'true', ...params: unknown[]): Promise<number> => {
  const rows = (await queryWorkspaceSchema(projectId, `SELECT count(*)::int AS n FROM "${schema}"."${table}" WHERE ${where}`, ...params)) as Array<{ n: number }>
  return rows?.[0]?.n ?? 0
}

const statusOf = async (id: string) => (await prisma.aiFunction.findUniqueOrThrow({ where: { id } })).status

/** Switch a function off the way an agent does: functions { action: "set_active", active: false }. */
const switchOff = (functionId: string) =>
  executeAction({ action: 'TOGGLE_AI_FUNCTION', params: { functionId, active: false } } as any, projectId, undefined, 0, undefined, false) as Promise<any>

async function deploy(name: string, table: string, code: string): Promise<string> {
  const deployed = await deployFunctionCode({ userId: ownerId, projectId }, { name, trigger: 'on_insert', table, code })
  if (!deployed.ok) throw new Error(`deploy failed: ${JSON.stringify(deployed)}`)
  return (deployed.data as any).functionId
}

/** Wait until the project's runner has nothing left to do. */
async function settled(ms = 60_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    await kickFunctionRuns(projectId, async () => 0)
    if ((await count(FUNCTION_JOBS_TABLE)) === 0) return
    if (Date.now() - start > ms) throw new Error('the queue did not empty')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Wait until the run the executor answered has written its record (it is not awaited there). */
async function recorded(id: string, runs: number, ms = 10_000): Promise<void> {
  const start = Date.now()
  while ((await prisma.aiFunction.findUniqueOrThrow({ where: { id } })).runCount < runs) {
    if (Date.now() - start > ms) throw new Error('the run was never recorded')
    await new Promise((r) => setTimeout(r, 50))
  }
  // The status is written right after the record: give it the same moment.
  await new Promise((r) => setTimeout(r, 200))
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({ data: { email: `fn-off-${randomUUID()}@test.invalid`, name: 'off' }, select: { id: true } })).id
  mockUserId = ownerId
  projectId = (await prisma.project.create({ data: { name: `fn-off-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = workspaceSchemaName(projectId)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  for (const table of ['orders', 'refunds', 'reviews', 'events']) {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n integer NOT NULL)`)
  }
  await ensureFunctionJobs(projectId)
}, 120_000)

afterAll(async () => {
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

it.each([
  ['ends well', 'refunds', `const t = Date.now(); while (Date.now() - t < 800) {} return { ok: true }`, true],
  ['ends badly', 'reviews', `const t = Date.now(); while (Date.now() - t < 800) {} throw new Error('slow and broken')`, false],
])('a run that started before the switch-off and %s leaves the function off', async (_how, table, code, ok) => {
  const id = await deploy(`slow-${table}`, table, code)
  const run = executeAiFunction(id, projectId, { type: 'insert', table, data: { n: 1 } })
  await new Promise((r) => setTimeout(r, 300))
  expect((await switchOff(id)).success).toBe(true)
  expect(await statusOf(id)).toBe('inactive')

  expect((await run).success).toBe(ok)
  await recorded(id, 1)
  expect(await statusOf(id)).toBe('inactive')
}, 60_000)

it('switched off in the middle of a burst, starts no run after it, keeps nothing queued for it, and says how many it dropped', async () => {
  const id = await deploy('slow-order', 'orders', `const t = Date.now(); while (Date.now() - t < 150) {} ctx.log('order', event.data.n); return {}`)
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) SELECT g FROM generate_series(1, 80) g`)
  await drainWebhookOutbox()
  // Runs are going: the runner takes four at a time.
  await new Promise((r) => setTimeout(r, 700))

  const offAt = Date.now()
  const off = await switchOff(id)
  expect(off.success).toBe(true)
  const dropped = off.data.droppedQueuedRuns
  expect(dropped).toBeGreaterThan(0)
  expect(off.message).toContain(`${dropped.toLocaleString('en-US')} queued ${dropped === 1 ? 'run' : 'runs'} from row changes ${dropped === 1 ? 'was' : 'were'} dropped and will not run.`)
  expect(await count(FUNCTION_JOBS_TABLE, 'function_id = $1 AND claimed_at IS NULL', id)).toBe(0)

  // Rows captured after the switch queue nothing for it either.
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) SELECT g FROM generate_series(1001, 1020) g`)
  await drainWebhookOutbox()
  await settled()
  await new Promise((r) => setTimeout(r, 300))

  expect(await statusOf(id)).toBe('inactive')
  const runs = await prisma.aiFunctionLog.findMany({ where: { functionId: id } })
  // A run's record is written when it ends; it started durationMs before that.
  const startedAfter = runs.filter((r) => r.createdAt.getTime() - (r.durationMs ?? 0) > offAt + 100)
  expect(startedAfter).toEqual([])
  expect(runs.length + dropped).toBeLessThanOrEqual(80)
  expect(await count(OUTBOX_TABLE)).toBe(0)
}, 120_000)

it("the console's switch drops the queued runs too, and says how many", async () => {
  const id = await deploy('event-counter', 'events', `return {}`)
  await executeInWorkspaceSchema(
    projectId,
    `INSERT INTO "${schema}"."${FUNCTION_JOBS_TABLE}" (function_id, event)
     SELECT $1, jsonb_build_object('type', 'insert', 'table', 'events', 'data', jsonb_build_object('n', g))
       FROM generate_series(1, 3) g`,
    id,
  )
  const res = await powerRoute({ json: async () => ({ status: 'inactive' }) } as any, {
    params: Promise.resolve({ id: projectId, functionId: id }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ success: true, status: 'inactive', droppedQueuedRuns: 3 })
  expect(await count(FUNCTION_JOBS_TABLE, 'function_id = $1', id)).toBe(0)
  expect(await statusOf(id)).toBe('inactive')
}, 60_000)
