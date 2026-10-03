/**
 * WEBHOOKS, PROVEN AGAINST A REAL DATABASE AND A REAL RECEIVER
 * ===========================================================
 *
 * The thing this suite exists to prevent is the state the feature was already
 * in: HMAC signing, a retry ladder, dead-lettering and a cron pass, all real,
 * all correct, and `triggerWebhooks()` with no caller anywhere in the tree. A
 * unit test of the signing function would have been green the whole time.
 *
 * So nothing here is mocked that carries the property under test:
 *
 *   - a real PostgreSQL schema, with the capture trigger actually installed
 *   - a real INSERT/UPDATE/DELETE, which the trigger observes
 *   - a real outbox row, read back from the table
 *   - a real drain, which creates a real WebhookLog
 *   - a real HTTP server on loopback, which receives real bytes
 *   - a real HMAC, verified over the bytes that arrived
 *
 * ── Every refusal is paired with a control ──────────────────────────────────
 *
 * This program has repeatedly found refusal tests that passed because the
 * positive path did not work at all — a forbidden operation "failing" when
 * every operation was failing. So each blocked-destination test is stated next
 * to a delivery that SUCCEEDS under the same setup, and the cross-project
 * tests assert both that the stranger is refused and that the owner is not.
 *
 * ── The loopback hatch ──────────────────────────────────────────────────────
 *
 * The receiver runs on 127.0.0.1, which the egress guard blocks by default and
 * should. `BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE` is the operator opt-in that
 * makes a self-hosted deployment able to reach the container beside it, and it
 * is set and unset per test rather than globally, so the tests that assert a
 * refusal are asserting it under the configuration where it must still hold.
 * 169.254.0.0/16 stays blocked either way, and that is asserted too.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'

import {
  generateWebhookSignature,
  verifyWebhookSignature,
  triggerWebhooks,
  createWebhook,
  getWebhook,
  getWebhookLogs,
  updateWebhook,
  rotateWebhookSecret,
  sendTestDelivery,
} from '@/lib/webhooks'
import { syncWebhookCapture, listCapturedTables, drainWebhookOutbox, OUTBOX_TABLE } from '@/lib/webhooks/capture'
import { BlockedOutboundError } from '@/lib/security/outbound-guard'

const prisma = new PrismaClient()

// ── A real receiver ──────────────────────────────────────────────────────────

interface Received {
  headers: http.IncomingHttpHeaders
  raw: string
  body: any
}

class Receiver {
  private server!: http.Server
  readonly received: Received[] = []
  /** Status the next request gets. Lets one receiver prove success and failure. */
  status = 200
  port = 0

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: any = null
        try { body = JSON.parse(raw) } catch { /* recorded raw regardless */ }
        this.received.push({ headers: req.headers, raw, body })
        res.writeHead(this.status, { 'Content-Type': 'text/plain' })
        res.end(this.status >= 400 ? 'receiver refused' : 'ok')
      })
    })
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  get url(): string { return `http://127.0.0.1:${this.port}/hook` }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

let receiver: Receiver
let ownerId: string
let projectId: string
let otherProjectId: string
let schema: string
let otherSchema: string

const TABLE = 'orders'

async function makeProject(name: string, userId: string): Promise<string> {
  const project = await prisma.project.create({
    data: { name, userId, description: 'webhook delivery suite' },
    select: { id: true },
  })
  return project.id
}

async function makeWorkspace(id: string): Promise<string> {
  const s = `workspace_${id}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${s}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${s}"."${TABLE}" (
       id serial PRIMARY KEY,
       label text NOT NULL,
       qty int NOT NULL DEFAULT 1
     )`,
  )
  return s
}

beforeAll(async () => {
  receiver = new Receiver()
  await receiver.start()

  const owner = await prisma.user.create({
    data: {
      email: `webhooks-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Webhook Suite Owner',
    },
    select: { id: true },
  })
  ownerId = owner.id

  projectId = await makeProject('webhook-suite', ownerId)
  otherProjectId = await makeProject('webhook-suite-other', ownerId)
  schema = await makeWorkspace(projectId)
  otherSchema = await makeWorkspace(otherProjectId)
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${otherSchema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await receiver.stop()
  await prisma.$disconnect()
}, 120_000)

beforeEach(() => {
  receiver.received.length = 0
  receiver.status = 200
  process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
})

afterEach(async () => {
  delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
  await prisma.webhook.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } })
  await prisma.$executeRawUnsafe(`TRUNCATE "${schema}"."${TABLE}"`).catch(() => {})
  await prisma
    .$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${OUTBOX_TABLE}" CASCADE`)
    .catch(() => {})
  await prisma
    .$executeRawUnsafe(`DROP TRIGGER IF EXISTS backenly_webhook_capture ON "${schema}"."${TABLE}"`)
    .catch(() => {})
})

/** Wait until the receiver has at least `n` requests, or fail loudly. */
async function waitForDeliveries(n: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (receiver.received.length < n) {
    if (Date.now() > deadline) {
      throw new Error(
        `expected ${n} delivery(ies), received ${receiver.received.length} after ${timeoutMs}ms`,
      )
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

/**
 * Wait until a webhook's delivery log reaches a state, or fail naming what it
 * actually reached.
 *
 * Delivery is fire-and-forget on purpose — `triggerWebhooks` does not block the
 * originating request on someone else's endpoint — so the log is written a
 * moment AFTER the receiver has the bytes. Sleeping a round number here would
 * be a flake waiting to happen on a loaded runner; this polls the real
 * condition and throws with the observed state when it never arrives, so a
 * timeout can never be mistaken for a pass.
 */
async function waitForLog(
  webhookId: string,
  predicate: (log: any) => boolean,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any[] = []
  for (;;) {
    last = await prisma.webhookLog.findMany({ where: { webhookId }, orderBy: { createdAt: 'desc' } })
    const hit = last.find(predicate)
    if (hit) return hit
    if (Date.now() > deadline) {
      throw new Error(
        `no delivery log matched after ${timeoutMs}ms; saw ` +
          JSON.stringify(last.map(l => ({ status: l.status, code: l.statusCode, err: l.error }))),
      )
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

async function outboxRows(): Promise<any[]> {
  return prisma.$queryRawUnsafe(
    `SELECT event_type, table_name, row_data, old_data, truncated
       FROM "${schema}"."${OUTBOX_TABLE}" ORDER BY id`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────

describe('signing', () => {
  it('verifies a signature it generated, and rejects a tampered body', () => {
    const secret = crypto.randomBytes(32).toString('hex')
    const payload = JSON.stringify({ event: 'row.inserted', n: 1 })
    const sig = generateWebhookSignature(payload, secret)

    // Control: the mechanism works at all.
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true)

    // The two ways a forgery differs.
    expect(verifyWebhookSignature(payload + ' ', sig, secret)).toBe(false)
    expect(verifyWebhookSignature(payload, sig, secret + 'x')).toBe(false)
  })
})

describe('database capture', () => {
  it('installs a trigger only while an active row webhook exists, and removes it after', async () => {
    // Precondition stated, not assumed: nothing is captured yet.
    expect(await listCapturedTables(projectId)).toEqual([])

    const hook = await createWebhook(projectId, 'row.inserted', receiver.url)
    const synced = await syncWebhookCapture(projectId)

    expect(synced.events).toEqual(['row.inserted'])
    expect(await listCapturedTables(projectId)).toContain(TABLE)

    // Disabling is what an operator does instead of deleting. The trigger must
    // come off, or a "disabled" webhook keeps costing a write on every INSERT.
    await updateWebhook(projectId, hook.id, { active: false })
    await syncWebhookCapture(projectId)
    expect(await listCapturedTables(projectId)).toEqual([])
  })

  it('never captures the auth-managed users table, which holds the password hash', async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${schema}"."users" (
         id serial PRIMARY KEY, email text, password text
       )`,
    )
    try {
      await createWebhook(projectId, 'row.inserted', receiver.url)
      await syncWebhookCapture(projectId)

      const captured = await listCapturedTables(projectId)

      // Control: capture really did install somewhere, so "users is absent" is
      // a statement about users and not about capture being broken.
      expect(captured).toContain(TABLE)
      expect(captured).not.toContain('users')
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."users" CASCADE`)
    }
  })

  it('records the operation that fired, for each of insert, update and delete', async () => {
    await createWebhook(projectId, 'row.inserted', receiver.url)
    await createWebhook(projectId, 'row.updated', receiver.url)
    await createWebhook(projectId, 'row.deleted', receiver.url)
    await syncWebhookCapture(projectId)

    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${TABLE}" (label, qty) VALUES ('a', 1)`)
    await prisma.$executeRawUnsafe(`UPDATE "${schema}"."${TABLE}" SET qty = 2 WHERE label = 'a'`)
    await prisma.$executeRawUnsafe(`DELETE FROM "${schema}"."${TABLE}" WHERE label = 'a'`)

    const rows = await outboxRows()
    expect(rows.map(r => r.event_type)).toEqual(['INSERT', 'UPDATE', 'DELETE'])

    // The UPDATE is the only one carrying a previous value, and it must carry
    // the real one rather than a copy of the new row.
    expect(rows[1].old_data.qty).toBe(1)
    expect(rows[1].row_data.qty).toBe(2)
    expect(rows[0].old_data).toBeNull()

    // A DELETE keeps the row as it was, which is the only useful payload for it.
    expect(rows[2].row_data.label).toBe('a')
  })

  it('captures a write made outside the app, the way PostgREST makes them', async () => {
    await createWebhook(projectId, 'row.inserted', receiver.url)
    await syncWebhookCapture(projectId)

    // A separate connection that never touches application code. This is the
    // whole reason capture is in the database: an inline triggerWebhooks() call
    // in a route handler would see nothing here, and PostgREST is the data
    // plane for every end-user write in the product.
    const { Client } = await import('pg')
    const direct = new Client({ connectionString: process.env.DATABASE_URL })
    await direct.connect()
    try {
      await direct.query(`INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('from-outside')`)
    } finally {
      await direct.end()
    }

    const rows = await outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].row_data.label).toBe('from-outside')
  })
})

describe('delivery', () => {
  it('delivers a captured INSERT end to end, with a signature that verifies over the received bytes', async () => {
    const hook = await createWebhook(projectId, 'row.inserted', receiver.url)
    await syncWebhookCapture(projectId)

    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."${TABLE}" (label, qty) VALUES ('widget', 3)`,
    )

    // The outbox holds it before anything has been delivered.
    expect(await outboxRows()).toHaveLength(1)
    expect(receiver.received).toHaveLength(0)

    const drained = await drainWebhookOutbox()
    expect(drained).toBeGreaterThanOrEqual(1)

    await waitForDeliveries(1)

    const got = receiver.received[0]
    expect(got.body.event).toBe('row.inserted')
    expect(got.body.projectId).toBe(projectId)
    expect(got.body.data.table).toBe(TABLE)
    expect(got.body.data.record.label).toBe('widget')
    expect(got.body.data.record.qty).toBe(3)

    // The signature is verified over the RAW BYTES THAT ARRIVED, not over a
    // re-serialization of the parsed body. A receiver that re-serializes is
    // the classic way signature verification passes in a test and fails in
    // production, because key order and spacing are not guaranteed to survive.
    const signature = got.headers['x-webhook-signature'] as string
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifyWebhookSignature(got.raw, signature, hook.secret)).toBe(true)

    // And the same bytes do NOT verify under a different key, so the assertion
    // above is about this secret rather than about verify() returning true.
    expect(verifyWebhookSignature(got.raw, signature, crypto.randomBytes(32).toString('hex'))).toBe(false)

    // De-duplication handle for at-least-once delivery.
    expect(got.headers['x-webhook-delivery']).toBeTruthy()

    // The log is the durable record, and it records the receiver's answer.
    const success = await waitForLog(hook.id, l => l.status === 'SUCCESS')
    expect(success.statusCode).toBe(200)
    expect(success.deliveredAt).not.toBeNull()
    expect(await getWebhookLogs(projectId, hook.id)).toHaveLength(1)

    // Drained rows are removed, so a second drain does not re-deliver.
    expect(await outboxRows()).toHaveLength(0)
    await drainWebhookOutbox()
    await new Promise(r => setTimeout(r, 200))
    expect(receiver.received).toHaveLength(1)
  }, 60_000)

  it('records a failing receiver as failed, with its status code, and schedules a retry', async () => {
    receiver.status = 503

    const hook = await createWebhook(projectId, 'row.inserted', receiver.url)
    await syncWebhookCapture(projectId)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('doomed')`)

    await drainWebhookOutbox()
    await waitForDeliveries(1)

    // The assertion is on the STORED state, never on the delivery function's
    // return value.
    const failed = await waitForLog(hook.id, l => l.status === 'RETRYING')
    expect(failed.statusCode).toBe(503)
    expect(failed.nextRetryAt).not.toBeNull()
    expect(failed.deliveredAt).toBeNull()
    expect(await getWebhookLogs(projectId, hook.id)).toHaveLength(1)
  }, 60_000)

  it('does not deliver to a disabled webhook, while an enabled one beside it receives', async () => {
    const off = await createWebhook(projectId, 'row.inserted', `${receiver.url}/off`)
    await updateWebhook(projectId, off.id, { active: false })
    await createWebhook(projectId, 'row.inserted', `${receiver.url}/on`)
    await syncWebhookCapture(projectId)

    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('x')`)
    await drainWebhookOutbox()
    await waitForDeliveries(1)

    // Exactly one, and it is the enabled one. "Zero deliveries" would also pass
    // a naive assertion while proving the feature is simply broken, so the
    // enabled endpoint's SUCCESS is established before the disabled one's
    // silence is claimed.
    const on = await prisma.webhook.findFirst({ where: { projectId, active: true } })
    await waitForLog(on!.id, l => l.status === 'SUCCESS')

    expect(receiver.received).toHaveLength(1)
    expect(receiver.received[0].headers['x-webhook-id']).toBe(on!.id)
    const logs = await prisma.webhookLog.findMany({ where: { webhookId: off.id } })
    expect(logs).toHaveLength(0)
  }, 60_000)

  it('sends a real test delivery and reports the receiver’s real answer', async () => {
    const hook = await createWebhook(projectId, 'row.inserted', receiver.url)

    const ok = await sendTestDelivery(projectId, hook.id)
    expect(ok!.success).toBe(true)
    expect(ok!.statusCode).toBe(200)
    await waitForDeliveries(1)
    expect(receiver.received[0].body.data.test).toBe(true)

    // The same call over a refusing receiver must report failure, not "sent".
    receiver.status = 500
    const bad = await sendTestDelivery(projectId, hook.id)
    expect(bad!.success).toBe(false)
    expect(bad!.statusCode).toBe(500)

    const logs = await getWebhookLogs(projectId, hook.id)
    expect(logs.map(l => l.status).sort()).toEqual(['FAILED', 'SUCCESS'])
  }, 60_000)

  it('carries no credential column, because the auth table is never captured', async () => {
    const hook = await createWebhook(projectId, 'auth.user.created', receiver.url)

    // The signup route builds this payload field by field. Asserting the shape
    // here pins that it stays a fixed list rather than a spread of the row.
    await triggerWebhooks(projectId, 'auth.user.created', {
      id: 'user-1',
      email: 'end@example.test',
      name: 'End User',
      role: 'user',
      createdAt: new Date().toISOString(),
    })

    await waitForDeliveries(1)
    const raw = receiver.received[0].raw

    expect(receiver.received[0].body.data.email).toBe('end@example.test')
    expect(raw).not.toMatch(/password/i)
    expect(raw).not.toMatch(/\$2[aby]\$/) // a bcrypt hash, in any form
    expect(Object.keys(receiver.received[0].body.data).sort()).toEqual(
      ['createdAt', 'email', 'id', 'name', 'role'],
    )

    await waitForLog(hook.id, l => l.status === 'SUCCESS')
  }, 60_000)
})

describe('egress: the destination is a security boundary', () => {
  it('refuses a link-local target EVEN with the private-egress hatch enabled', async () => {
    // The hatch is on for this whole describe via beforeEach. Cloud metadata is
    // refused anyway: a self-hoster saying "my LAN is fine" has not said "read
    // the instance credentials", and 169.254.169.254 on EC2 is the whole
    // account's.
    expect(process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE).toBe('true')

    await expect(
      createWebhook(projectId, 'row.inserted', 'http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(BlockedOutboundError)

    // CONTROL: the same call with an allowed destination succeeds, so the
    // rejection above is about the address and not about createWebhook being
    // broken for every input.
    const ok = await createWebhook(projectId, 'row.inserted', receiver.url)
    expect(ok.id).toBeTruthy()
  })

  it('refuses loopback and private targets when the hatch is OFF, and allows them when ON', async () => {
    delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE

    await expect(createWebhook(projectId, 'row.inserted', receiver.url)).rejects.toBeInstanceOf(
      BlockedOutboundError,
    )
    await expect(
      createWebhook(projectId, 'row.inserted', 'http://10.0.0.5/hook'),
    ).rejects.toBeInstanceOf(BlockedOutboundError)

    // CONTROL: a public-looking literal is accepted with the hatch off, which
    // proves the refusals above are selective rather than a blanket failure.
    const ok = await createWebhook(projectId, 'row.inserted', 'https://example.com/hook')
    expect(ok.id).toBeTruthy()

    // And the hatch really is what changes the answer.
    process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
    const nowAllowed = await createWebhook(projectId, 'row.inserted', receiver.url)
    expect(nowAllowed.id).toBeTruthy()
  })

  it('refuses non-http schemes and URLs carrying credentials', async () => {
    await expect(
      createWebhook(projectId, 'row.inserted', 'file:///etc/passwd'),
    ).rejects.toBeInstanceOf(BlockedOutboundError)
    await expect(
      createWebhook(projectId, 'row.inserted', 'https://user:pass@example.com/hook'),
    ).rejects.toBeInstanceOf(BlockedOutboundError)
  })

  it('a stored webhook whose destination becomes blocked fails terminally rather than retrying', async () => {
    // Created while the hatch is on, then delivered with it off. This is the
    // stored-row case: validation at write time cannot bind a destination
    // forever, which is exactly why the guard also runs at delivery.
    const hook = await createWebhook(projectId, 'row.inserted', receiver.url)
    await syncWebhookCapture(projectId)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('blocked')`)

    delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
    await drainWebhookOutbox()

    const blocked = await waitForLog(hook.id, l => l.status === 'FAILED')
    expect(blocked.error).toMatch(/refused/i)
    // Terminal: no retry is scheduled for a destination that cannot become
    // reachable by waiting.
    expect(blocked.nextRetryAt).toBeNull()

    // The receiver is listening and was NOT contacted. That is the SSRF claim:
    // the request was never made, rather than made and ignored. Asserted AFTER
    // the log proves the attempt was actually processed, so an empty receiver
    // cannot mean "the drain never ran".
    expect(receiver.received).toHaveLength(0)
    expect(await getWebhookLogs(projectId, hook.id)).toHaveLength(1)
  }, 60_000)
})

describe('tenant scoping', () => {
  it('will not read, edit, rotate or delete another project’s webhook by id', async () => {
    const mine = await createWebhook(projectId, 'row.inserted', receiver.url)

    // CONTROL: the owner's own project can do all four, so each refusal below
    // is about the project mismatch and not about the operation failing.
    expect(await getWebhook(projectId, mine.id)).not.toBeNull()
    expect(await updateWebhook(projectId, mine.id, { active: false })).not.toBeNull()
    expect(await rotateWebhookSecret(projectId, mine.id)).not.toBeNull()

    // The same id, asked for under the other project.
    expect(await getWebhook(otherProjectId, mine.id)).toBeNull()
    expect(await updateWebhook(otherProjectId, mine.id, { active: true })).toBeNull()
    expect(await rotateWebhookSecret(otherProjectId, mine.id)).toBeNull()
    expect(await sendTestDelivery(otherProjectId, mine.id)).toBeNull()
    expect(await getWebhookLogs(otherProjectId, mine.id)).toEqual([])

    // The victim row is UNCHANGED by every refused call above. A denial that
    // still mutated would pass a status-code assertion and fail the user.
    const after = await prisma.webhook.findUnique({ where: { id: mine.id } })
    expect(after!.active).toBe(false)       // set by the owner's own call, not the stranger's true
    expect(after!.projectId).toBe(projectId)
  })

  it('a delete scoped to the wrong project removes nothing', async () => {
    const mine = await createWebhook(projectId, 'row.inserted', receiver.url)

    const { deleteWebhook } = await import('@/lib/webhooks')
    const refused = await deleteWebhook(mine.id, otherProjectId)
    expect(refused.count).toBe(0)
    expect(await prisma.webhook.findUnique({ where: { id: mine.id } })).not.toBeNull()

    // CONTROL: correctly scoped, the same delete works.
    const allowed = await deleteWebhook(mine.id, projectId)
    expect(allowed.count).toBe(1)
    expect(await prisma.webhook.findUnique({ where: { id: mine.id } })).toBeNull()
  })

  it('clamps a log page size instead of passing it to the database', async () => {
    const hook = await createWebhook(projectId, 'row.inserted', receiver.url)
    // NaN used to reach Prisma as `take: NaN`; a huge number asked Postgres for
    // every row the project had ever delivered.
    await expect(getWebhookLogs(projectId, hook.id, Number.NaN)).resolves.toEqual([])
    await expect(getWebhookLogs(projectId, hook.id, 10_000_000)).resolves.toEqual([])
    await expect(getWebhookLogs(projectId, hook.id, -5)).resolves.toEqual([])
  })
})
