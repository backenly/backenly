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
import { fireTriggers, listTriggers, listDeliveryLogs, replayDelivery } from '@/lib/services/trigger-service'
import { verifyTimestampedSignature } from '@/lib/webhooks'

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

describe("a trigger's webhook is signed with its time and its delivery id", () => {
  const SECRET = `whsec_${crypto.randomBytes(24).toString('hex')}`
  let hook: http.Server
  let failNext = 0
  const got: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []

  beforeAll(async () => {
    hook = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        got.push({ headers: req.headers, body })
        if (failNext > 0) {
          failNext--
          res.writeHead(503).end('busy')
        } else {
          res.writeHead(200).end('ok')
        }
      })
    })
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve))
    await prisma.appTrigger.create({
      data: {
        projectId,
        name: 'notify-billing',
        sourceTable: 'invoices',
        event: 'insert',
        actionType: 'webhook',
        webhookUrl: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/billing`,
        webhookSecret: SECRET,
      },
    })
    process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
  })

  afterAll(async () => {
    delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
    await new Promise<void>((resolve) => hook.close(() => resolve()))
  })

  beforeEach(() => {
    got.length = 0
    failNext = 0
  })

  /** What a receiver checks: the signature over this time, this delivery and these bytes, and a fresh time. */
  const verifies = (r: { headers: http.IncomingHttpHeaders; body: string }, now?: number) =>
    verifyTimestampedSignature({
      payload: r.body,
      deliveryId: String(r.headers['x-backenly-delivery']),
      timestamp: String(r.headers['x-backenly-timestamp']),
      signature: String(r.headers['x-backenly-signature-v2']),
      secret: SECRET,
      now,
    })

  it('signs a delivery, keeps the body-only signature, and logs the delivery under the id it sent', async () => {
    await fireTriggers(projectId, { type: 'insert', table: 'invoices', data: { id: 7001, total: 40 } })
    expect(got).toHaveLength(1)
    const [r] = got
    expect(r.headers['x-backenly-timestamp']).toMatch(/^\d{10}$/)
    expect(Math.abs(Date.now() / 1000 - Number(r.headers['x-backenly-timestamp']))).toBeLessThan(120)
    expect(r.headers['x-backenly-signature-v2']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifies(r)).toBe(true)
    // The same request, sent again six minutes later, is refused…
    expect(verifies(r, Date.now() + 6 * 60 * 1000)).toBe(false)
    // …and neither a fresh time nor another delivery id can be put on it.
    expect(verifyTimestampedSignature({
      payload: r.body, deliveryId: String(r.headers['x-backenly-delivery']), timestamp: Number(r.headers['x-backenly-timestamp']) + 60,
      signature: String(r.headers['x-backenly-signature-v2']), secret: SECRET,
    })).toBe(false)
    expect(verifyTimestampedSignature({
      payload: r.body, deliveryId: crypto.randomUUID(), timestamp: String(r.headers['x-backenly-timestamp']),
      signature: String(r.headers['x-backenly-signature-v2']), secret: SECRET,
    })).toBe(false)
    // Receivers that check the body-only signature keep working.
    expect(r.headers['x-backenly-signature']).toBe(`sha256=${crypto.createHmac('sha256', SECRET).update(r.body).digest('hex')}`)

    const log = await prisma.triggerDeliveryLog.findUnique({ where: { id: String(r.headers['x-backenly-delivery']) }, select: { status: true, table: true } })
    expect(log).toEqual({ status: 'SUCCESS', table: 'invoices' })
  }, 60_000)

  it('sends every attempt of one delivery with the same delivery id, each signed when it is sent', async () => {
    failNext = 1
    await fireTriggers(projectId, { type: 'insert', table: 'invoices', data: { id: 7002, total: 41 } })
    expect(got).toHaveLength(2)
    expect(got[0].headers['x-backenly-delivery']).toBeTruthy()
    expect(got[1].headers['x-backenly-delivery']).toBe(got[0].headers['x-backenly-delivery'])
    expect(verifies(got[0])).toBe(true)
    expect(verifies(got[1])).toBe(true)
    const log = await prisma.triggerDeliveryLog.findUnique({ where: { id: String(got[1].headers['x-backenly-delivery']) }, select: { status: true, attemptCount: true } })
    expect(log).toEqual({ status: 'SUCCESS', attemptCount: 2 })
  }, 60_000)

  it('replays a dead delivery under its own id, signed at the time of the replay', async () => {
    const trigger = await prisma.appTrigger.findFirstOrThrow({ where: { projectId, name: 'notify-billing' }, select: { id: true } })
    const dead = await prisma.triggerDeliveryLog.create({
      data: {
        triggerId: trigger.id, projectId, eventType: 'insert', table: 'invoices',
        payload: { event: 'insert', table: 'invoices', data: { id: 7003 } },
        status: 'DEAD', attemptCount: 3, error: 'receiver was down',
      },
      select: { id: true },
    })
    expect(await replayDelivery(projectId, dead.id)).toEqual({ success: true })
    expect(got).toHaveLength(1)
    expect(got[0].headers['x-backenly-delivery']).toBe(dead.id)
    expect(verifies(got[0])).toBe(true)
  }, 60_000)
})
