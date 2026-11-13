/**
 * A PERSON'S SUPPORT ACTIONS HAVE AN HOURLY CEILING
 * =================================================
 * Filing a case, replying on one and asking the AI first responder again each
 * have a per-person hourly budget (lib/support/constants.ts). Each new case is
 * a model call Backenly pays for and an email to the support team, so the
 * ceiling is what keeps one account from spending either without end.
 *
 * Each budget is spent to its limit through the real route, the next call is
 * refused with 429 and does nothing, and another person's budget is untouched.
 * Real database and sessions; the AI dispatch is recorded, not run, as in
 * support-center.spec.ts.
 */
process.env.BACKENLY_EDITION = 'cloud'

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { setSupportAiDispatchForTests } from '@/lib/support/ai'
import { TICKET_AI_RETRY_LIMIT, TICKET_CREATE_LIMIT, TICKET_REPLY_LIMIT } from '@/lib/support/constants'
import { POST as createPOST } from '@/app/api/support/tickets/route'
import { PATCH as detailPATCH } from '@/app/api/support/tickets/[id]/route'
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
function req(opts: { bearer: string; method: string; path: string; body?: unknown }): any {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.bearer}` }
  return {
    method: opts.method,
    url: `http://localhost:3000${opts.path}`,
    nextUrl: { pathname: opts.path, searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined, getAll: () => [] },
    json: async () => opts.body ?? {},
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

interface TestUser { id: string; token: string }
const userIds: string[] = []
const dispatched: string[] = []
const savedEnv: Record<string, string | undefined> = {}

async function makeUser(): Promise<TestUser> {
  const email = `support-limits-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Support Limits' }, select: { id: true } })
  userIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

const caseBody = {
  subject: 'Sign-ups answer 401',
  message: 'Every POST to /auth/signup answers 401 since this morning.',
  category: 'auth',
  severity: 'normal',
}

const fileCase = (user: TestUser) =>
  createPOST(req({ bearer: user.token, method: 'POST', path: '/api/support/tickets', body: caseBody }))

const reply = (user: TestUser, ticketId: string) =>
  replyPOST(
    req({ bearer: user.token, method: 'POST', path: `/api/support/tickets/${ticketId}/messages`, body: { body: 'Any news?' } }),
    params(ticketId),
  )

const retryAi = (user: TestUser, ticketId: string) =>
  detailPATCH(
    req({ bearer: user.token, method: 'PATCH', path: `/api/support/tickets/${ticketId}`, body: { action: 'retry_ai' } }),
    params(ticketId),
  )

const casesOf = (user: TestUser) => prisma.supportTicket.count({ where: { userId: user.id } })

beforeAll(async () => {
  assertSafeTestDatabase()
  for (const k of ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_MODEL', 'SUPPORT_NOTIFY_EMAIL']) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  setSupportAiDispatchForTests(async (id) => {
    dispatched.push(id)
  })
}, 60_000)

afterAll(async () => {
  setSupportAiDispatchForTests(null)
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await prisma.platformNotification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.supportMessage.deleteMany({ where: { ticket: { userId: { in: userIds } } } }).catch(() => {})
  await prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
}, 60_000)

describe('filing cases', () => {
  it(`files ${TICKET_CREATE_LIMIT.limit} in an hour, then refuses the next without filing or answering it`, async () => {
    const alice = await makeUser()
    for (let i = 0; i < TICKET_CREATE_LIMIT.limit; i++) {
      expect((await fileCase(alice)).status).toBe(201)
    }
    const dispatchedBefore = dispatched.length

    const refused: any = await fileCase(alice)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(await casesOf(alice)).toBe(TICKET_CREATE_LIMIT.limit)
    expect(dispatched.length).toBe(dispatchedBefore)

    // Another person's budget is their own.
    const bob = await makeUser()
    expect((await fileCase(bob)).status).toBe(201)
  }, 120_000)
})

describe('replying', () => {
  it(`takes ${TICKET_REPLY_LIMIT.limit} replies in an hour, then refuses the next without saving it`, async () => {
    const carol = await makeUser()
    const ticket = (await (await fileCase(carol) as any).json()).ticket
    for (let i = 0; i < TICKET_REPLY_LIMIT.limit; i++) {
      expect((await reply(carol, ticket.id)).status).toBe(201)
    }

    const refused: any = await reply(carol, ticket.id)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id, author: 'user' } })).toBe(TICKET_REPLY_LIMIT.limit)
  }, 180_000)
})

describe('asking the AI first responder again', () => {
  it(`counts ${TICKET_AI_RETRY_LIMIT.limit} asks in an hour, then refuses the next before looking at the case`, async () => {
    const dave = await makeUser()
    const ticket = (await (await fileCase(dave) as any).json()).ticket
    // The case has no failed answer, so each ask is refused by the case
    // itself (409), and each one is still counted.
    for (let i = 0; i < TICKET_AI_RETRY_LIMIT.limit; i++) {
      expect((await retryAi(dave, ticket.id)).status).toBe(409)
    }

    const refused: any = await retryAi(dave, ticket.id)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' })
  }, 120_000)
})
