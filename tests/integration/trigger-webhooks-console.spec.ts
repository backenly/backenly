/**
 * The Webhooks page can see what the agent wired (medium finding WH-F7).
 *
 * `webhooks { create_trigger | triggers | trigger_deliveries |
 * replay_trigger_delivery | rotate_trigger_secret }` reads and writes
 * AppTrigger / TriggerDeliveryLog — and no console surface rendered either
 * table, so agent-created webhooks delivered (and dead-lettered) invisibly.
 *
 * The console now reads the same service functions the MCP tool uses. The
 * service behavior runs against the real test database with a real local
 * receiver (behind the operator loopback opt-in, set per test); the routes
 * and the panel section are pinned at source.
 */
import fs from 'fs'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { listTriggers, listDeliveryLogs, replayDelivery } from '@/lib/services/trigger-service'

const ROOT = process.cwd()

let ownerId: string
let projectId: string
let triggerId: string
let receiver: http.Server
let receiverUrl: string
const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `trig-console-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Trigger Console Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'trigger-console', userId: ownerId },
      select: { id: true },
    })
  ).id

  receiver = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`

  triggerId = (
    await prisma.appTrigger.create({
      data: {
        projectId,
        name: 'notify-crm',
        sourceTable: 'orders',
        event: 'insert',
        actionType: 'webhook',
        webhookUrl: receiverUrl,
        webhookSecret: crypto.randomBytes(16).toString('hex'),
      },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.triggerDeliveryLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.appTrigger.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()))
}, 60_000)

describe('WH-F7: the console reads the same rows the MCP tool writes', () => {
  it('listTriggers serves the webhook URL and never the signing secret', async () => {
    const triggers = await listTriggers(projectId)
    const mine = triggers.find((t) => t.id === triggerId) as any
    expect(mine).toBeTruthy()
    expect(mine.webhookUrl).toBe(receiverUrl)
    expect(mine.webhookSecret).toBeUndefined()
  }, 60_000)

  it('a dead delivery replays for real and the log flips to SUCCESS', async () => {
    const dead = await prisma.triggerDeliveryLog.create({
      data: {
        triggerId,
        projectId,
        eventType: 'insert',
        table: 'orders',
        payload: { event: 'insert', table: 'orders', row: { id: 1 } },
        status: 'DEAD',
        attemptCount: 5,
        error: 'receiver was down',
      },
      select: { id: true },
    })

    process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      const out = await replayDelivery(projectId, dead.id)
      expect(out).toEqual({ success: true })
    } finally {
      delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
    }

    expect(received).toHaveLength(1)
    expect(received[0].headers['x-backenly-trigger']).toBe('notify-crm')
    expect(received[0].headers['x-backenly-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)

    const logs = await listDeliveryLogs(projectId)
    const mine = logs.find((l) => l.id === dead.id)
    expect(mine?.status).toBe('SUCCESS')
  }, 60_000)

  it('replay refuses a delivery that is not dead', async () => {
    const ok = await prisma.triggerDeliveryLog.create({
      data: {
        triggerId,
        projectId,
        eventType: 'insert',
        table: 'orders',
        payload: { event: 'insert', table: 'orders', row: { id: 2 } },
        status: 'SUCCESS',
        statusCode: 200,
        deliveredAt: new Date(),
      },
      select: { id: true },
    })
    const out = await replayDelivery(projectId, ok.id)
    expect(out.success).toBe(false)
  }, 60_000)
})

describe('WH-F7: the console wiring exists', () => {
  it('the page reads trigger webhooks and can replay a dead delivery', () => {
    const panel = fs.readFileSync(path.join(ROOT, 'components', 'integrations', 'WebhooksPanel.tsx'), 'utf8')
    expect(panel).toContain('/trigger-webhooks')
    expect(panel).toContain('replayTriggerDelivery')
    expect(panel).toContain('Trigger webhooks')
  })

  it('the routes call the same service functions as the MCP tool', () => {
    const list = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'trigger-webhooks', 'route.ts'), 'utf8')
    expect(list).toContain('listTriggers')
    expect(list).toContain('listDeliveryLogs')
    const replay = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'trigger-webhooks', 'replay', 'route.ts'), 'utf8')
    expect(replay).toContain('replayDelivery')
  })
})
