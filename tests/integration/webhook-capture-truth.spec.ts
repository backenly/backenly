/**
 * Webhook capture and delivery stop failing silently
 * (medium findings WH-F5, WH-F8, WH-F10).
 *
 * WH-F5: syncWebhookCapture swallowed per-table install failures and every
 * caller discarded its return, so create/update answered success while a
 * table's row events silently never fired. The sync now reports the
 * uncaptured tables and both callers surface them.
 *
 * WH-F8: a delivery whose FIRST attempt was interrupted (crash between
 * creating the log and the fetch resolving) sat PENDING forever — its
 * outbox row was already deleted, and the retry cron selected RETRYING
 * only. The cron now sweeps PENDING rows older than ten minutes.
 *
 * WH-F10 is a docs contract: endpoint events are project-wide with
 * data.table for filtering; per-table is the trigger family, which fires
 * from the JSON data routes only.
 */
import fs from 'fs'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { syncWebhookCapture, listCapturedTables } from '@/lib/webhooks/capture'
import { retryFailedWebhooks } from '@/lib/webhooks'

const ROOT = process.cwd()

let ownerId: string
let projectId: string
let receiver: http.Server
let receiverUrl: string
let received = 0

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `wh-capture-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Webhook Capture Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'webhook-capture', userId: ownerId },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${projectId}"."orders" (id serial PRIMARY KEY, total integer)`,
  )

  receiver = http.createServer((_req, res) => {
    received++
    res.writeHead(200).end('ok')
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`
}, 120_000)

afterAll(async () => {
  await prisma.webhookLog.deleteMany({ where: { webhook: { projectId } } }).catch(() => {})
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()))
}, 60_000)

describe('WH-F5: the sync names what it could not capture', () => {
  it('a clean sync reports empty uncaptured and real tables', async () => {
    await prisma.webhook.create({
      data: { projectId, eventType: 'row.inserted', targetUrl: receiverUrl, secret: 'whsec-test-value', active: true },
    })
    const sync = await syncWebhookCapture(projectId)
    expect(sync.uncaptured).toEqual([])
    expect(sync.tables).toContain('orders')
    await expect(listCapturedTables(projectId)).resolves.toContain('orders')
  }, 60_000)

  it('both callers surface a per-table failure instead of discarding it', () => {
    const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'webhooks', 'route.ts'), 'utf8')
    expect(route).toContain('sync.uncaptured.length > 0')
    expect(route).toContain('Row events are not captured on')
    const actions = fs.readFileSync(path.join(ROOT, 'lib', 'webhooks', 'agent-actions.ts'), 'utf8')
    expect(actions).toContain('sync.uncaptured.length > 0')
  })
})

describe('WH-F8: an interrupted first attempt is swept, not stranded', () => {
  it('a stale PENDING log is retried for real and delivered', async () => {
    const webhook = await prisma.webhook.findFirstOrThrow({ where: { projectId }, select: { id: true } })
    const log = await prisma.webhookLog.create({
      data: {
        webhookId: webhook.id,
        eventType: 'row.inserted',
        payload: { event: 'row.inserted', data: { table: 'orders', row: { id: 1 } } },
        signature: 'sha256=stale',
        status: 'PENDING',
        attemptCount: 1,
        createdAt: new Date(Date.now() - 15 * 60 * 1000),
      },
      select: { id: true },
    })

    received = 0
    process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      const processed = await retryFailedWebhooks()
      expect(processed).toBeGreaterThanOrEqual(1)
    } finally {
      delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
    }

    expect(received).toBe(1)
    const after = await prisma.webhookLog.findUnique({ where: { id: log.id }, select: { status: true } })
    expect(after?.status).toBe('SUCCESS')
  }, 60_000)

  it('a fresh PENDING log (first attempt still in flight) is left alone', async () => {
    const webhook = await prisma.webhook.findFirstOrThrow({ where: { projectId }, select: { id: true } })
    const log = await prisma.webhookLog.create({
      data: {
        webhookId: webhook.id,
        eventType: 'row.inserted',
        payload: { event: 'row.inserted', data: { table: 'orders', row: { id: 2 } } },
        signature: 'sha256=fresh',
        status: 'PENDING',
        attemptCount: 1,
      },
      select: { id: true },
    })
    received = 0
    process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      await retryFailedWebhooks()
    } finally {
      delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
    }
    expect(received).toBe(0)
    const after = await prisma.webhookLog.findUnique({ where: { id: log.id }, select: { status: true } })
    expect(after?.status).toBe('PENDING')
  }, 60_000)
})

describe('WH-F10: the docs state the project-wide contract', () => {
  it('webhooks.md says endpoints are project-wide with data.table filtering', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'webhooks.md'), 'utf8')
    expect(doc).toContain('project-wide')
    expect(doc).toContain('data.table')
    expect(doc).toContain('/database/insert')
  })

  it('the console prompt stops promising a per-table endpoint subscription', () => {
    const content = fs.readFileSync(path.join(ROOT, 'app', 'docs', 'content.ts'), 'utf8')
    expect(content).not.toContain('whenever a row is inserted into the orders table')
    expect(content).toContain('filters on data.table')
  })
})
