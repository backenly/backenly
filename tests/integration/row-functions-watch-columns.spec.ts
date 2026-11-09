/**
 * A ROW-UPDATE FUNCTION RUNS WHEN WHAT IT WATCHES CHANGES
 * =======================================================
 *
 * Production QA (2026-11-09): one bulk UPDATE of 5,271 orders ran an "order
 * shipped" email function 5,271 times, each counted against the plan, though
 * no order's status changed. A row-update function ran for every updated row,
 * and there was no way to say which change it was for.
 *
 * deploy_code now takes `columns` for an on_update function. Pinned here with
 * the real deploy, the real capture drain and run queue (a captured update is
 * written to the outbox as the capture trigger writes it, so a row without its
 * old values can be one) and the change history:
 *
 *  1. An update that leaves the watched columns alone is not queued, runs
 *     nothing and leaves no run; one that changes a watched column runs it.
 *  2. With no old row to compare (a payload too large to capture), it runs.
 *  3. columns is refused for any other trigger and for a column the table does
 *     not have.
 *  4. A redeploy without columns runs on every update again, and restoring that
 *     change brings the columns back.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { deployFunctionCode, getFunction } from '@/lib/services/ai-functions/agent-actions'
import { executeInWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { OUTBOX_TABLE, drainWebhookOutbox } from '@/lib/webhooks/capture'
import { FUNCTION_JOBS_TABLE, kickFunctionRuns } from '@/lib/services/ai-functions/run-queue'

let ownerId: string
let projectId: string
let schema: string
let functionId: string
const ORDER = crypto.randomUUID()
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const actor = () => ({ userId: ownerId, projectId })
const deploy = (args: Record<string, unknown>) =>
  withChangeAttribution({ source: 'agent', actorUserId: ownerId }, () =>
    deployFunctionCode(actor(), { name: 'order-shipped', trigger: 'on_update', table: 'orders', code: 'ctx.log("ran for " + event.data.id)\nreturn true', ...args }),
  )

const runs = () => prisma.aiFunctionLog.count({ where: { functionId } })

/** A captured update, as the capture trigger writes it, drained and run to the end. */
async function update(after: Record<string, unknown>, before: Record<string, unknown> | undefined) {
  await executeInWorkspaceSchema(
    projectId,
    `INSERT INTO "${schema}"."${OUTBOX_TABLE}" (event_type, table_name, row_data, old_data, truncated)
     VALUES ('UPDATE', 'orders', $1::jsonb, $2::jsonb, $3)`,
    JSON.stringify({ id: ORDER, ...after }),
    before ? JSON.stringify({ id: ORDER, ...before }) : null,
    !before,
  )
  await drainWebhookOutbox()
  await kickFunctionRuns(projectId, async () => 0)
}

/** Runs queued and not finished. */
const queued = async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "${schema}"."${FUNCTION_JOBS_TABLE}"`,
  ).catch(() => [{ n: 0 }])
  return rows[0].n
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // The change history records governed changes only outside jest's in-memory engine.
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `watch-columns-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'watch-columns', userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."orders" (id uuid PRIMARY KEY, status text, notes text)`)

  const deployed = await deploy({ columns: ['status'] })
  if (!deployed.ok) throw new Error(`deploy failed: ${JSON.stringify(deployed)}`)
  functionId = (deployed.data as any).functionId
  expect(deployed.summary).toContain('run only when status changes')
  expect((deployed.data as any).watchedColumns).toEqual(['status'])
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 60_000)

describe('an on_update function watching status', () => {
  it('does not run for an update that leaves status alone', async () => {
    await update({ status: 'pending', notes: 'gift wrap' }, { status: 'pending', notes: null })
    expect(await runs()).toBe(0)
    expect(await queued()).toBe(0)
  }, 60_000)

  it('says what it watches when an agent reads it', async () => {
    const read = await getFunction(actor(), { functionId })
    expect(read.summary).toContain('only when status changes')
    expect((read.data as any).watchedColumns).toEqual(['status'])
  }, 60_000)

  it('runs for an update that changes status', async () => {
    await update({ status: 'shipped', notes: 'gift wrap' }, { status: 'pending', notes: 'gift wrap' })
    expect(await runs()).toBe(1)
  }, 60_000)

  it('runs when there is no old row to compare', async () => {
    await update({ status: 'shipped', notes: 'x' }, undefined)
    expect(await runs()).toBe(2)
  }, 60_000)
})

describe('deploying columns', () => {
  it('is refused for any trigger but on_update', async () => {
    const out = await deploy({ trigger: 'on_insert', columns: ['status'] })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
  }, 60_000)

  it('is refused for a column the table does not have', async () => {
    const out = await deploy({ columns: ['state'] })
    expect(out).toMatchObject({ ok: false, code: 'COLUMN_NOT_FOUND' })
    expect(out.summary).toContain('orders has no column state')
  }, 60_000)
})

describe('a redeploy without columns', () => {
  it('runs on every update again, and restoring it brings the columns back', async () => {
    const plain = await deploy({})
    expect(plain.ok).toBe(true)
    const before = await runs()
    await update({ status: 'shipped', notes: 'late' }, { status: 'shipped', notes: null })
    expect(await runs()).toBe(before + 1)

    const change = await prisma.backendChange.findFirst({ where: { projectId, kind: 'change' }, orderBy: { seq: 'desc' } })
    const preview = (await previewRecovery(projectId, change!.id))!
    expect(preview.action).toBe('restore')
    const restored = await recoverChange(projectId, change!.id, { mode: 'manual', actorUserId: ownerId, acknowledged: preview.acknowledgement ?? null })
    expect(restored).toMatchObject({ ok: true })
    expect(await prisma.aiFunctionTriggerColumns.findUnique({ where: { functionId } })).toMatchObject({ columns: ['status'] })

    const after = await runs()
    await update({ status: 'shipped', notes: 'later' }, { status: 'shipped', notes: 'late' })
    expect(await runs()).toBe(after)
  }, 120_000)
})
