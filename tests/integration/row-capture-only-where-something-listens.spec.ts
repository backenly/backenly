/**
 * ROW CAPTURE ONLY WHERE SOMETHING LISTENS
 * ========================================
 *
 * The capture trigger went on every table of the project for every row event
 * any subscriber wanted. One row function on orders made each write to every
 * other table write an outbox row too, which nothing would ever read: in the
 * production QA re-test (2026-11-16) product_views carried an AFTER UPDATE
 * capture trigger with no subscriber of its own.
 *
 * Now a table carries the trigger only for the events its subscribers want:
 * a row-event function's own table, the tables a row webhook names, and every
 * table for a webhook that names none. It comes off a table when its last
 * subscriber goes, and rows already captured still drain.
 *
 * Real capture trigger, outbox, functions and webhooks rows; plain SQL writes.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeInWorkspaceSchema, queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { executeAction } from '@/lib/ai/minimal-executor'
import { OUTBOX_TABLE, drainWebhookOutbox, syncWebhookCapture } from '@/lib/webhooks/capture'
import { FUNCTION_JOBS_TABLE } from '@/lib/services/ai-functions/run-queue'

let ownerId = ''
let projectId = ''
let schema = ''

const sql = (statement: string) => executeInWorkspaceSchema(projectId, statement)

/** Outbox rows, for one table or all. */
async function outbox(table?: string): Promise<number> {
  const rows = (await queryWorkspaceSchema(
    projectId,
    `SELECT count(*)::int AS n FROM "${schema}"."${OUTBOX_TABLE}"${table ? ' WHERE table_name = $1' : ''}`,
    ...(table ? [table] : []),
  )) as Array<{ n: number }>
  return rows?.[0]?.n ?? 0
}

/** The events each table's capture trigger fires on, as the catalog says. */
async function captured(): Promise<Record<string, string[]>> {
  const rows = (await queryWorkspaceSchema(
    projectId,
    `SELECT event_object_table AS t, event_manipulation AS e
       FROM information_schema.triggers
      WHERE trigger_schema = $1 AND trigger_name = 'backenly_webhook_capture'
      ORDER BY 1, 2`,
    schema,
  )) as Array<{ t: string; e: string }>
  const out: Record<string, string[]> = {}
  for (const r of rows) (out[r.t] ??= []).push(r.e)
  return out
}

async function deploy(name: string, trigger: string, table: string): Promise<string> {
  const deployed = await deployFunctionCode({ userId: ownerId, projectId }, { name, trigger, table, code: 'return {}' })
  if (!deployed.ok) throw new Error(`deploy failed: ${JSON.stringify(deployed)}`)
  return (deployed.data as any).functionId
}

const webhook = (eventType: string, tables: string[]) =>
  prisma.webhook.create({
    data: { projectId, eventType, targetUrl: 'https://hooks.example.test/in', secret: 'whsec-' + 'x'.repeat(24), tables },
    select: { id: true },
  })

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({ data: { email: `capture-${randomUUID()}@test.invalid`, name: 'capture' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `capture-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = workspaceSchemaName(projectId)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  for (const table of ['orders', 'product_views', 'reviews']) {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), n integer NOT NULL)`)
  }
}, 120_000)

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

it('with one row function on orders, a write to another table writes no outbox row', async () => {
  await deploy('order-updated', 'on_update', 'orders')
  expect(await captured()).toEqual({ orders: ['UPDATE'] })

  await sql(`INSERT INTO "${schema}"."product_views" (n) VALUES (1)`)
  await sql(`UPDATE "${schema}"."product_views" SET n = 2`)
  expect(await outbox('product_views')).toBe(0)

  // Its own table, for its own event only.
  await sql(`INSERT INTO "${schema}"."orders" (n) VALUES (1)`)
  expect(await outbox('orders')).toBe(0)
  await sql(`UPDATE "${schema}"."orders" SET n = 2`)
  expect(await outbox('orders')).toBe(1)
}, 120_000)

it('captures the tables a webhook names, and every table for one that names none', async () => {
  const named = await webhook('row.inserted', ['reviews'])
  await syncWebhookCapture(projectId)
  expect(await captured()).toEqual({ orders: ['UPDATE'], reviews: ['INSERT'] })

  const everyTable = await webhook('row.deleted', [])
  await syncWebhookCapture(projectId)
  expect(await captured()).toEqual({ orders: ['DELETE', 'UPDATE'], product_views: ['DELETE'], reviews: ['DELETE', 'INSERT'] })

  await prisma.webhook.deleteMany({ where: { id: { in: [named.id, everyTable.id] } } })
  await syncWebhookCapture(projectId)
  expect(await captured()).toEqual({ orders: ['UPDATE'] })
}, 120_000)

it('takes the trigger off a table when its last listener goes, and what it captured still drains', async () => {
  const orders = (await prisma.aiFunction.findFirstOrThrow({ where: { projectId, name: 'order-updated' }, select: { id: true } })).id
  await deploy('review-added', 'on_insert', 'reviews')
  expect(await captured()).toEqual({ orders: ['UPDATE'], reviews: ['INSERT'] })
  expect(await outbox('orders')).toBe(1) // the UPDATE captured above, not drained yet

  const off = (await executeAction({ action: 'TOGGLE_AI_FUNCTION', params: { functionId: orders, active: false } } as any, projectId, undefined, 0, undefined, false)) as any
  expect(off.success).toBe(true)
  expect(await captured()).toEqual({ reviews: ['INSERT'] })

  await sql(`UPDATE "${schema}"."orders" SET n = 3`)
  expect(await outbox('orders')).toBe(1)

  await drainWebhookOutbox()
  expect(await outbox()).toBe(0)
  const jobs = (await queryWorkspaceSchema(projectId, `SELECT count(*)::int AS n FROM "${schema}"."${FUNCTION_JOBS_TABLE}" WHERE function_id = $1`, orders).catch(
    () => [{ n: 0 }],
  )) as Array<{ n: number }>
  expect(jobs[0]?.n ?? 0).toBe(0)
}, 120_000)
