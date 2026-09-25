/**
 * The operations PR 2b gives the section tools, end to end.
 *
 * Every call goes through the real MCP route with a real key, so what is tested
 * is what an agent gets: domain resolution, the read-only filter, approval
 * parking, the operation itself and what it wrote to the database. The only
 * stand-ins are the webhook receiver, a real HTTP server on loopback, which the
 * egress guard admits only because BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE opts in,
 * and the plan lookup.
 *
 * The suite runs as the cloud edition: the single-tenant resolver rightly
 * refuses to pick a project in a database holding many, as the shared test
 * database does. Project access is then real ownership from the database. Only
 * the plan comes from the Cloud overlay, which the public repository stubs to
 * "no plan", so it is supplied here: a paid plan, or one without webhooks.
 */

let mockPlan: 'paid' | 'free' = 'paid'
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return {
    ...actual,
    cloudEntitlements: async () => mockPlan === 'paid'
      ? { ...selfHostedEntitlements(), planName: 'BUILDER' }
      : { ...selfHostedEntitlements(), planName: 'SANDBOX', allowWebhooks: false },
  }
})

import '../helpers/next-request-polyfill'
import http from 'http'
import crypto from 'crypto'
import type { AddressInfo } from 'net'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { decideApproval } from '@/lib/mcp/approvals'
import { POST } from '@/app/api/mcp/tool/route'

class Receiver {
  private server!: http.Server
  readonly received: Array<{ headers: http.IncomingHttpHeaders; raw: string }> = []
  status = 200
  port = 0
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        this.received.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(this.status, { 'Content-Type': 'text/plain' })
        res.end(this.status >= 400 ? 'receiver refused' : 'ok')
      })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
  }
  get url() { return `http://127.0.0.1:${this.port}/hook` }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())) }
}

const receiver = new Receiver()
let ownerId: string
let projectId: string
let schema: string
const RW_KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const RO_KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`

async function call(key: string, tool: string, args: Record<string, unknown>) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function mintKey(raw: string, readOnly: boolean) {
  await prisma.apiKey.create({
    data: {
      name: readOnly ? 'agent (read-only)' : 'agent',
      keyPrefix: raw.slice(0, 12),
      keyHash: hashApiKey(raw),
      userId: ownerId,
      projectId,
      scope: 'mcp',
      mcpReadOnly: readOnly,
      permissions: [],
      capabilities: [],
    },
  })
}

const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  await receiver.start()
  ownerId = (await prisma.user.create({
    data: { email: `ops-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'ops' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'mcp-domain-operations', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."orders" (id serial PRIMARY KEY, label text)`)
  await mintKey(RW_KEY, false)
  await mintKey(RO_KEY, true)
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await receiver.stop()
}, 120_000)

beforeEach(() => {
  receiver.received.length = 0
  receiver.status = 200
  mockPlan = 'paid'
  process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE = 'true'
})

// ── Webhooks: the Webhooks page's endpoints ──────────────────────────────────

describe('webhooks', () => {
  let webhookId: string
  let secret: string

  it('refuses an event that does not exist, before touching anything', async () => {
    const r = await call(RW_KEY, 'webhooks', { action: 'create', eventType: 'row.exploded', targetUrl: receiver.url })
    expect(r.body).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await prisma.webhook.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('refuses a destination the egress guard blocks, and saves nothing', async () => {
    delete process.env.BACKENLY_WEBHOOK_EGRESS_ALLOW_PRIVATE
    const r = await call(RW_KEY, 'webhooks', { action: 'create', eventType: 'row.inserted', targetUrl: receiver.url })
    expect(r.body).toMatchObject({ ok: false, code: 'BLOCKED_DESTINATION' })
    expect(await prisma.webhook.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('refuses on a plan without webhooks, as the Webhooks page does', async () => {
    mockPlan = 'free'
    const r = await call(RW_KEY, 'webhooks', { action: 'create', eventType: 'row.inserted', targetUrl: receiver.url })
    expect(r.body).toMatchObject({ ok: false, code: 'PLAN_LIMIT_EXCEEDED' })
    expect(await prisma.webhook.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('does not let a read-only key create one', async () => {
    const r = await call(RO_KEY, 'webhooks', { action: 'create', eventType: 'row.inserted', targetUrl: receiver.url })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('READ_ONLY_KEY')
    expect(await prisma.webhook.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('creates one, returning the secret once in data and never in the summary', async () => {
    const r = await call(RW_KEY, 'webhooks', { action: 'create', eventType: 'row.inserted', targetUrl: receiver.url })
    expect(r.body.ok).toBe(true)
    webhookId = r.body.data.webhook.id
    secret = r.body.data.secret
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(r.body.summary).not.toContain(secret)
    expect(r.body.data.captureError).toBeNull()
    const row = await prisma.webhook.findUnique({ where: { id: webhookId } })
    expect(row).toMatchObject({ projectId, eventType: 'row.inserted', targetUrl: receiver.url, active: true })
  }, 60_000)

  it('lists it for a read-only key too, without the secret', async () => {
    const r = await call(RO_KEY, 'webhooks', { action: 'list' })
    expect(r.body.ok).toBe(true)
    expect(r.body.data.webhooks.map((w: any) => w.id)).toEqual([webhookId])
    expect(JSON.stringify(r.body)).not.toContain(secret)
    expect(r.body.data.capture).toMatchObject({ required: true, healthy: true })
  }, 60_000)

  it('sends a real test delivery the receiver can verify with the secret', async () => {
    const r = await call(RW_KEY, 'webhooks', { action: 'test', webhookId })
    expect(r.body).toMatchObject({ ok: true, data: { success: true, statusCode: 200 } })
    expect(receiver.received).toHaveLength(1)
    const got = receiver.received[0]
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(got.raw).digest('hex')}`
    expect(got.headers['x-webhook-signature']).toBe(expected)
    expect(got.headers['x-webhook-delivery']).toBe(r.body.data.logId)
  }, 60_000)

  let failedLogId: string
  it('reports a receiver that refuses as a failed delivery, recorded as FAILED', async () => {
    receiver.status = 500
    const r = await call(RW_KEY, 'webhooks', { action: 'test', webhookId })
    expect(r.body).toMatchObject({ ok: false, code: 'DELIVERY_FAILED' })
    failedLogId = r.body.data.logId
    expect((await prisma.webhookLog.findUnique({ where: { id: failedLogId } }))?.status).toBe('FAILED')
  }, 60_000)

  it('shows the deliveries, newest first', async () => {
    const r = await call(RO_KEY, 'webhooks', { action: 'logs', webhookId })
    expect(r.body.data.deliveries.map((d: any) => d.status)).toEqual(['FAILED', 'SUCCESS'])
  }, 60_000)

  it('sends a failed delivery again as a new attempt, leaving the original as it was', async () => {
    const r = await call(RW_KEY, 'webhooks', { action: 'replay', deliveryId: failedLogId })
    expect(r.body).toMatchObject({ ok: true, data: { replayOf: failedLogId, success: true } })
    expect(r.body.data.logId).not.toBe(failedLogId)
    expect((await prisma.webhookLog.findUnique({ where: { id: failedLogId } }))?.status).toBe('FAILED')
    expect(receiver.received).toHaveLength(1)
  }, 60_000)

  it('refuses to send a delivered event twice', async () => {
    const delivered = await prisma.webhookLog.findFirst({ where: { webhookId, status: 'SUCCESS' } })
    const r = await call(RW_KEY, 'webhooks', { action: 'replay', deliveryId: delivered!.id })
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_REPLAYABLE' })
    expect(receiver.received).toHaveLength(0)
  }, 60_000)

  it('refuses to replay to a disabled endpoint', async () => {
    const off = await call(RW_KEY, 'webhooks', { action: 'update', webhookId, active: false })
    expect(off.body).toMatchObject({ ok: true, data: { webhook: { active: false } } })
    const r = await call(RW_KEY, 'webhooks', { action: 'replay', deliveryId: failedLogId })
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_REPLAYABLE' })
    await call(RW_KEY, 'webhooks', { action: 'update', webhookId, active: true })
  }, 60_000)

  it('rotates the secret; the next delivery is signed with the new one only', async () => {
    const r = await call(RW_KEY, 'webhooks', { action: 'rotate_secret', webhookId })
    const next = r.body.data.secret
    expect(next).toMatch(/^[0-9a-f]{64}$/)
    expect(next).not.toBe(secret)
    expect(r.body.summary).not.toContain(next)
    await call(RW_KEY, 'webhooks', { action: 'test', webhookId })
    const got = receiver.received[0]
    expect(got.headers['x-webhook-signature']).toBe(`sha256=${crypto.createHmac('sha256', next).update(got.raw).digest('hex')}`)
  }, 60_000)

  it('parks a delete for a human, deletes nothing, and runs exactly that call once approved', async () => {
    const r = await call(RW_KEY, 'webhooks', { action: 'delete', webhookId })
    expect(r.body).toMatchObject({ ok: true, status: 'awaiting_approval' })
    expect(await prisma.webhook.count({ where: { id: webhookId } })).toBe(1)

    const decided = await decideApproval({ projectId, approvalId: r.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(await prisma.webhook.count({ where: { id: webhookId } })).toBe(0)
  }, 60_000)
})

// ── Functions: inspect, run, logs ────────────────────────────────────────────

describe('functions', () => {
  const okCode = `
    import { NextResponse } from 'next/server'
    export async function GET(request: Request) {
      const name = new URL(request.url).searchParams.get('name')
      console.log('ran for', name)
      return NextResponse.json({ hello: name })
    }
  `
  const failingCode = `
    import { NextResponse } from 'next/server'
    export async function GET(request: Request) {
      throw new Error('deliberately broken')
    }
  `
  let okId: string
  let failingId: string

  beforeAll(async () => {
    const make = (name: string, code: string, status = 'active') => prisma.aiFunction.create({
      data: {
        projectId, name, description: name, generatedCode: code, status,
        triggerType: 'manual', triggerTable: `GET /api/v1/${projectId}/fn/${name}`,
      },
    })
    okId = (await make('hello-agent', okCode)).id
    failingId = (await make('broken-agent', failingCode)).id
    await make('switched-off', okCode, 'inactive')
  })

  it('reads one in full by name, for a read-only key too', async () => {
    const r = await call(RO_KEY, 'functions', { action: 'get', name: 'hello_agent' })
    expect(r.body.ok).toBe(true)
    expect(r.body.data).toMatchObject({ id: okId, code: okCode, endpoint: { method: 'GET' } })
  }, 60_000)

  it('runs one and returns its answer, return value and log lines', async () => {
    const r = await call(RW_KEY, 'functions', { action: 'invoke', functionId: okId, event: { name: 'ada' } })
    expect(r.body).toMatchObject({ ok: true, data: { success: true, httpStatus: 200, result: { hello: 'ada' } } })
    expect(r.body.data.logs.join('\n')).toContain('ran for ada')
  }, 60_000)

  it('reports a failure and leaves the code exactly as it was', async () => {
    const r = await call(RW_KEY, 'functions', { action: 'invoke', functionId: failingId })
    expect(r.body).toMatchObject({ ok: false, code: 'FUNCTION_FAILED' })
    expect(r.body.summary).toContain('deliberately broken')
    await new Promise((res) => setTimeout(res, 500))
    const after = await prisma.aiFunction.findUnique({ where: { id: failingId } })
    expect(after?.generatedCode).toBe(failingCode)
    expect(after?.lastError ?? '').not.toMatch(/^AUTO-FIX/)
  }, 60_000)

  it('refuses to run one that is switched off, and does not switch it on', async () => {
    const r = await call(RW_KEY, 'functions', { action: 'invoke', name: 'switched-off' })
    expect(r.body).toMatchObject({ ok: false, code: 'FUNCTION_INACTIVE' })
    expect((await prisma.aiFunction.findFirst({ where: { projectId, name: 'switched-off' } }))?.status).toBe('inactive')
  }, 60_000)

  it('does not let a read-only key run one', async () => {
    const r = await call(RO_KEY, 'functions', { action: 'invoke', functionId: okId })
    expect(r.body.code).toBe('READ_ONLY_KEY')
  }, 60_000)

  it('shows the runs, failures with their error', async () => {
    const r = await call(RO_KEY, 'functions', { action: 'logs' })
    const runs = r.body.data.runs
    expect(runs.find((x: any) => x.functionId === okId)).toMatchObject({ success: true })
    expect(runs.find((x: any) => x.functionId === failingId)).toMatchObject({ success: false, error: expect.stringContaining('deliberately broken') })
  }, 60_000)
})

// ── Monitoring: request log ──────────────────────────────────────────────────

describe('monitoring request_logs', () => {
  beforeAll(async () => {
    await prisma.apiRequestLog.createMany({
      data: [
        { projectId, userId: ownerId, method: 'GET', path: '/db/orders', statusCode: 200, duration: 12 },
        { projectId, userId: ownerId, method: 'POST', path: '/db/orders', statusCode: 500, duration: 40 },
        { projectId, userId: ownerId, method: 'GET', path: '/api/projects/x', statusCode: 200, duration: 5 },
      ],
    })
  })

  it('returns only the project runtime traffic, never the platform routes', async () => {
    const r = await call(RO_KEY, 'monitoring', { action: 'request_logs' })
    expect(r.body.data.requests.map((x: any) => x.path).sort()).toEqual(['/db/orders', '/db/orders'])
  }, 60_000)

  it('narrows to failures', async () => {
    const r = await call(RO_KEY, 'monitoring', { action: 'request_logs', minStatus: 400 })
    expect(r.body.data.requests).toEqual([expect.objectContaining({ method: 'POST', status: 500, latencyMs: 40 })])
  }, 60_000)
})

// ── Integrations: capabilities and a key re-check ────────────────────────────

describe('integrations', () => {
  const replicateKey = `r8_${crypto.randomBytes(18).toString('hex')}`

  beforeAll(async () => {
    const { storeIntegrationKey } = await import('@/lib/services/integrationKeyStore')
    // A fixture, not a connect: replicate has no verification probe, so the
    // re-check below gets a real answer without calling any provider.
    await storeIntegrationKey(projectId, 'replicate', replicateKey, { skipVerification: true })
  })

  it('names the exact methods a function can call, and never a key', async () => {
    const r = await call(RO_KEY, 'integrations', { action: 'capabilities' })
    const byId = Object.fromEntries(r.body.data.providers.map((p: any) => [p.id, p]))
    expect(byId.stripe.methods.map((m: any) => m.name)).toContain('createCheckoutSession')
    expect(byId.stripe).toMatchObject({ connected: false, signingSecretStored: false })
    expect(byId.stripe.receiverUrl).toMatch(new RegExp(`/api/v1/${projectId}/webhooks/stripe$`))
    expect(byId.posthog.methods.map((m: any) => m.name)).toEqual(['capture', 'identify', 'isFeatureEnabled'])
    expect(byId.replicate).toMatchObject({ connected: true })
    expect(JSON.stringify(r.body)).not.toContain(replicateKey)
  }, 60_000)

  it('answers for one provider, and refuses one that does not exist', async () => {
    const one = await call(RO_KEY, 'integrations', { action: 'capabilities', integrationId: 'claude' })
    expect(one.body.data.providers.map((p: any) => p.id)).toEqual(['anthropic'])
    const none = await call(RO_KEY, 'integrations', { action: 'capabilities', integrationId: 'myspace' })
    expect(none.body).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  }, 60_000)

  it('re-asks about a stored key and records the honest answer', async () => {
    const r = await call(RW_KEY, 'integrations', { action: 'verify', integrationId: 'replicate' })
    expect(r.body).toMatchObject({ ok: true, data: { integrationId: 'replicate', verification: 'unverifiable' } })
    expect(JSON.stringify(r.body)).not.toContain(replicateKey)
    const row = await prisma.projectIntegrationKey.findFirst({ where: { projectId, integrationId: 'replicate' } })
    expect(row?.verification).toBe('unverifiable')
  }, 60_000)

  it('says there is nothing to verify when no key is stored', async () => {
    const r = await call(RW_KEY, 'integrations', { action: 'verify', integrationId: 'stripe' })
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_CONNECTED' })
  }, 60_000)

  it('does not let a read-only key re-check, since that writes the answer', async () => {
    const r = await call(RO_KEY, 'integrations', { action: 'verify', integrationId: 'replicate' })
    expect(r.body.code).toBe('READ_ONLY_KEY')
  }, 60_000)
})

// ── Auth: the emails end users receive ───────────────────────────────────────

describe('auth email', () => {
  const smtpPassword = `fixture-${crypto.randomBytes(8).toString('hex')}`

  it('shows the sender and the three templates, for a read-only key too', async () => {
    const r = await call(RO_KEY, 'auth', { action: 'email_settings' })
    expect(r.body.ok).toBe(true)
    expect(r.body.data.smtp).toMatchObject({ configured: false, passwordConfigured: false })
    expect(r.body.data.templates.map((t: any) => t.kind)).toEqual(['verification', 'password_reset', 'magic_link'])
  }, 60_000)

  it('refuses a template without the link it exists to deliver, and saves nothing', async () => {
    const r = await call(RW_KEY, 'auth', { action: 'set_email_template', kind: 'password_reset', subject: 'Reset', bodyHtml: '<p>no link</p>' })
    expect(r.body).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await prisma.projectEmailTemplate.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('saves a template and puts the default back', async () => {
    const saved = await call(RW_KEY, 'auth', { action: 'set_email_template', kind: 'password_reset', subject: 'Reset your {{appName}} password', bodyHtml: '<a href="{{ctaUrl}}">Reset</a>' })
    expect(saved.body).toMatchObject({ ok: true, data: { template: { kind: 'password_reset', customised: true } } })
    const reset = await call(RW_KEY, 'auth', { action: 'reset_email_template', kind: 'password_reset' })
    expect(reset.body).toMatchObject({ ok: true, data: { reverted: true } })
    expect(await prisma.projectEmailTemplate.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('does not let a read-only key change a template', async () => {
    const r = await call(RO_KEY, 'auth', { action: 'set_email_template', kind: 'verification', subject: 's', bodyHtml: '{{ctaUrl}}' })
    expect(r.body.code).toBe('READ_ONLY_KEY')
  }, 60_000)

  it('refuses SMTP settings that cannot authenticate', async () => {
    const r = await call(RW_KEY, 'auth', { action: 'set_smtp', host: '127.0.0.1', port: 1, username: 'u', fromAddress: 'app@example.test' })
    expect(r.body).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(r.body.summary).toContain('password')
  }, 60_000)

  it('stores the password and never returns it', async () => {
    const r = await call(RW_KEY, 'auth', { action: 'set_smtp', host: '127.0.0.1', port: 1, username: 'u', password: smtpPassword, fromAddress: 'app@example.test' })
    expect(r.body).toMatchObject({ ok: true, data: { smtp: { configured: true, passwordConfigured: true } } })
    expect(JSON.stringify(r.body)).not.toContain(smtpPassword)
  }, 60_000)

  it('reports a test send that fails, and records the failure instead of a green tick', async () => {
    const r = await call(RW_KEY, 'auth', { action: 'test_smtp', to: 'owner@example.test' })
    expect(r.body).toMatchObject({ ok: false, code: 'SEND_FAILED', data: { sent: false, source: 'project' } })
    const row = await prisma.projectEmailConfig.findUnique({ where: { projectId } })
    expect(row?.lastTestAt).not.toBeNull()
    expect(row?.lastTestError).toBeTruthy()
  }, 60_000)

  it('parks removing the sender for a human', async () => {
    const r = await call(RW_KEY, 'auth', { action: 'remove_smtp' })
    expect(r.body).toMatchObject({ ok: true, status: 'awaiting_approval' })
    expect(await prisma.projectEmailConfig.count({ where: { projectId } })).toBe(1)
    const decided = await decideApproval({ projectId, approvalId: r.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(await prisma.projectEmailConfig.count({ where: { projectId } })).toBe(0)
  }, 60_000)
})

// ── Connect: which project and key ───────────────────────────────────────────

describe('connect whoami', () => {
  it('names the bound project and the calling key, from the database', async () => {
    const r = await call(RW_KEY, 'connect', { action: 'whoami' })
    expect(r.body.data.project).toMatchObject({ id: projectId, name: 'mcp-domain-operations', published: false, paused: false })
    expect(r.body.data.connection).toMatchObject({ prefix: RW_KEY.slice(0, 12), scope: 'mcp', readOnly: false, branch: null })
    expect(r.body.summary).toContain(projectId)
    expect(JSON.stringify(r.body)).not.toContain(RW_KEY)
  }, 60_000)

  it('reports a read-only key as read-only', async () => {
    const r = await call(RO_KEY, 'connect', { action: 'whoami' })
    expect(r.body.data.connection).toMatchObject({ prefix: RO_KEY.slice(0, 12), readOnly: true })
  }, 60_000)
})

// ── Deploy: version history ──────────────────────────────────────────────────

describe('deploy history', () => {
  it('says plainly that nothing is published yet', async () => {
    const r = await call(RO_KEY, 'deploy', { action: 'history' })
    expect(r.body).toMatchObject({ ok: true, data: { versions: [], latestVersion: 0 } })
  }, 60_000)

  it('lists published versions newest first', async () => {
    for (const version of [1, 2]) {
      await prisma.deployment.create({
        data: {
          projectId, provider: 'backenly', environment: 'live', status: 'live', version,
          graphSnapshotId: `snap-${version}`, changeSummary: `v${version}`, completedAt: new Date(),
        },
      })
    }
    const r = await call(RO_KEY, 'deploy', { action: 'history' })
    expect(r.body.data.versions.map((v: any) => v.version)).toEqual([2, 1])
    expect(r.body.data.latestVersion).toBe(2)
  }, 60_000)
})
