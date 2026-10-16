/**
 * A REGIONAL PROJECT'S CUSTOMER DATA ON PLATFORM ROWS STAYS IN ITS REGION
 * =======================================================================
 * A webhook or trigger delivery carries the row that fired it and records what
 * the receiver answered; a function run records what the function logged and
 * the error it raised (lib/data-plane/regional-bodies.ts). This suite creates a
 * second database as the stand-in for another region's, installs the real
 * regional table there (scripts/sql/regional-bodies.sql), and pins:
 *
 *   regional project   the platform row has no payload, reply, logs or error
 *                      text; all of it is in the region, and nowhere in the
 *                      home database
 *   home project       its rows are written exactly as before
 *   retry and replay   send the event read from the region; a body past its
 *                      retention fails the retry honestly instead
 *   listings           show the region's data to whoever asks
 *   trigger failures   the platform row says only the HTTP status; the
 *                      receiver's words stay in the region
 *   function errors    the row keeps the platform's own prefix, which the
 *                      self-heal guards read, and none of the text
 *   retention          the region prunes 30 days after the last change; home
 *                      has nothing there to prune
 *
 * Real databases, a real receiver on loopback, real HMACs: nothing that
 * carries the property is mocked.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from 'pg'

// The summarizer's one model call, answered here: what it says is the
// property, not which model says it. Everything else in the module is real.
const mockGenerate = jest.fn()
jest.mock('@/lib/ai/llm', () => ({
  ...jest.requireActual('@/lib/ai/llm'),
  generate: (...args: unknown[]) => mockGenerate(...args),
}))

import { prisma } from '@/lib/db'
import { loadHistory, saveMessages } from '@/app/api/ai/chat/pipeline/conversation-store'
import { MESSAGE_KEPT_IN_REGION, createConversationMessage, deleteConversationMessages } from '@/lib/ai/conversation-content'
import { maybeSummarizeConversation } from '@/lib/ai/conversation-summarizer'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { fireTriggers, listDeliveryLogs, replayDelivery, withoutReply } from '@/lib/services/trigger-service'
import { failureWithoutReply, pruneRegionalBodies } from '@/lib/data-plane/regional-bodies'
import {
  ERROR_KEPT_IN_REGION,
  deleteFunctionRuns,
  recordFunctionRun,
  rowLastError,
  withLastErrors,
  withRunBodies,
} from '@/lib/services/ai-functions/run-records'
import {
  createWebhook,
  getWebhookLogs,
  redeliverWebhookLog,
  retryFailedWebhooks,
  sendTestDelivery,
  triggerWebhooks,
  verifyWebhookSignature,
} from '@/lib/webhooks'

jest.setTimeout(120_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_bodies_${randomBytes(4).toString('hex')}`

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}
const regionalUrl = urlFor(REGIONAL_DB)

async function run(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end().catch(() => {})
  }
}

async function rowsIn<T>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

interface Body {
  kind: string
  projectId: string
  payload: any
  responseBody: string | null
  error: string | null
}
const regionalBody = async (id: string) =>
  (await rowsIn<Body>(regionalUrl, 'SELECT "kind", "projectId", "payload", "responseBody", "error" FROM public.regional_bodies WHERE "id" = $1', [id]))[0]

/** Every row, payload and reply in the home database that mentions a marker. */
async function homeMentions(marker: string): Promise<number> {
  const [webhooks] = await rowsIn<{ n: string }>(
    homeUrl(),
    `SELECT count(*)::text AS n FROM webhook_logs WHERE payload::text LIKE $1 OR "responseBody" LIKE $1 OR error LIKE $1`,
    [`%${marker}%`],
  )
  const [triggers] = await rowsIn<{ n: string }>(
    homeUrl(),
    `SELECT count(*)::text AS n FROM trigger_delivery_logs WHERE payload::text LIKE $1 OR error LIKE $1`,
    [`%${marker}%`],
  )
  const [runs] = await rowsIn<{ n: string }>(
    homeUrl(),
    `SELECT count(*)::text AS n FROM ai_function_logs WHERE array_to_string(logs, ' ') LIKE $1 OR error LIKE $1`,
    [`%${marker}%`],
  )
  const [functions] = await rowsIn<{ n: string }>(
    homeUrl(),
    `SELECT count(*)::text AS n FROM ai_functions WHERE "lastError" LIKE $1`,
    [`%${marker}%`],
  )
  return Number(webhooks.n) + Number(triggers.n) + Number(runs.n) + Number(functions.n)
}

const regionalBodyOf = async (kind: string, id: string) =>
  (await rowsIn<Body>(regionalUrl, 'SELECT "kind", "projectId", "payload", "responseBody", "error" FROM public.regional_bodies WHERE "kind" = $1 AND "id" = $2', [kind, id]))[0]

// ── A real receiver that quotes what it was sent when it refuses it ─────────

interface Received {
  headers: http.IncomingHttpHeaders
  raw: string
  body: any
}

class Receiver {
  private server!: http.Server
  readonly received: Received[] = []
  status = 200
  port = 0

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: any = null
        try { body = JSON.parse(raw) } catch { /* recorded raw regardless */ }
        this.received.push({ headers: req.headers, raw, body })
        res.writeHead(this.status, { 'Content-Type': 'text/plain' })
        // A refusing receiver that quotes the request back: the reply is the
        // customer's data too.
        res.end(this.status >= 400 ? `refused: ${raw}` : 'ok')
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  get url(): string { return `http://127.0.0.1:${this.port}/hook` }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

let receiver: Receiver
let ownerId = ''
let homeProject = ''
let regionalProject = ''
let regionalDbCreated = false

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')

  receiver = new Receiver()
  await receiver.start()

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  // The real table and grants, as the region's database procedure installs
  // them; backenly_app_role() names the role the application connects as.
  await run(regionalUrl, `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await run(regionalUrl, fs.readFileSync('scripts/sql/regional-bodies.sql', 'utf8'))
  process.env[REGION_VARIABLE] = regionalUrl

  const owner = await prisma.user.create({
    data: { email: `bodies-${randomUUID()}@example.test`, name: 'delivery bodies fixture' },
    select: { id: true },
  })
  ownerId = owner.id
  homeProject = (await prisma.project.create({ data: { name: `bodies-home-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id
  regionalProject = (
    await prisma.project.create({ data: { name: `bodies-region-${randomUUID()}`, userId: ownerId, region: 'us-east-1' }, select: { id: true } })
  ).id
})

afterAll(async () => {
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  delete process.env[REGION_VARIABLE]
  await disconnectRegionalClients().catch(() => {})
  if (regionalDbCreated) await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  await receiver.stop()
})

beforeEach(() => {
  receiver.received.length = 0
  receiver.status = 200
  process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
})

afterEach(async () => {
  delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
  await prisma.webhook.deleteMany({ where: { projectId: { in: [homeProject, regionalProject] } } })
  await prisma.appTrigger.deleteMany({ where: { projectId: { in: [homeProject, regionalProject] } } })
  await prisma.aiFunction.deleteMany({ where: { projectId: { in: [homeProject, regionalProject] } } })
})

// ── Endpoint webhooks ────────────────────────────────────────────────────────

describe('an endpoint webhook', () => {
  it("keeps a regional project's event and the receiver's reply in the region", async () => {
    const marker = `marker-${randomUUID()}`
    const webhook = await createWebhook(regionalProject, 'row.inserted', receiver.url)

    await triggerWebhooks(regionalProject, 'row.inserted', { email: `${marker}@example.test` })
    const log = await until(
      () => prisma.webhookLog.findFirst({ where: { webhookId: webhook.id } }),
      (row) => row?.status === 'SUCCESS',
    )

    expect(log).toEqual(expect.objectContaining({ status: 'SUCCESS', statusCode: 200, payload: null, responseBody: null }))
    expect(await regionalBody(log!.id)).toEqual(
      expect.objectContaining({ kind: 'webhook', projectId: regionalProject, responseBody: 'ok' }),
    )
    expect((await regionalBody(log!.id)).payload.data.email).toBe(`${marker}@example.test`)

    // The receiver got the event, signed over the bytes that arrived.
    expect(receiver.received).toHaveLength(1)
    expect(receiver.received[0].body.data.email).toBe(`${marker}@example.test`)
    expect(verifyWebhookSignature(receiver.received[0].raw, String(receiver.received[0].headers['x-webhook-signature']), webhook.secret)).toBe(true)

    // Nothing of it in the home database.
    expect(await homeMentions(marker)).toBe(0)
    const [table] = await rowsIn<{ t: string | null }>(homeUrl(), `SELECT to_regclass('public.regional_bodies')::text AS t`)
    expect(table.t).toBeNull()
  })

  it("keeps a home project's deliveries on the platform row, as before", async () => {
    const marker = `marker-${randomUUID()}`
    const webhook = await createWebhook(homeProject, 'row.inserted', receiver.url)

    await triggerWebhooks(homeProject, 'row.inserted', { note: marker })
    const log = await until(
      () => prisma.webhookLog.findFirst({ where: { webhookId: webhook.id } }),
      (row) => row?.status === 'SUCCESS',
    )

    expect((log!.payload as any).data.note).toBe(marker)
    expect(log!.responseBody).toBe('ok')
    expect(await regionalBody(log!.id)).toBeUndefined()
  })

  it('retries a regional delivery with the event kept in the region, and keeps its refusal there', async () => {
    const marker = `marker-${randomUUID()}`
    const webhook = await createWebhook(regionalProject, 'row.inserted', receiver.url)
    receiver.status = 500

    await triggerWebhooks(regionalProject, 'row.inserted', { note: marker })
    const failed = await until(
      () => prisma.webhookLog.findFirst({ where: { webhookId: webhook.id } }),
      (row) => row?.status === 'RETRYING',
    )
    expect(failed).toEqual(expect.objectContaining({ status: 'RETRYING', statusCode: 500, error: 'HTTP 500', payload: null, responseBody: null }))
    // The refusal quoted the event: it is kept with the body, in the region.
    expect((await regionalBody(failed!.id)).responseBody).toContain(marker)
    expect(await homeMentions(marker)).toBe(0)

    receiver.status = 200
    receiver.received.length = 0
    await prisma.webhookLog.update({ where: { id: failed!.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
    await retryFailedWebhooks()

    const retried = await prisma.webhookLog.findUnique({ where: { id: failed!.id } })
    expect(retried).toEqual(expect.objectContaining({ status: 'SUCCESS', payload: null, responseBody: null }))
    expect(receiver.received).toHaveLength(1)
    expect(receiver.received[0].body.data.note).toBe(marker)
    expect((await regionalBody(failed!.id)).responseBody).toBe('ok')
  })

  it('fails the retry honestly when the region no longer keeps the event', async () => {
    const webhook = await createWebhook(regionalProject, 'row.inserted', receiver.url)
    receiver.status = 500
    await triggerWebhooks(regionalProject, 'row.inserted', { note: 'expiring' })
    const failed = await until(
      () => prisma.webhookLog.findFirst({ where: { webhookId: webhook.id } }),
      (row) => row?.status === 'RETRYING',
    )

    await run(regionalUrl, `DELETE FROM public.regional_bodies WHERE "id" = '${failed!.id}'`)
    await prisma.webhookLog.update({ where: { id: failed!.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
    receiver.status = 200
    receiver.received.length = 0
    await retryFailedWebhooks()

    const after = await prisma.webhookLog.findUnique({ where: { id: failed!.id } })
    expect(after!.status).toBe('FAILED')
    expect(after!.error).toContain('no longer kept')
    expect(receiver.received).toHaveLength(0)
  })

  it("lists a regional delivery with its event and reply, read from the region", async () => {
    const marker = `marker-${randomUUID()}`
    const webhook = await createWebhook(regionalProject, 'row.inserted', receiver.url)
    await triggerWebhooks(regionalProject, 'row.inserted', { note: marker })
    await until(
      () => prisma.webhookLog.findFirst({ where: { webhookId: webhook.id } }),
      (row) => row?.status === 'SUCCESS',
    )

    const [listed] = await getWebhookLogs(regionalProject, webhook.id)
    expect((listed.payload as any).data.note).toBe(marker)
    expect(listed.responseBody).toBe('ok')
    // Read for the listing, not copied back.
    expect((await prisma.webhookLog.findUnique({ where: { id: listed.id } }))!.payload).toBeNull()
  })

  it('replays a failed regional delivery with the event kept in the region', async () => {
    const webhook = await createWebhook(regionalProject, 'row.inserted', receiver.url)
    receiver.status = 500
    const first = await sendTestDelivery(regionalProject, webhook.id)
    expect(first).toEqual(expect.objectContaining({ success: false }))
    expect(await prisma.webhookLog.findUnique({ where: { id: first!.logId } })).toEqual(
      expect.objectContaining({ status: 'FAILED', payload: null, responseBody: null }),
    )

    receiver.status = 200
    receiver.received.length = 0
    const replay = await redeliverWebhookLog(regionalProject, first!.logId)
    expect(replay).toEqual(expect.objectContaining({ replayOf: first!.logId, success: true }))
    expect(receiver.received).toHaveLength(1)
    expect(receiver.received[0].body.data.test).toBe(true)
  })
})

// ── Trigger webhooks ─────────────────────────────────────────────────────────

describe('a trigger webhook', () => {
  async function trigger(projectId: string) {
    return prisma.appTrigger.create({
      data: {
        projectId,
        name: `bodies-${randomUUID().slice(0, 8)}`,
        sourceTable: 'orders',
        event: 'insert',
        actionType: 'webhook',
        webhookUrl: receiver.url,
        webhookSecret: 'trigger-secret',
      },
    })
  }

  it("records a regional failure's HTTP status on the row and the receiver's words in the region", async () => {
    const marker = `marker-${randomUUID()}`
    const t = await trigger(regionalProject)
    receiver.status = 500

    await fireTriggers(regionalProject, { type: 'insert', table: 'orders', data: { note: marker } })
    const dead = await prisma.triggerDeliveryLog.findFirst({ where: { triggerId: t.id } })

    expect(dead).toEqual(expect.objectContaining({ status: 'DEAD', payload: null, error: 'Webhook returned 500' }))
    const body = await regionalBody(dead!.id)
    expect(body).toEqual(expect.objectContaining({ kind: 'trigger', projectId: regionalProject }))
    expect(body.payload.data.note).toBe(marker)
    expect(body.error).toContain(marker)
    expect(await homeMentions(marker)).toBe(0)

    // The owner's listing reads the full failure from the region.
    const [listed] = await listDeliveryLogs(regionalProject, { status: 'DEAD' })
    expect(listed.id).toBe(dead!.id)
    expect(listed.error).toContain(marker)

    // A replay sends the event kept in the region.
    receiver.status = 200
    receiver.received.length = 0
    expect(await replayDelivery(regionalProject, dead!.id)).toEqual({ success: true })
    expect(receiver.received).toHaveLength(1)
    expect(receiver.received[0].body.data.note).toBe(marker)
    expect((await regionalBody(dead!.id)).error).toBeNull()
  })

  it('keeps a home project failure on the row, as before', async () => {
    const marker = `marker-${randomUUID()}`
    const t = await trigger(homeProject)
    receiver.status = 500

    await fireTriggers(homeProject, { type: 'insert', table: 'orders', data: { note: marker } })
    const dead = await prisma.triggerDeliveryLog.findFirst({ where: { triggerId: t.id } })

    expect((dead!.payload as any).data.note).toBe(marker)
    expect(dead!.error).toContain(marker)
    expect(await regionalBody(dead!.id)).toBeUndefined()
  })
})

// ── Function runs ────────────────────────────────────────────────────────────

describe('a function run', () => {
  async function fn(projectId: string) {
    return prisma.aiFunction.create({
      data: {
        projectId,
        name: `bodies_fn_${randomUUID().slice(0, 8)}`,
        description: 'regional bodies fixture',
        generatedCode: 'ctx.log("hello")',
        triggerType: 'manual',
      },
    })
  }

  it("keeps a regional run's logs and error in the region, and lists them from there", async () => {
    const marker = `marker-${randomUUID()}`
    const f = await fn(regionalProject)

    await recordFunctionRun({
      functionId: f.id, projectId: regionalProject, success: false,
      logs: [`loaded customer ${marker}@example.test`], error: `TypeError: bad row ${marker}`,
      durationMs: 12, triggerType: 'manual',
    })

    const [row] = await prisma.aiFunctionLog.findMany({ where: { functionId: f.id } })
    expect(row).toEqual(expect.objectContaining({ success: false, logs: [], error: null, durationMs: 12, triggerType: 'manual' }))
    const body = await regionalBodyOf('function_run', row.id)
    expect(body.payload).toEqual([`loaded customer ${marker}@example.test`])
    expect(body.error).toContain(marker)
    expect(await homeMentions(marker)).toBe(0)

    const [listed] = await withRunBodies(regionalProject, [row])
    expect(listed.logs).toEqual([`loaded customer ${marker}@example.test`])
    expect(listed.error).toContain(marker)

    // Clearing the logs clears what the region keeps of them.
    expect(await deleteFunctionRuns(regionalProject, f.id)).toBe(1)
    expect(await regionalBodyOf('function_run', row.id)).toBeUndefined()
  })

  it('keeps a home run on the platform row, as before', async () => {
    const marker = `marker-${randomUUID()}`
    const f = await fn(homeProject)

    await recordFunctionRun({
      functionId: f.id, projectId: homeProject, success: false,
      logs: [`saw ${marker}`], error: `failed on ${marker}`, durationMs: 3, triggerType: 'manual',
    })

    const [row] = await prisma.aiFunctionLog.findMany({ where: { functionId: f.id } })
    expect(row.logs).toEqual([`saw ${marker}`])
    expect(row.error).toBe(`failed on ${marker}`)
    expect(await regionalBodyOf('function_run', row.id)).toBeUndefined()
  })

  it("keeps a regional function's last error in the region and only the platform's prefix on the row", async () => {
    const marker = `marker-${randomUUID()}`
    const f = await fn(regionalProject)

    const rowError = await rowLastError(regionalProject, f.id, `AUTO-FIX-FAILED: Could not generate a fix for: ${marker}`, 'AUTO-FIX-FAILED: ')
    expect(rowError).toBe(`AUTO-FIX-FAILED: ${ERROR_KEPT_IN_REGION}`)
    // The self-heal guard reads the prefix from the row, without the region.
    expect(rowError!.startsWith('AUTO-FIX')).toBe(true)
    await prisma.aiFunction.update({ where: { id: f.id }, data: { lastError: rowError, status: 'error' } })
    expect((await regionalBodyOf('function_error', f.id)).error).toContain(marker)
    expect(await homeMentions(marker)).toBe(0)

    const [shown] = await withLastErrors(regionalProject, [await prisma.aiFunction.findUniqueOrThrow({ where: { id: f.id } })])
    expect(shown.lastError).toBe(`AUTO-FIX-FAILED: Could not generate a fix for: ${marker}`)

    expect(await rowLastError(regionalProject, f.id, null)).toBeNull()
    expect(await regionalBodyOf('function_error', f.id)).toBeUndefined()
  })

  it("keeps a home function's last error on the row, as before", async () => {
    const f = await fn(homeProject)
    expect(await rowLastError(homeProject, f.id, 'TypeError: x', 'AUTO-FIX-FAILED: ')).toBe('TypeError: x')
    expect(await regionalBodyOf('function_error', f.id)).toBeUndefined()
  })
})

// ── Deletion ─────────────────────────────────────────────────────────────────

describe('deleting a regional project', () => {
  it('deletes what its region keeps of its platform rows, and nothing of another project', async () => {
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const doomed = (
      await prisma.project.create({ data: { name: `bodies-doomed-${randomUUID()}`, userId: ownerId, region: 'us-east-1' }, select: { id: true } })
    ).id
    const mine = randomUUID()
    const theirs = randomUUID()
    await run(
      regionalUrl,
      `INSERT INTO public.regional_bodies ("kind", "id", "projectId", "payload")
       VALUES ('webhook', '${mine}', '${doomed}', '{}'::jsonb), ('webhook', '${theirs}', '${regionalProject}', '{}'::jsonb)`,
    )

    await deleteProjectCompletely(doomed)

    expect(await regionalBodyOf('webhook', mine)).toBeUndefined()
    expect(await regionalBodyOf('webhook', theirs)).toBeDefined()
  })
})

// ── Conversations ────────────────────────────────────────────────────────────

describe("the agent's conversation", () => {
  const EMAIL = `alice-${randomBytes(3).toString('hex')}@example.com`
  const conversationRows = (projectId: string) =>
    prisma.conversationMessage.findMany({ where: { projectId }, orderBy: { messageSeq: 'asc' } })

  afterEach(async () => {
    await prisma.conversationMessage.deleteMany({ where: { projectId: { in: [homeProject, regionalProject] } } })
    await run(regionalUrl, `DELETE FROM public.regional_bodies WHERE "kind" = 'conversation_message'`)
    mockGenerate.mockReset()
  })

  it("keeps a regional project's words in the region, and reads them back from there", async () => {
    await saveMessages(regionalProject, `Block ${EMAIL}`, `Blocked ${EMAIL}.`, randomUUID())

    const rows = await conversationRows(regionalProject)
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['user', MESSAGE_KEPT_IN_REGION],
      ['ai', MESSAGE_KEPT_IN_REGION],
    ])
    expect((await regionalBodyOf('conversation_message', rows[0].id))?.payload).toEqual({ content: `Block ${EMAIL}` })
    expect((await regionalBodyOf('conversation_message', rows[1].id))?.payload).toEqual({ content: `Blocked ${EMAIL}.` })
    const [mentions] = await rowsIn<{ n: string }>(
      homeUrl(),
      `SELECT count(*)::text AS n FROM "ConversationMessage" WHERE content LIKE $1 OR metadata::text LIKE $1`,
      [`%${EMAIL}%`],
    )
    expect(mentions.n).toBe('0')

    const { history } = await loadHistory(regionalProject)
    expect(history).toEqual([
      { role: 'user', content: `Block ${EMAIL}` },
      { role: 'assistant', content: `Blocked ${EMAIL}.` },
    ])
  })

  it("keeps a home project's words on the row, as before", async () => {
    await saveMessages(homeProject, `Block ${EMAIL}`, `Blocked ${EMAIL}.`, randomUUID())
    expect((await conversationRows(homeProject)).map((row) => row.content)).toEqual([`Block ${EMAIL}`, `Blocked ${EMAIL}.`])
    expect((await loadHistory(homeProject)).history.map((turn) => turn.content)).toEqual([`Block ${EMAIL}`, `Blocked ${EMAIL}.`])
  })

  // Written directly, not through saveMessages, so no background summary runs
  // alongside the one each test calls for.
  async function conversationOf(projectId: string, turns: number, ask: (i: number) => string): Promise<void> {
    for (let i = 0; i < turns; i++) {
      await createConversationMessage({ projectId, role: 'user', content: ask(i) })
      await createConversationMessage({ projectId, role: 'ai', content: `answer ${i}` })
    }
  }

  it('makes the summary from the words in the region, and keeps it there', async () => {
    await conversationOf(regionalProject, 11, (i) => `question ${i} from ${EMAIL}`)
    mockGenerate.mockResolvedValue({
      json: { builtSoFar: ['notes table'], decisions: [], userPreferences: [], currentFocus: `notes for ${EMAIL}` },
    })

    await maybeSummarizeConversation(regionalProject)

    // The model was shown the conversation itself, read from the region.
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockGenerate.mock.calls[0])).toContain(`question 10 from ${EMAIL}`)
    const summary = await prisma.conversationMessage.findFirst({ where: { projectId: regionalProject, role: 'summary' } })
    expect(summary?.content).toBe(MESSAGE_KEPT_IN_REGION)
    expect(JSON.stringify((await regionalBodyOf('conversation_message', summary!.id))?.payload)).toContain(`notes for ${EMAIL}`)
    expect((await loadHistory(regionalProject)).summaryContext).toContain(`notes for ${EMAIL}`)
  })

  it('makes no summary, and loads no history, while the region cannot be read', async () => {
    await conversationOf(regionalProject, 11, (i) => `question ${i}`)
    delete process.env[REGION_VARIABLE]
    try {
      await expect(maybeSummarizeConversation(regionalProject)).rejects.toMatchObject({ code: 'REGION_NOT_CONFIGURED' })
      expect(await loadHistory(regionalProject)).toEqual({ history: [], summaryContext: '' })
    } finally {
      process.env[REGION_VARIABLE] = regionalUrl
    }
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(await prisma.conversationMessage.count({ where: { projectId: regionalProject, role: 'summary' } })).toBe(0)
  })

  it('deletes the words in the region with their messages', async () => {
    await saveMessages(regionalProject, 'to be deleted', 'gone', randomUUID())
    const ids = (await conversationRows(regionalProject)).map((row) => row.id)

    expect(await deleteConversationMessages(regionalProject, {})).toBe(2)

    for (const id of ids) expect(await regionalBodyOf('conversation_message', id)).toBeUndefined()
  })
})

// ── Retention ────────────────────────────────────────────────────────────────

describe('retention', () => {
  it('prunes the region’s bodies 30 days after their last change and keeps the rest; home keeps none to prune', async () => {
    const old = randomUUID()
    const fresh = randomUUID()
    await run(
      regionalUrl,
      `INSERT INTO public.regional_bodies ("id", "kind", "projectId", "payload", "createdAt", "updatedAt")
       VALUES ('${old}', 'webhook', '${regionalProject}', '{}'::jsonb, now() - interval '31 days', now() - interval '31 days'),
              ('${fresh}', 'webhook', '${regionalProject}', '{}'::jsonb, now() - interval '40 days', now() - interval '29 days')`,
    )

    expect(await pruneRegionalBodies('us-east-1')).toBeGreaterThanOrEqual(1)
    expect(await regionalBody(old)).toBeUndefined()
    expect(await regionalBody(fresh)).toBeDefined()
    expect(await pruneRegionalBodies('ap-south-1')).toBe(0)
  })

  it("keeps a conversation's words past 30 days: they last as long as the messages", async () => {
    const words = randomUUID()
    await run(
      regionalUrl,
      `INSERT INTO public.regional_bodies ("id", "kind", "projectId", "payload", "createdAt", "updatedAt")
       VALUES ('${words}', 'conversation_message', '${regionalProject}', '{"content":"old words"}'::jsonb,
               now() - interval '400 days', now() - interval '400 days')`,
    )

    await pruneRegionalBodies('us-east-1')

    expect(await regionalBodyOf('conversation_message', words)).toBeDefined()
    await run(regionalUrl, `DELETE FROM public.regional_bodies WHERE "id" = '${words}'`)
  })
})

// ── What a failure may say outside the region ────────────────────────────────

describe('a failure without the reply', () => {
  it('keeps the HTTP status and drops the receiver’s words', () => {
    expect(failureWithoutReply('Webhook returned 500: {"email":"a@example.test"}', undefined)).toBe('Webhook returned 500')
    expect(failureWithoutReply('anything', 502)).toBe('Webhook returned 502')
    expect(failureWithoutReply('fetch failed', undefined)).toBe('fetch failed')
    expect(failureWithoutReply(undefined, undefined)).toBeNull()
  })

  it('is what the error reporter receives', () => {
    const reported = withoutReply(new Error('Webhook returned 503: {"card":"4242"}'))
    expect(reported.message).toBe('Webhook returned 503')
    expect(reported.message).not.toContain('4242')
  })
})
