/**
 * A person whose email address is on a `.internal` domain is an ordinary user
 * of the app: counted as a monthly active user, listed under Auth, announced to
 * `auth.user.created` webhooks and on_signup functions, and signed out for good
 * at logout.
 *
 * Only Backenly's own check accounts, by their exact addresses
 * (lib/services/check-accounts.ts), are treated otherwise, and only when the
 * platform's signed probe makes the request (lib/security/platform-probe.ts).
 * Nobody else may sign up with one of those addresses.
 *
 * Real Next sign-up and logout routes, Auth user list route and database. The
 * webhook dispatcher is replaced, to see what it is handed.
 */
import '../helpers/real-web-standard'

const triggerWebhooks = jest.fn(async (..._args: unknown[]) => {})
jest.mock('@/lib/webhooks', () => ({
  ...jest.requireActual('@/lib/webhooks'),
  triggerWebhooks: (...args: unknown[]) => triggerWebhooks(...args),
}))

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { POST as signupRoute } from '@/app/api/v1/[projectId]/auth/signup/route'
import { POST as logoutRoute } from '@/app/api/v1/[projectId]/auth/logout/route'
import { GET as listUsers } from '@/app/api/auth/users/route'
import { INTERNAL_TRAFFIC_HEADER, internalTrafficToken } from '@/lib/traffic/request-recorder'

const PASSWORD = 'Internal-Domain-Horse-7!'
let ownerId: string
let ownerToken: string
let projectId: string
let schema: string
let ip = 0
const originalEdition = process.env.BACKENLY_EDITION

/** A request as the routes read one: headers and a JSON body. */
function request(body: Record<string, unknown>, headers: Record<string, string>): NextRequest {
  const all = new Map(Object.entries({ 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++ip}`, ...headers }))
  return {
    headers: { get: (name: string) => all.get(name.toLowerCase()) ?? null },
    json: async () => body,
    url: `http://localhost:3000/api/v1/${projectId}/auth`,
  } as unknown as NextRequest
}

const params = () => ({ params: Promise.resolve({ projectId }) })
const probeHeaders = () => ({ [INTERNAL_TRAFFIC_HEADER]: internalTrafficToken()! })

async function signUp(email: string, headers: Record<string, string> = {}) {
  const res = await signupRoute(request({ email, password: PASSWORD, name: 'x' }, headers), params())
  return { status: res.status, body: (await res.json()) as any }
}

async function logOut(token: string, headers: Record<string, string> = {}) {
  const res = await logoutRoute(request({}, { authorization: `Bearer ${token}`, ...headers }), params())
  expect(res.status).toBe(200)
}

async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 40 && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 100))
    value = await read()
  }
  return value
}

const activeUsers = () => prisma.projectActiveUser.count({ where: { projectId } })
const revoked = async () =>
  (await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "${schema}"."_token_blacklist"`,
  ).catch(() => [{ n: 0 }]))[0].n
const rows = async (email: string) =>
  (await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "${schema}"."users" WHERE email = $1`, email,
  ))[0].n

async function listed(): Promise<string[]> {
  const res = await listUsers(
    new NextRequest('http://localhost:3000/api/auth/users', {
      headers: { cookie: `auth-token=${ownerToken}`, 'x-project-id': projectId },
    }),
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as any).users.map((u: { email: string }) => u.email)
}

const announced = (email: string) =>
  triggerWebhooks.mock.calls.some(([, event, payload]) => event === 'auth.user.created' && (payload as any)?.email === email)

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  expect(internalTrafficToken()).toBeTruthy()
  const email = `internal-domains-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  ownerToken = (await createSession(ownerId, email)).token
  projectId = (await prisma.project.create({
    data: { name: 'internal-domains', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
    select: { id: true },
  })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "email" TEXT UNIQUE NOT NULL, "password" TEXT,
    "name" TEXT, "role" TEXT NOT NULL DEFAULT 'user', "is_blocked" BOOLEAN NOT NULL DEFAULT FALSE,
    "last_login" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW())`)
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.projectActiveUser.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

beforeEach(() => triggerWebhooks.mockClear())

describe('a person whose address is on a .internal domain', () => {
  const email = 'ana@corp.internal'
  let token = ''

  it('signs up as an ordinary user: counted, listed and announced', async () => {
    const before = await activeUsers()
    const res = await signUp(email)
    expect(res.status).toBe(201)
    token = res.body.data.token
    expect(await eventually(activeUsers, (n) => n > before)).toBe(before + 1)
    expect(await listed()).toContain(email)
    expect(await eventually(async () => announced(email), Boolean)).toBe(true)
  }, 60_000)

  it('is signed out for good at logout', async () => {
    const before = await revoked()
    await logOut(token)
    expect(await revoked()).toBe(before + 1)
  }, 60_000)
})

describe("the address of one of Backenly's own check accounts", () => {
  it('is refused at sign-up without the platform\'s signed probe', async () => {
    const email = `__cv_${crypto.randomBytes(4).toString('hex')}@backenly.internal`
    const res = await signUp(email)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'This email address is reserved. Sign up with another one.' })
    expect(await rows(email)).toBe(0)
  }, 60_000)

  it("CONTROL: is signed up by the signed probe, and kept out of the app's users", async () => {
    const email = `__cv_${crypto.randomBytes(4).toString('hex')}@backenly.internal`
    const before = await activeUsers()
    const res = await signUp(email, probeHeaders())
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 500))
    expect(await activeUsers()).toBe(before)
    expect(await listed()).not.toContain(email)
    expect(announced(email)).toBe(false)

    const revokedBefore = await revoked()
    await logOut(res.body.data.token, probeHeaders())
    expect(await revoked()).toBe(revokedBefore)
  }, 60_000)
})
