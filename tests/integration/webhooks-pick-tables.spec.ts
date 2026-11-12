/**
 * A webhook endpoint can name the tables it receives row events for.
 *
 * Production QA (2026-11-09, report 102): row events fired for every table, so
 * an endpoint listening for new orders would also have received every
 * analytics insert (1.14M rows on one table there). Now an endpoint may list
 * tables; none means every table, as before. Sign-ups come from no table.
 *
 * Real: the schema, the capture trigger, the outbox, the drain, a receiver on
 * loopback, the History capture and the agent's webhook actions. The receiver
 * runs on 127.0.0.1 with the operator's private-egress opt-in set per test,
 * as in webhook-delivery.spec.ts.
 */
import crypto from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'

import { prisma } from '@/lib/db/prisma'
import { createWebhook, updateWebhook, WebhookTablesError } from '@/lib/webhooks'
import { syncWebhookCapture, drainWebhookOutbox, OUTBOX_TABLE } from '@/lib/webhooks/capture'
import { createProjectWebhook, updateProjectWebhook } from '@/lib/webhooks/agent-actions'
import { webhooksAdapter } from '@/lib/changes/resources/webhooks'
import { onlyTurnsOff } from '@/lib/webhooks/plan'

let server: http.Server
let port = 0
const received: Array<{ path: string; body: any }> = []
let ownerId: string
let projectId: string
let schema: string

const url = (path: string) => `http://127.0.0.1:${port}${path}`
const hits = (path: string) => received.filter((r) => r.path === path)

async function waitFor(n: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (received.length < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} deliveries, received ${received.length}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  ownerId = (
    await prisma.user.create({
      data: { email: `webhook-tables-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Tables' },
      select: { id: true },
    })
  ).id
  projectId = (await prisma.project.create({ data: { name: 'webhook-tables', userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."orders" (id serial PRIMARY KEY, total int NOT NULL DEFAULT 0)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."product_views" (id serial PRIMARY KEY, product int NOT NULL DEFAULT 0)`)
}, 60_000)

beforeEach(() => {
  received.length = 0
  process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
})

afterEach(async () => {
  delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
  await prisma.webhook.deleteMany({ where: { projectId } })
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${OUTBOX_TABLE}" CASCADE`).catch(() => {})
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
}, 60_000)

describe('delivery', () => {
  it('sends a row event only to the endpoints that listen to its table, or to every table', async () => {
    await createWebhook(projectId, 'row.inserted', url('/orders-only'), ['orders'])
    await createWebhook(projectId, 'row.inserted', url('/every-table'))
    await syncWebhookCapture(projectId)

    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."product_views" (product) VALUES (7)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."orders" (total) VALUES (1200)`)
    await drainWebhookOutbox()
    await waitFor(3)
    await new Promise((r) => setTimeout(r, 300)) // nothing more is on its way

    expect(hits('/orders-only').map((r) => r.body.data.table)).toEqual(['orders'])
    expect(hits('/every-table').map((r) => r.body.data.table).sort()).toEqual(['orders', 'product_views'])
  }, 60_000)
})

describe('the table list', () => {
  it('refuses a table the project does not have, naming the ones it can', async () => {
    const err = await createWebhook(projectId, 'row.inserted', url('/x'), ['ordres']).catch((e) => e)
    expect(err).toBeInstanceOf(WebhookTablesError)
    expect(err).toMatchObject({ code: 'UNKNOWN_TABLE' })
    expect(err.message).toContain('"ordres"')
    expect(err.message).toContain('orders, product_views')
    expect(await prisma.webhook.count({ where: { projectId } })).toBe(0)
  })

  it('refuses tables on a sign-up event, and drops them when an endpoint moves to one', async () => {
    const err = await createWebhook(projectId, 'auth.user.created', url('/x'), ['orders']).catch((e) => e)
    expect(err).toMatchObject({ code: 'TABLES_NOT_APPLICABLE' })

    const hook = await createWebhook(projectId, 'row.inserted', url('/x'), ['orders'])
    const moved = await updateWebhook(projectId, hook.id, { eventType: 'auth.user.created' })
    expect(moved!.tables).toEqual([])
  })

  it('is changed by an edit, and [] goes back to every table', async () => {
    const hook = await createWebhook(projectId, 'row.updated', url('/x'))
    expect((await updateWebhook(projectId, hook.id, { tables: ['orders', 'orders'] }))!.tables).toEqual(['orders'])
    expect((await updateWebhook(projectId, hook.id, { tables: [] }))!.tables).toEqual([])
  })

  it('is an edit that needs the plan, not a stop', () => {
    expect(onlyTurnsOff({ active: false })).toBe(true)
    expect(onlyTurnsOff({ active: false, tables: ['orders'] })).toBe(false)
  })

  it('is kept in History, so a restore brings it back', async () => {
    const hook = await createWebhook(projectId, 'row.deleted', url('/x'), ['orders'])
    const captured = await webhooksAdapter.capture(projectId)
    expect(captured[`webhook:${hook.id}`].fields).toMatchObject({ tables: ['orders'] })
  })
})

describe('over MCP', () => {
  it('creates and edits an endpoint with tables, and says which', async () => {
    const actor = { userId: ownerId, projectId }
    const created = await createProjectWebhook(actor, { eventType: 'row.inserted', targetUrl: url('/x'), tables: ['orders'] })
    expect(created).toMatchObject({ ok: true, data: { webhook: { tables: ['orders'] } } })
    expect(created.summary).toContain('row.inserted (orders) →')

    const id = (created.data as { webhook: { id: string } }).webhook.id
    const edited = await updateProjectWebhook(actor, { webhookId: id, tables: ['nope'] })
    expect(edited).toMatchObject({ ok: false, code: 'UNKNOWN_TABLE' })
  })
})
