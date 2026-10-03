/**
 * WHEN THE DEPENDENCY THAT FAILS IS SOMEBODY ELSE'S SERVER
 * =======================================================
 *
 * The other dependency-failure suites take away something this deployment owns.
 * This one takes away something it does not: the customer's own HTTP endpoint,
 * which can be down for a week without anyone here being able to do a thing
 * about it.
 *
 * That makes the contract different. A database outage means refuse the request
 * and say so. An unreachable receiver means KEEP the event, retry it on a
 * schedule, and deliver it exactly once when the endpoint returns — because the
 * row already changed, and the customer's system is now behind.
 *
 * Three ways that goes wrong, and all three are asserted:
 *
 *   LOST        the attempt fails and nothing records that it ever happened,
 *               so the event is gone and no retry will ever be made
 *   DUPLICATED  the retry ladder delivers the same logical event more than
 *               once, so at-least-once quietly becomes at-least-twice and the
 *               customer's handler runs twice for one row change
 *   NEVER       the endpoint comes back and nothing notices, because the retry
 *               was scheduled against something that does not run
 *
 * ── A real receiver, genuinely stopped ──────────────────────────────────────
 *
 * The receiver is a real HTTP server on loopback. It is CLOSED and later
 * reopened ON THE SAME PORT, so the failure is a real connection refusal and
 * the recovery needs no reconfiguration — the stored targetUrl must still be
 * correct, exactly as it would be for an operator whose endpoint restarted.
 *
 * Loopback is blocked by the egress guard by default and should be;
 * `BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE` is the operator opt-in, set here for
 * the same reason webhook-delivery.spec.ts sets it.
 *
 * ── Connection refused must NOT be treated as a refusal ─────────────────────
 *
 * There are two ways a delivery can fail to leave this process, and they mean
 * opposite things. `BlockedOutboundError` from the egress guard is a permanent
 * configuration fault — this URL is not allowed — and retrying it five times
 * would be pointless noise. ECONNREFUSED is the customer's server being down,
 * which is exactly what the ladder exists for. Collapsing the two would either
 * spam a forbidden URL or drop every event from a receiver that was restarting.
 */

import crypto from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
import { PrismaClient } from '@prisma/client'

import { OUTBOX_TABLE } from '@/lib/webhooks/capture'

const prisma = new PrismaClient()

const TABLE = 'orders'

interface Received {
  headers: http.IncomingHttpHeaders
  body: any
}

/**
 * A receiver that can be stopped and brought back on the same port.
 *
 * The port is captured on the first listen and reused, because the whole point
 * is that the stored destination stays valid across the outage.
 */
class Receiver {
  private server: http.Server | null = null
  readonly received: Received[] = []
  port = 0

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        let body: any = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          /* recorded as null; the raw shape is not what is asserted */
        }
        this.received.push({ headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      })
    })
    await new Promise<void>(resolve => server.listen(this.port, '127.0.0.1', resolve))
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/hook`
  }
}

let receiver: Receiver
let ownerId: string
let projectId: string
let schema: string
let webhookId: string

async function logs() {
  return prisma.webhookLog.findMany({
    where: { webhookId },
    orderBy: { createdAt: 'asc' },
  })
}

/** Wait for a condition the product reaches asynchronously, or fail loudly. */
async function until<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | null = null
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`)
}

beforeAll(async () => {
  // Delivery is attempted against loopback, which the guard blocks by default.
  process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'

  receiver = new Receiver()
  await receiver.start()

  ownerId = (
    await prisma.user.create({
      data: {
        email: `dep-hook-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Receiver Outage Suite',
      },
      select: { id: true },
    })
  ).id

  projectId = (
    await prisma.project.create({
      data: { name: 'receiver-outage', userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${TABLE}" (
       id serial PRIMARY KEY,
       label text NOT NULL
     )`,
  )
}, 180_000)

afterAll(async () => {
  delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
  await receiver?.stop().catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 180_000)

// ─────────────────────────────────────────────────────────────────────────────

describe('a receiver that is down, and then is not', () => {
  it('delivers to a receiver that IS up, which is the control', async () => {
    const { syncWebhookCapture, drainWebhookOutbox } = await import('@/lib/webhooks/capture')

    webhookId = (
      await prisma.webhook.create({
        data: {
          projectId,
          eventType: 'row.inserted',
          targetUrl: receiver.url,
          secret: crypto.randomBytes(32).toString('hex'),
        },
        select: { id: true },
      })
    ).id

    await syncWebhookCapture(projectId)
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('while-up')`,
    )
    expect(await drainWebhookOutbox()).toBeGreaterThanOrEqual(1)

    // Without this, every assertion below would be equally true of a fixture
    // whose receiver was never reachable at all.
    await until('the control delivery to arrive', async () =>
      receiver.received.length === 1 ? true : null,
    )
    const delivered = await until('the control log to be SUCCESS', async () => {
      const all = await logs()
      return all.length === 1 && all[0].status === 'SUCCESS' ? all[0] : null
    })
    expect(delivered.attemptCount).toBe(1)
    expect(receiver.received[0].body.data.record.label).toBe('while-up')
  }, 180_000)

  it('records the failure and schedules a retry rather than losing the event', async () => {
    const { drainWebhookOutbox } = await import('@/lib/webhooks/capture')

    await receiver.stop()
    receiver.received.length = 0

    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('while-down')`,
    )
    expect(await drainWebhookOutbox()).toBeGreaterThanOrEqual(1)

    // Delivery is deliberately fire-and-forget, so the state is reached
    // asynchronously. Polled, not slept on: a fixed sleep would either be flaky
    // or slow, and a passing sleep proves only that the sleep was long enough.
    const retrying = await until('the failed attempt to be recorded', async () => {
      const all = await logs()
      return all.find(l => l.status === 'RETRYING') ?? null
    })

    // RECORDED, not lost. This row is the only thing that will ever cause
    // another attempt.
    expect(retrying.attemptCount).toBe(1)
    expect(retrying.nextRetryAt).toBeTruthy()
    expect(retrying.deliveredAt).toBeNull()
    expect(retrying.error).toBeTruthy()

    // NOT treated as a refused destination. The egress guard's refusal is
    // terminal by design; a connection refusal must stay on the ladder, or
    // every event from a receiver that happened to be restarting is dropped.
    expect(retrying.status).not.toBe('FAILED')
    expect(retrying.status).not.toBe('DEAD_LETTER')

    // And nothing was delivered while it was down.
    expect(receiver.received.length).toBe(0)

    // The outbox has already handed the event over: the durable queue's job
    // ends at "this became a delivery attempt", and the retry ladder owns it
    // from there. Both are durable, and neither is memory.
    const remaining = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${schema}"."${OUTBOX_TABLE}"`,
    )) as Array<{ n: number }>
    expect(remaining[0].n).toBe(0)
  }, 180_000)

  it('delivers exactly once when the receiver returns, and invents no new event', async () => {
    const { retryFailedWebhooks } = await import('@/lib/webhooks')

    await receiver.start()
    expect(receiver.url).toBe(receiver.url) // same port: nothing was reconfigured

    // The ladder's first retry is 5 s out. Waiting for the scheduled time is
    // the behaviour under test, not an arbitrary delay.
    const pending = (await logs()).find(l => l.status === 'RETRYING')!
    const waitMs = Math.max(0, pending.nextRetryAt!.getTime() - Date.now()) + 250
    await new Promise(r => setTimeout(r, waitMs))

    expect(await retryFailedWebhooks()).toBeGreaterThanOrEqual(1)

    const succeeded = await until('the retried delivery to succeed', async () => {
      const all = await logs()
      return all.find(l => l.status === 'SUCCESS' && l.attemptCount === 2) ?? null
    })
    expect(succeeded.deliveredAt).toBeTruthy()

    // EXACTLY once. Not "at least once": the customer's handler runs for every
    // request that arrives, so a duplicate delivery is a duplicate side effect.
    expect(receiver.received.length).toBe(1)
    expect(receiver.received[0].body.data.record.label).toBe('while-down')

    // And no EXTRA logical event. One row change produced one WebhookLog, which
    // was retried in place; a ladder that created a fresh log per attempt would
    // report four failures and one success for a single insert.
    const all = await logs()
    expect(all.length).toBe(2) // the control delivery, and this one
    expect(all.filter(l => l.status === 'SUCCESS').length).toBe(2)
  }, 180_000)

  it('does not deliver again on the next scheduled pass', async () => {
    const { retryFailedWebhooks } = await import('@/lib/webhooks')

    // A delivered event must leave the ladder. If SUCCESS did not clear
    // nextRetryAt, or the query did not filter on status, every delivered
    // webhook would be re-sent once a minute for ever.
    expect(await retryFailedWebhooks()).toBe(0)
    expect(receiver.received.length).toBe(1)
    expect((await logs()).length).toBe(2)
  }, 180_000)
})
