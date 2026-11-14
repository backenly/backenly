/**
 * ROW-EVENT FUNCTION RUNS ARE QUEUED, PACED AND KEPT UNTIL THEY FINISH
 * ====================================================================
 *
 * On production (2026-11-09) one bulk update of 5,271 orders started 5,271
 * runs of a no-op function, 200 at once each minute with nothing waiting for
 * them, after the captured rows had already been deleted: each run logged 3-5 s
 * and the burst was still running seven minutes later, and a restart in that
 * time would have lost the rest.
 *
 * Real capture trigger, outbox, queue, sandbox executor and run log; plain SQL
 * writes. Pinned here:
 *
 *  1. A burst runs every matching function once per row, never more than
 *     PROJECT_CONCURRENCY at a time for the project, and leaves no queue.
 *  2. A captured row is either in the outbox or queued for its functions:
 *     moving it is one transaction.
 *  3. A job a stopped process left claimed is claimed again and run; one left
 *     MAX_ATTEMPTS times is recorded as a failed run and dropped.
 *  4. A function that throws is recorded as failed once and not run again.
 *  5. Pausing a project discards its queued runs with its outbox.
 *  6. A run the function supervisor turns away for capacity goes back on the
 *     queue as it was, unrecorded, and runs once a slot is free.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { deployFunctionCode, listFunctionLogs } from '@/lib/services/ai-functions/agent-actions'
import { OUTBOX_TABLE, discardOutbox, drainWebhookOutbox } from '@/lib/webhooks/capture'
import {
  FUNCTION_JOBS_TABLE,
  MAX_ATTEMPTS,
  PROJECT_CONCURRENCY,
  ensureFunctionJobs,
  kickFunctionRuns,
} from '@/lib/services/ai-functions/run-queue'
import { startStandInSupervisor } from '../helpers/stand-in-function-supervisor'

let ownerId = ''
let projectId = ''
let schema = ''
let countFnId = ''
let throwFnId = ''
let changeFnId = ''

const count = async (table: string): Promise<number> => {
  const rows = (await queryWorkspaceSchema(projectId, `SELECT count(*)::int AS n FROM "${schema}"."${table}"`)) as Array<{ n: number }>
  return rows?.[0]?.n ?? 0
}

const runs = (functionId: string) => prisma.aiFunctionLog.findMany({ where: { functionId }, orderBy: { createdAt: 'asc' } })

/** Wait until the project's runner has nothing left: no job and no captured row. */
async function settled(ms = 60_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    await kickFunctionRuns(projectId, async () => 0)
    if ((await count(FUNCTION_JOBS_TABLE)) === 0 && (await count(OUTBOX_TABLE)) === 0) return
    if (Date.now() - start > ms) throw new Error('the queue did not empty')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** The most runs of a function that were going at the same moment, from each run's end and duration. */
function mostAtOnce(rows: Array<{ createdAt: Date; durationMs: number | null }>): number {
  const edges: Array<[number, number]> = []
  for (const r of rows) {
    const end = r.createdAt.getTime()
    edges.push([end - (r.durationMs ?? 0), 1], [end, -1])
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let now = 0
  let most = 0
  for (const [, d] of edges) {
    now += d
    most = Math.max(most, now)
  }
  return most
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({ data: { email: `fn-queue-${randomUUID()}@test.invalid`, name: 'queue' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `fn-queue-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = workspaceSchemaName(projectId)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."orders" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n integer NOT NULL, "updatedAt" timestamptz DEFAULT now())`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."refunds" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n integer NOT NULL)`)

  const counted = await deployFunctionCode(
    { userId: ownerId, projectId },
    { name: 'count-order', trigger: 'on_insert', table: 'orders', code: `ctx.log('order', event.data.n); return { n: event.data.n }` },
  )
  if (!counted.ok) throw new Error(`deploy failed: ${JSON.stringify(counted)}`)
  countFnId = (counted.data as any).functionId
  const throwing = await deployFunctionCode(
    { userId: ownerId, projectId },
    { name: 'refund-breaks', trigger: 'on_insert', table: 'refunds', code: `throw new Error('refunds are broken')` },
  )
  if (!throwing.ok) throw new Error(`deploy failed: ${JSON.stringify(throwing)}`)
  throwFnId = (throwing.data as any).functionId
  const changed = await deployFunctionCode(
    { userId: ownerId, projectId },
    { name: 'order-changed', trigger: 'on_update', table: 'orders', code: `ctx.log('changed', event.data.n); return {}` },
  )
  if (!changed.ok) throw new Error(`deploy failed: ${JSON.stringify(changed)}`)
  changeFnId = (changed.data as any).functionId
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

it(`runs a burst once per row, never more than ${PROJECT_CONCURRENCY} at a time, and leaves no queue`, async () => {
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) SELECT g FROM generate_series(1, 60) g`)
  expect(await count(OUTBOX_TABLE)).toBe(60)

  await drainWebhookOutbox()
  await settled()

  const done = await runs(countFnId)
  expect(done).toHaveLength(60)
  expect(done.every((r) => r.success)).toBe(true)
  expect(new Set(done.map((r) => r.logs[0])).size).toBe(60)
  expect(mostAtOnce(done)).toBeLessThanOrEqual(PROJECT_CONCURRENCY)
}, 120_000)

it('moves captured rows into the queue in one transaction: in one place or the other, never neither', async () => {
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) VALUES (1001), (1002)`)
  // A queue that cannot be written fails the move, and the rows stay captured.
  await executeInWorkspaceSchema(projectId, `ALTER TABLE "${schema}"."${FUNCTION_JOBS_TABLE}" ADD CONSTRAINT never CHECK (false) NOT VALID`)
  try {
    await drainWebhookOutbox()
    expect(await count(OUTBOX_TABLE)).toBe(2)
    expect(await count(FUNCTION_JOBS_TABLE)).toBe(0)
  } finally {
    await executeInWorkspaceSchema(projectId, `ALTER TABLE "${schema}"."${FUNCTION_JOBS_TABLE}" DROP CONSTRAINT never`)
  }
  // Rows claimed by the failed drain come back after the outbox's reclaim window.
  await executeInWorkspaceSchema(projectId, `UPDATE "${schema}"."${OUTBOX_TABLE}" SET claimed_at = now() - interval '1 hour'`)
  await drainWebhookOutbox()
  await settled()
  expect((await runs(countFnId)).filter((r) => ['order 1001', 'order 1002'].includes(r.logs[0]))).toHaveLength(2)
}, 120_000)

it('runs a job a stopped process left claimed, and drops one left too often with a failed run recorded', async () => {
  const event = (n: number) => JSON.stringify({ type: 'insert', table: 'orders', data: { n } })
  await executeInWorkspaceSchema(
    projectId,
    `INSERT INTO "${schema}"."${FUNCTION_JOBS_TABLE}" (function_id, event, attempts, claimed_at) VALUES
       ($1, $2::jsonb, 1, now() - interval '10 minutes'),
       ($1, $3::jsonb, ${MAX_ATTEMPTS}, now() - interval '10 minutes')`,
    countFnId, event(2001), event(2002),
  )
  await settled()

  const done = await runs(countFnId)
  expect(done.filter((r) => r.logs[0] === 'order 2001' && r.success)).toHaveLength(1)
  const dropped = done.filter((r) => !r.success && /started 3 times/.test(r.error ?? ''))
  expect(dropped).toHaveLength(1)
  expect(done.some((r) => r.logs[0] === 'order 2002')).toBe(false)
}, 120_000)

it('records a function that throws as failed once, and does not run it again', async () => {
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."refunds" (n) VALUES (1)`)
  await drainWebhookOutbox()
  await settled()
  await settled()
  const failed = await runs(throwFnId)
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({ success: false })
  expect(failed[0].error).toContain('refunds are broken')
}, 120_000)

it('tells an agent reading the run log how many runs are queued and not started yet', async () => {
  await executeInWorkspaceSchema(
    projectId,
    `INSERT INTO "${schema}"."${FUNCTION_JOBS_TABLE}" (function_id, event)
     SELECT $1, jsonb_build_object('type', 'insert', 'table', 'orders', 'data', jsonb_build_object('n', 4000 + g))
       FROM generate_series(1, 3) g`,
    countFnId,
  )
  const before = await listFunctionLogs({ userId: ownerId, projectId }, { name: 'count-order' })
  expect(before).toMatchObject({ ok: true, data: { queued: 3 } })
  expect(before.summary).toMatch(/3 more runs from row changes are queued and will start in order\./)

  await settled()
  const after = await listFunctionLogs({ userId: ownerId, projectId }, { name: 'count-order' })
  expect(after).toMatchObject({ ok: true, data: { queued: 0 } })
  expect(after.summary).not.toMatch(/queued/)
}, 120_000)

it('runs no update function for an update that changed nothing but the update stamp', async () => {
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) VALUES (5001)`)
  await drainWebhookOutbox()
  await settled()
  // Nothing changed, then only the stamp, then a value.
  await executeInWorkspaceSchema(projectId, `UPDATE "${schema}"."orders" SET n = n WHERE n = 5001`)
  await executeInWorkspaceSchema(projectId, `UPDATE "${schema}"."orders" SET "updatedAt" = now() + interval '1 second' WHERE n = 5001`)
  await executeInWorkspaceSchema(projectId, `UPDATE "${schema}"."orders" SET n = 5002 WHERE n = 5001`)
  await drainWebhookOutbox()
  await settled()
  const changes = await runs(changeFnId)
  expect(changes.map((r) => r.logs[0])).toEqual(['changed 5002'])
}, 120_000)

it('discards queued runs with the outbox when the project is paused', async () => {
  await executeInWorkspaceSchema(
    projectId,
    `INSERT INTO "${schema}"."${FUNCTION_JOBS_TABLE}" (function_id, event) VALUES ($1, '{"type":"insert","table":"orders","data":{"n":3001}}'::jsonb)`,
    countFnId,
  )
  await executeInWorkspaceSchema(projectId, `INSERT INTO "${schema}"."orders" (n) VALUES (3002)`)
  expect(await discardOutbox(projectId)).toBe(2)
  expect(await count(FUNCTION_JOBS_TABLE)).toBe(0)
  expect(await count(OUTBOX_TABLE)).toBe(0)
}, 60_000)

// A stand-in supervisor on a UNIX socket; Windows has no supervisor.
;(process.platform === 'win32' ? it.skip : it)(
  'puts back a run the function supervisor turned away for capacity, unrecorded, and runs it once a slot is free',
  async () => {
    await executeInWorkspaceSchema(
      projectId,
      `INSERT INTO "${schema}"."${FUNCTION_JOBS_TABLE}" (function_id, event) VALUES ($1, '{"type":"insert","table":"orders","data":{"n":6001}}'::jsonb)`,
      countFnId,
    )
    const recorded = (await runs(countFnId)).length
    const supervisor = await startStandInSupervisor()
    supervisor.use()
    try {
      expect(await kickFunctionRuns(projectId, async () => 0)).toMatchObject({ ran: 0, deferred: 1 })
    } finally {
      await supervisor.close()
    }
    // As it was before the claim: waiting, no attempt spent, nothing recorded.
    const queued = (await queryWorkspaceSchema(
      projectId,
      `SELECT attempts, claimed_at FROM "${schema}"."${FUNCTION_JOBS_TABLE}" WHERE event->'data'->>'n' = '6001'`,
    )) as Array<{ attempts: number; claimed_at: Date | null }>
    expect(queued).toEqual([{ attempts: 0, claimed_at: null }])
    expect(await runs(countFnId)).toHaveLength(recorded)
    expect((await prisma.aiFunction.findUniqueOrThrow({ where: { id: countFnId } })).status).toBe('active')

    await settled()
    expect((await runs(countFnId)).filter((r) => r.logs[0] === 'order 6001' && r.success)).toHaveLength(1)
  },
  60_000,
)
