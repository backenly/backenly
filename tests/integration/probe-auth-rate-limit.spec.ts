/**
 * The contract probe is not throttled by the end-user auth limits, and nothing
 * else escapes them.
 *
 * The probe signs up and signs in a synthetic account on every project, every
 * minute, from the platform's own address. The end-user budgets (10 sign-ups an
 * hour, 10 sign-ins per 15 minutes, per project and address) ran out within
 * minutes, and the sweep then reported its own 429s as a fleet-wide auth outage.
 *
 * The exemption needs BOTH the internal-traffic token (an HMAC of the platform
 * secret) and a reserved synthetic address. These tests hold every other
 * combination to the customer limits, which are asserted unchanged first.
 *
 * Every case has its own address AND its own account: sign-in is also limited
 * per account, so a shared account would make a later case fail for an earlier
 * case's attempts, and "the 11th is refused" would pass for the wrong reason.
 *
 * Real routes, real database, like signin-enumeration.spec.ts: the property is
 * the order and scope of the route's own checks.
 */
import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import { POST as signin } from '@/app/api/v1/[projectId]/auth/signin/route'
import { POST as signup } from '@/app/api/v1/[projectId]/auth/signup/route'
import { hashPassword } from '@/lib/auth/password'
import { AUTH_LIMITS } from '@/lib/security/auth-rate-limit'
import { INTERNAL_TRAFFIC_HEADER, internalTrafficToken } from '@/lib/traffic/request-recorder'

const prisma = new PrismaClient()
const PASSWORD = 'Probe-Horse-Battery-9!'
const ACCOUNTS = {
  customer: 'customer@example.test',
  tokenOnCustomer: 'token-on-customer@example.test',
  probe: '__cv_ratelimit@backenly.internal',
  reservedNoToken: '__cv_notoken@backenly.internal',
  reservedForged: '__cv_forged@backenly.internal',
}
const TEN_OK_THEN_429 = (ok: number) => [...Array(10).fill(ok), 429]

let ownerId: string
let projectId: string
let ipCounter = 0

function request(body: Record<string, unknown>, ip: string, internal?: string): NextRequest {
  const headers = new Map<string, string>([
    ['content-type', 'application/json'],
    ['x-forwarded-for', ip],
  ])
  if (internal !== undefined) headers.set(INTERNAL_TRAFFIC_HEADER, internal)
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as NextRequest
}

const params = () => ({ params: Promise.resolve({ projectId }) })
const freshIp = () => `198.51.100.${++ipCounter}`
const token = () => internalTrafficToken()!

/** Statuses of `n` sign-ins to one account from one fresh address. */
async function signins(n: number, email: string, internal?: string): Promise<number[]> {
  const ip = freshIp()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await signin(request({ email, password: PASSWORD }, ip, internal), params())
    out.push(res.status)
  }
  return out
}

/** Statuses of `n` sign-ups (one new address each) from one fresh address. */
async function signups(n: number, email: (i: number) => string, internal?: string): Promise<number[]> {
  const ip = freshIp()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await signup(request({ email: email(i), password: PASSWORD, name: 'x' }, ip, internal), params())
    out.push(res.status)
  }
  return out
}

beforeAll(async () => {
  expect(token()).toBeTruthy()
  const owner = await prisma.user.create({
    data: {
      email: `probe-rl-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Probe Rate Limit Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id
  const project = await prisma.project.create({
    data: {
      name: 'probe-rate-limit',
      userId: ownerId,
      description: 'probe rate limit suite',
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true },
  })
  projectId = project.id
  const schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."users" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
       name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now())`,
  )
  const hash = await hashPassword(PASSWORD)
  for (const email of Object.values(ACCOUNTS)) {
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (email, password) VALUES ($1, $2)`, email, hash)
  }
}, 180_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe('the customer limits are unchanged', () => {
  it('keeps the published budgets', () => {
    expect(AUTH_LIMITS.endUserSignin.ip).toEqual({ limit: 10, windowMs: 15 * 60_000 })
    expect(AUTH_LIMITS.endUserSignup.ip).toEqual({ limit: 10, windowMs: 60 * 60_000 })
  })

  it('allows 10 sign-ins to a customer account from one address and refuses the 11th', async () => {
    expect(await signins(11, ACCOUNTS.customer)).toEqual(TEN_OK_THEN_429(200))
  }, 120_000)
})

describe('sign-in', () => {
  it('does not throttle the probe: valid token AND a reserved address', async () => {
    expect(await signins(15, ACCOUNTS.probe, token())).toEqual(Array(15).fill(200))
  }, 120_000)

  it('throttles the token on a customer account like any customer', async () => {
    expect(await signins(11, ACCOUNTS.tokenOnCustomer, token())).toEqual(TEN_OK_THEN_429(200))
  }, 120_000)

  it('throttles a reserved address that has no token', async () => {
    expect(await signins(11, ACCOUNTS.reservedNoToken)).toEqual(TEN_OK_THEN_429(200))
  }, 120_000)

  it('throttles a reserved address with a forged token', async () => {
    const forged = 'f'.repeat(token().length)
    expect(await signins(11, ACCOUNTS.reservedForged, forged)).toEqual(TEN_OK_THEN_429(200))
  }, 120_000)
})

describe('sign-up', () => {
  const tag = crypto.randomBytes(3).toString('hex')

  it('does not throttle the probe', async () => {
    expect(await signups(12, (i) => `__cv_${tag}p${i}@backenly.internal`, token())).toEqual(Array(12).fill(201))
  }, 180_000)

  it('throttles reserved addresses without the token on the 11th', async () => {
    expect(await signups(11, (i) => `__cv_${tag}n${i}@backenly.internal`)).toEqual(TEN_OK_THEN_429(201))
  }, 180_000)

  it('throttles the token on customer addresses on the 11th', async () => {
    expect(await signups(11, (i) => `real-${tag}${i}@example.test`, token())).toEqual(TEN_OK_THEN_429(201))
  }, 180_000)
})
