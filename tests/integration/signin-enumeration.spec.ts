/**
 * SIGN-IN MUST NOT SAY WHICH ACCOUNTS EXIST
 * =========================================
 *
 * Two oracles were found in `/api/v1/{projectId}/auth/signin`, both usable with
 * no credentials at all:
 *
 *  1. STATUS. The `is_blocked` check ran BEFORE the password was verified, so
 *     submitting any address with a junk password returned 403 for a suspended
 *     account and 401 for everything else. That is account enumeration, plus
 *     disclosure of moderation state, to an anonymous caller.
 *
 *  2. TIMING. An unknown address returned immediately; a real one first paid
 *     for a bcrypt comparison. The messages already matched, and bcrypt is
 *     tuned to be slow enough that the difference is measurable in a handful
 *     of samples.
 *
 * These are regression tests, not a constant-time framework. The status oracle
 * is exactly reproducible and is asserted exactly. The timing one is asserted
 * as a FLOOR on the work done for a nonexistent address — which is the property
 * that actually closed it — rather than as a ratio between two measurements,
 * because a ratio on a shared CI runner is a flake generator and would end up
 * being loosened until it proved nothing.
 *
 * The route is driven for real: a real project, a real workspace schema, real
 * bcrypt hashes, and the actual exported POST handler. A unit test of the
 * comparison helper would have been green throughout the period both oracles
 * were open.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import { POST as signin } from '@/app/api/v1/[projectId]/auth/signin/route'
import { hashPassword, verifyPassword, verifyPasswordAgainstDecoy } from '@/lib/auth/password'

const prisma = new PrismaClient()

const GOOD_PASSWORD = 'Correct-Horse-Battery-9'
const WRONG_PASSWORD = 'Wrong-Horse-Battery-9'

let ownerId: string
let projectId: string
let schema: string

/**
 * The request surface the handler actually consumes.
 *
 * NOT a NextRequest, because one cannot be constructed here: `jest.setup.js`
 * replaces `global.Request` with a stub whose constructor assigns `this.url`,
 * and `NextRequest` declares `url` as a getter, so `new NextRequest(...)`
 * throws before the test starts. This is the same environment hazard
 * `lib/security/outbound-guard.ts` documents for `Response`.
 *
 * Supplying the two members the route reads is not mocking what is under test.
 * The route's own logic, the ordering of its checks, the workspace query,
 * bcrypt and the rate limiter all run for real; only the transport envelope is
 * constructed here, and the envelope is not the thing being asserted.
 *
 * Sign-in is IP-limited, so every case gets an address of its own — otherwise
 * one case's attempts throttle the next and a 401 assertion quietly becomes a
 * 429.
 */
let ipCounter = 0
function request(body: Record<string, unknown>): NextRequest {
  ipCounter += 1
  const headers = new Map<string, string>([
    ['content-type', 'application/json'],
    ['x-forwarded-for', `203.0.113.${ipCounter % 250}`],
  ])
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as NextRequest
}

async function attempt(body: Record<string, unknown>) {
  const res = await signin(request(body), { params: Promise.resolve({ projectId }) })
  return { status: res.status, body: await res.json() }
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `signin-enum-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Signin Enumeration Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id

  const project = await prisma.project.create({
    data: {
      name: 'signin-enumeration',
      userId: ownerId,
      description: 'signin enumeration suite',
      // The route refuses outright below 32 characters.
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true },
  })
  projectId = project.id
  schema = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."users" (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email      text UNIQUE NOT NULL,
       password   text NOT NULL,
       name       text,
       role       text DEFAULT 'user',
       is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )

  const hash = await hashPassword(GOOD_PASSWORD)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" (email, password, name, is_blocked)
     VALUES ('active@example.test', $1, 'Active', false),
            ('blocked@example.test', $1, 'Blocked', true)`,
    hash,
  )
}, 180_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe('the fixture is real, so the assertions below mean something', () => {
  it('lets a correct password through, which is the control for every refusal', async () => {
    const ok = await attempt({ email: 'active@example.test', password: GOOD_PASSWORD })

    // Without this, every "returns 401" test below would also pass against a
    // sign-in route that was simply broken for all inputs.
    expect(ok.status).toBe(200)
    expect(ok.body.data.token).toBeTruthy()
    expect(ok.body.data.user.email).toBe('active@example.test')
  }, 60_000)

  it('has a genuinely suspended account, not merely a row with a flag nobody reads', async () => {
    const rows = await prisma.$queryRawUnsafe<{ email: string; is_blocked: boolean }[]>(
      `SELECT email, is_blocked FROM "${schema}"."users" ORDER BY email`,
    )
    expect(rows).toEqual([
      { email: 'active@example.test', is_blocked: false },
      { email: 'blocked@example.test', is_blocked: true },
    ])
  })
})

describe('the status oracle: suspension is not observable before the password is proven', () => {
  it('answers a blocked account with a WRONG password exactly like any other failure', async () => {
    const blocked = await attempt({ email: 'blocked@example.test', password: WRONG_PASSWORD })
    const unknown = await attempt({ email: 'nobody@example.test', password: WRONG_PASSWORD })
    const active = await attempt({ email: 'active@example.test', password: WRONG_PASSWORD })

    // The regression this pins: 403 here told an anonymous caller both that the
    // address exists and that it is suspended.
    expect(blocked.status).toBe(401)

    // All three indistinguishable, in status and in body.
    expect(active.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(blocked.body).toEqual(unknown.body)
    expect(blocked.body).toEqual(active.body)
    expect(blocked.body.error.message).toBe('Invalid email or password')
  }, 60_000)

  it('tells the account holder it is suspended, once they have proven the password', async () => {
    const proven = await attempt({ email: 'blocked@example.test', password: GOOD_PASSWORD })

    // Not withheld from the person entitled to know why they cannot get in.
    // Asserted so that "matched responses" is never achieved by deleting the
    // suspension check altogether.
    expect(proven.status).toBe(403)
    expect(proven.body.error.message).toMatch(/suspended/i)
  }, 60_000)

  it('never issues a token to a suspended account', async () => {
    const proven = await attempt({ email: 'blocked@example.test', password: GOOD_PASSWORD })
    expect(JSON.stringify(proven.body)).not.toMatch(/token/)
  }, 60_000)
})

describe('the timing oracle: an unknown address costs what a known one costs', () => {
  it('spends bcrypt work on an address that does not exist', async () => {
    // The floor is the property that closed the oracle. Removing the decoy
    // makes the unknown-address path return in about a millisecond, so a floor
    // set well below one bcrypt round is both robust on a loaded runner and
    // impossible to satisfy without doing the work.
    const knownCost = await measure(() => verifyPassword(WRONG_PASSWORD, decoyShapedHash))
    const decoyCost = await measure(() => verifyPasswordAgainstDecoy(WRONG_PASSWORD))

    // CONTROL: bcrypt at this cost factor really is slow here. If this floor
    // failed, the assertion below would be meaningless rather than wrong.
    expect(knownCost).toBeGreaterThan(20)
    expect(decoyCost).toBeGreaterThan(20)
  }, 120_000)

  it('the ROUTE itself spends that work, not merely the helper', async () => {
    // The test above proves the helper is expensive. This proves the route
    // calls it: without the decoy, the unknown-address path returns in single
    // -digit milliseconds because it never reaches a comparison at all.
    //
    // A floor rather than a comparison between the two paths. On a loaded
    // runner a ratio drifts and gets loosened until it proves nothing, while
    // the floor is unsatisfiable without doing a bcrypt round.
    const unknown = await measure(() =>
      attempt({ email: 'definitely-nobody@example.test', password: WRONG_PASSWORD }),
    )
    const known = await measure(() =>
      attempt({ email: 'active@example.test', password: WRONG_PASSWORD }),
    )

    // CONTROL: the known-address path is the cost being disguised, so if IT
    // were fast the floor below would be meaningless rather than wrong.
    expect(known).toBeGreaterThan(20)
    expect(unknown).toBeGreaterThan(20)
  }, 120_000)

  it('the decoy always fails, so it can never authenticate anybody', async () => {
    // It is compared against a random secret, so no submitted value can match.
    // Worth pinning: a decoy that ever returned true would be an auth bypass on
    // every address that does not exist.
    await expect(verifyPasswordAgainstDecoy('')).resolves.toBe(false)
    await expect(verifyPasswordAgainstDecoy(GOOD_PASSWORD)).resolves.toBe(false)
    await expect(verifyPasswordAgainstDecoy(WRONG_PASSWORD)).resolves.toBe(false)
  }, 120_000)
})

/** A real hash at the product's cost factor, for the control measurement. */
let decoyShapedHash: string
beforeAll(async () => {
  decoyShapedHash = await hashPassword('something-nobody-submits')
}, 120_000)

async function measure(fn: () => Promise<unknown>): Promise<number> {
  const started = Date.now()
  await fn()
  return Date.now() - started
}
