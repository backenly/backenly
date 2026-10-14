/**
 * Support center: cases file, authorize by owner, correspond, and the AI first
 * responder tells the truth — proven at the routes against a real database.
 *
 * Two-sided throughout: every allowed action is asserted next to the refusal
 * that protects it (another account's case answers 404, production severities
 * refuse without a paid plan, a closed case refuses replies, and off Cloud the
 * whole surface answers 404 CLOUD_ONLY_FEATURE).
 *
 * The suite runs as Backenly Cloud (BACKENLY_EDITION=cloud). Without the
 * private overlay the entitlements provider answers null — "no subscription" —
 * which is exactly the free-plan rules the severity gate must apply.
 */
process.env.BACKENLY_EDITION = 'cloud'

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runSupportFirstResponse, setSupportAiDispatchForTests } from '@/lib/support/ai'
import { listAllTickets, setTicketStatus, staffReply } from '@/lib/support/service'
import { severityAllowedOnPlan } from '@/lib/support/constants'
import { GET as listGET, POST as createPOST } from '@/app/api/support/tickets/route'
import { GET as detailGET, PATCH as detailPATCH } from '@/app/api/support/tickets/[id]/route'
import { POST as replyPOST } from '@/app/api/support/tickets/[id]/messages/route'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

/** jest.setup.js replaces global Request, so NextRequest cannot be built here. */
function req(opts: { bearer?: string; method?: string; path?: string; body?: unknown } = {}): any {
  const path = opts.path ?? '/api/support/tickets'
  const headers: Record<string, string> = {}
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`
  return {
    method: opts.method ?? 'GET',
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path.split('?')[0], searchParams: new URLSearchParams(path.split('?')[1] ?? '') },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined, getAll: () => [] },
    json: async () => opts.body ?? {},
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

interface TestUser { id: string; email: string; token: string }
const createdUserIds: string[] = []

async function makeUser(): Promise<TestUser> {
  const email = `support-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Support Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, email, token }
}

function validBody(extra: Record<string, unknown> = {}) {
  return {
    subject: 'End-user sign-ups fail with 401',
    message: 'Since yesterday every POST to /auth/signup answers 401 invalid key.',
    category: 'auth',
    severity: 'normal',
    ...extra,
  }
}

async function fileTicket(user: TestUser, extra: Record<string, unknown> = {}) {
  const res = await createPOST(req({ bearer: user.token, method: 'POST', body: validBody(extra) }))
  expect(res.status).toBe(201)
  return (await res.json()).ticket
}

let alice: TestUser
let bob: TestUser
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  assertSafeTestDatabase()
  for (const k of ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_MODEL', 'SUPPORT_NOTIFY_EMAIL']) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  // The routes' fire-and-forget AI dispatch is recorded, not run, so a test
  // never races a background write; the responder itself is tested directly.
  setSupportAiDispatchForTests(async (id) => {
    dispatched.push(id)
  })
  alice = await makeUser()
  bob = await makeUser()
}, 60_000)

const dispatched: string[] = []

afterAll(async () => {
  setSupportAiDispatchForTests(null)
  setProviderForTests(null)
  setSpendLedgerForTests(null)
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.env.BACKENLY_EDITION = 'cloud'
  await prisma.platformNotification.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  await prisma.supportMessage.deleteMany({ where: { ticket: { userId: { in: createdUserIds } } } }).catch(() => {})
  await prisma.supportTicket.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
}, 60_000)

describe('filing a case', () => {
  it('refuses without a session', async () => {
    const res = await createPOST(req({ method: 'POST', body: validBody() }))
    expect(res.status).toBe(401)
  })

  it('files, numbers the case, and hands it to the AI dispatcher', async () => {
    const before = dispatched.length
    const ticket = await fileTicket(alice)
    expect(ticket.caseNumber).toBeGreaterThan(0)
    expect(ticket.status).toBe('open')
    expect(dispatched.length).toBe(before + 1)
    expect(dispatched[dispatched.length - 1]).toBe(ticket.id)

    const row = await prisma.supportTicket.findUnique({ where: { id: ticket.id } })
    expect(row).toMatchObject({ userId: alice.id, category: 'auth', severity: 'normal', aiState: 'none' })
  })

  it('refuses an empty subject, a too-short message, and unknown enums', async () => {
    for (const bad of [
      { subject: '' },
      { message: 'short' },
      { category: 'nonsense' },
      { severity: 'apocalyptic' },
    ]) {
      const res = await createPOST(req({ bearer: alice.token, method: 'POST', body: validBody(bad) }))
      expect(res.status).toBe(400)
    }
  })

  it('refuses production severities without a paid plan, and names the refusal', async () => {
    for (const severity of ['high', 'urgent']) {
      const res = await createPOST(req({ bearer: alice.token, method: 'POST', body: validBody({ severity }) }))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('SEVERITY_NEEDS_PAID_PLAN')
    }
  })

  it('allows production severities exactly when the plan is paid', () => {
    const paid = { isSandboxPlan: false } as any
    const free = { isSandboxPlan: true } as any
    expect(severityAllowedOnPlan(paid, 'urgent')).toBe(true)
    expect(severityAllowedOnPlan(paid, 'high')).toBe(true)
    expect(severityAllowedOnPlan(free, 'urgent')).toBe(false)
    expect(severityAllowedOnPlan(null, 'urgent')).toBe(false)
    expect(severityAllowedOnPlan(null, 'normal')).toBe(true)
  })

  it('attaches only a project the caller can access', async () => {
    const own = await prisma.project.create({ data: { name: 'support-own', userId: alice.id }, select: { id: true } })
    const foreign = await prisma.project.create({ data: { name: 'support-foreign', userId: bob.id }, select: { id: true } })

    const refused = await createPOST(req({ bearer: alice.token, method: 'POST', body: validBody({ projectId: foreign.id }) }))
    expect(refused.status).toBe(404)

    const ok = await createPOST(req({ bearer: alice.token, method: 'POST', body: validBody({ projectId: own.id }) }))
    expect(ok.status).toBe(201)
    expect((await ok.json()).ticket.projectId).toBe(own.id)
  })
})

describe('reading and corresponding', () => {
  it('lists only the caller’s cases, with the account’s support level', async () => {
    await fileTicket(bob, { subject: 'Bob case' })
    const res = await listGET(req({ bearer: alice.token }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tickets.length).toBeGreaterThan(0)
    expect(body.tickets.every((t: any) => t.subject !== 'Bob case')).toBe(true)
    expect(body.level.plan).toBe('Free')
    expect(body.level.allowedSeverities).toEqual(['low', 'normal'])
  })

  it('shows a case to its owner and 404 to anyone else', async () => {
    const ticket = await fileTicket(alice)
    const mine = await detailGET(req({ bearer: alice.token }), params(ticket.id))
    expect(mine.status).toBe(200)
    expect((await mine.json()).ticket.message).toContain('401 invalid key')

    const theirs = await detailGET(req({ bearer: bob.token }), params(ticket.id))
    expect(theirs.status).toBe(404)
    const unknown = await detailGET(req({ bearer: bob.token }), params(randomUUID()))
    expect(unknown.status).toBe(404)
  })

  it('reply goes on the thread and puts the case back with the team', async () => {
    const ticket = await fileTicket(alice)
    const refused = await replyPOST(req({ bearer: bob.token, method: 'POST', body: { body: 'not mine' } }), params(ticket.id))
    expect(refused.status).toBe(404)

    const res = await replyPOST(req({ bearer: alice.token, method: 'POST', body: { body: 'Still failing after a key rotation.' } }), params(ticket.id))
    expect(res.status).toBe(201)
    const row = await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: true } })
    expect(row?.status).toBe('open')
    expect(row?.lastMessageBy).toBe('user')
    expect(row?.messages).toHaveLength(1)
    expect(row?.messages[0]).toMatchObject({ author: 'user', authorUserId: alice.id })
  })

  it('resolve, reopen, and reply-reopens; closed is terminal for the customer', async () => {
    const ticket = await fileTicket(alice)

    const resolved = await detailPATCH(req({ bearer: alice.token, method: 'PATCH', body: { action: 'resolve' } }), params(ticket.id))
    expect(resolved.status).toBe(200)
    expect((await resolved.json()).ticket).toMatchObject({ status: 'resolved', resolvedBy: 'user' })

    const reopened = await detailPATCH(req({ bearer: alice.token, method: 'PATCH', body: { action: 'reopen' } }), params(ticket.id))
    expect((await reopened.json()).ticket.status).toBe('open')
    const reopenAgain = await detailPATCH(req({ bearer: alice.token, method: 'PATCH', body: { action: 'reopen' } }), params(ticket.id))
    expect(reopenAgain.status).toBe(409)

    await detailPATCH(req({ bearer: alice.token, method: 'PATCH', body: { action: 'resolve' } }), params(ticket.id))
    const reply = await replyPOST(req({ bearer: alice.token, method: 'POST', body: { body: 'It came back.' } }), params(ticket.id))
    expect(reply.status).toBe(201)
    expect((await prisma.supportTicket.findUnique({ where: { id: ticket.id } }))?.status).toBe('open')

    await setTicketStatus(ticket.id, 'closed')
    const onClosed = await replyPOST(req({ bearer: alice.token, method: 'POST', body: { body: 'anyone?' } }), params(ticket.id))
    expect(onClosed.status).toBe(409)
    expect((await onClosed.json()).code).toBe('CASE_CLOSED')
  })
})

describe('the AI first responder', () => {
  beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))
  afterEach(() => {
    setProviderForTests(null)
    setSpendLedgerForTests(null)
    delete process.env.AI_PROVIDER
    delete process.env.OPENAI_API_KEY
  })

  it('records "unavailable" when no provider is configured, and the case still stands', async () => {
    const ticket = await fileTicket(alice)
    expect(await runSupportFirstResponse(ticket.id)).toBe('unavailable')
    const row = await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: true } })
    expect(row?.aiState).toBe('unavailable')
    expect(row?.messages).toHaveLength(0)
  })

  it('writes the answer into the thread, platform-paid, and only once', async () => {
    process.env.AI_PROVIDER = 'openai'
    process.env.OPENAI_API_KEY = 'test-key'
    setProviderForTests(scriptedProvider([scriptedMessage({ text: 'Rotate the key in Connect, then retry.' })]))

    const ticket = await fileTicket(alice)
    expect(await runSupportFirstResponse(ticket.id)).toBe('replied')

    const row = await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: true } })
    expect(row).toMatchObject({ aiState: 'replied', lastMessageBy: 'ai' })
    expect(row?.messages).toHaveLength(1)
    expect(row?.messages[0]).toMatchObject({ author: 'ai', authorUserId: null })
    expect(row?.messages[0].body).toContain('Rotate the key')

    // Idempotent: the responder answers the opening message once, ever.
    expect(await runSupportFirstResponse(ticket.id)).toBe('skipped')
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id } })).toBe(1)
  })

  it('records "failed" when the provider errors, instead of pretending', async () => {
    process.env.AI_PROVIDER = 'openai'
    process.env.OPENAI_API_KEY = 'test-key'
    setProviderForTests({ id: 'scripted', send: async () => { throw new Error('boom') } } as any)

    const ticket = await fileTicket(alice)
    expect(await runSupportFirstResponse(ticket.id)).toBe('failed')
    const row = await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: true } })
    expect(row?.aiState).toBe('failed')
    expect(row?.messages).toHaveLength(0)
  })
})

describe('the staff side (what the Cloud admin overlay calls)', () => {
  it('staff reply flips the case to waiting_on_customer and notifies the owner in-app', async () => {
    const ticket = await fileTicket(alice)
    await staffReply(ticket.id, bob.id, 'We found the misconfigured key and fixed the validator.')

    const row = await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: true } })
    expect(row?.status).toBe('waiting_on_customer')
    expect(row?.firstStaffReplyAt).not.toBeNull()
    expect(row?.messages[row.messages.length - 1]).toMatchObject({ author: 'staff', authorUserId: bob.id })

    const note = await prisma.platformNotification.findFirst({
      where: { userId: alice.id, type: 'support_update' },
      orderBy: { createdAt: 'desc' },
    })
    expect(note).not.toBeNull()
    expect((note?.metadata as any)?.ticketId).toBe(ticket.id)
  })

  it('lists every account’s cases for the queue', async () => {
    const all = await listAllTickets({ status: 'all' })
    const owners = new Set(all.map((t) => t.user.id))
    expect(owners.has(alice.id)).toBe(true)
    expect(owners.has(bob.id)).toBe(true)
  })
})

describe('off Cloud, the surface does not exist', () => {
  afterEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('answers 404 CLOUD_ONLY_FEATURE on a self-hosted deployment', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    const res = await listGET(req({ bearer: alice.token }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('CLOUD_ONLY_FEATURE')

    const create = await createPOST(req({ bearer: alice.token, method: 'POST', body: validBody() }))
    expect(create.status).toBe(404)
  })
})
