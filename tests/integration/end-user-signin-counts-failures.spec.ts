/**
 * An end user who knows their password is never told "Too many attempts".
 *
 * Reported from a real app: a shop built on Backenly, deployed, and its
 * customers could not sign in, answered with a rate-limit error. Sign-in spent
 * 10 per 15 minutes on every request, successful ones included, per address and
 * per account. So a shopper signing in and out was refused on the eleventh
 * go, and every shopper behind one shared address (an office, a campus, a
 * mobile carrier's NAT, or the shop's own server calling sign-in for them)
 * shared those ten.
 *
 * Both runtimes serve this endpoint: Next where Next is the ingress (AWS,
 * compose), Express where it is (single box). Each case runs against both,
 * through the real routes, real bcrypt and the real limiter, and each runtime
 * gets a project of its own, because the two share one limiter in this process.
 *
 * Guessing must still be refused, so every "never refused" case sits beside a
 * case where wrong passwords are.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { POST as nextSignin } from '@/app/api/v1/[projectId]/auth/signin/route'
import { hashPassword } from '@/lib/auth/password'
import { AUTH_LIMITS } from '@/lib/security/auth-rate-limit'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

const PASSWORD = 'Correct-Horse-Battery-9!'
const WRONG = 'not-the-password'
const SIGNIN = AUTH_LIMITS.endUserSignin
/** More shoppers behind one address than any failure budget allows. */
const SHOPPERS = SIGNIN.ipFailures.limit + 5

let server: http.Server
let base: string
let ownerId: string
const schemas: string[] = []
let ipCounter = 0
const freshIp = () => `198.18.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`

interface Answer { status: number; body: any; retryAfter: string | null }

type Runtime = (projectId: string, email: string, password: string, ip: string) => Promise<Answer>

const runtimes: Record<'next' | 'express', Runtime> = {
  // The Next handler, called directly. Only the transport envelope is
  // constructed: jest.setup.js stubs the global Request, so a NextRequest
  // cannot be built here (signin-enumeration.spec.ts has the details).
  next: async (projectId, email, password, ip) => {
    const headers = new Map([['content-type', 'application/json'], ['x-forwarded-for', ip]])
    const res = await nextSignin(
      {
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => ({ email, password }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ projectId }) },
    )
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') }
  },
  express: async (projectId, email, password, ip) => {
    const res = await fetch(`${base}/api/v1/${projectId}/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    })
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') }
  },
}

/** A project with a users table holding `emails`, all with PASSWORD. */
async function project(label: string, emails: string[]): Promise<string> {
  const { id } = await prisma.project.create({
    data: {
      name: `signin-failures-${label}`,
      userId: ownerId,
      description: 'end-user sign-in counts failures',
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true },
  })
  const schema = `workspace_${id}`
  schemas.push(schema)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."users" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
       name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now())`,
  )
  const hash = await hashPassword(PASSWORD)
  for (const email of emails) {
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (email, password) VALUES ($1, $2)`, email, hash)
  }
  return id
}

const shoppers = Array.from({ length: SHOPPERS }, (_, i) => `shopper-${i}@example.test`)
const accounts = ['regular@example.test', 'victim@example.test', 'bystander@example.test', ...shoppers]
const projects: Record<string, string> = {}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: {
      email: `signin-failures-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Sign-in Failures Suite',
    },
    select: { id: true },
  })).id
  for (const name of Object.keys(runtimes)) projects[name] = await project(name, accounts)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  // The routes record each request; write those rows before their project goes.
  await flushRecordedRequests().catch(() => {})
  for (const schema of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
}, 120_000)

describe.each(Object.keys(runtimes) as Array<keyof typeof runtimes>)('%s runtime', (name) => {
  const signin = (email: string, password: string, ip: string) => runtimes[name](projects[name], email, password, ip)

  it('lets one shopper sign in again and again from one address', async () => {
    const ip = freshIp()
    const statuses: number[] = []
    for (let i = 0; i < 15; i++) statuses.push((await signin('regular@example.test', PASSWORD, ip)).status)
    // It was ten 200s and then 429s.
    expect(statuses).toEqual(Array(15).fill(200))
  }, 120_000)

  it('lets every shopper behind one shared address sign in', async () => {
    const ip = freshIp()
    const statuses: number[] = []
    for (const email of shoppers) statuses.push((await signin(email, PASSWORD, ip)).status)
    expect(statuses).toEqual(Array(SHOPPERS).fill(200))
  }, 180_000)

  it('still locks an account after ten wrong passwords, from rotating addresses', async () => {
    const statuses: number[] = []
    for (let i = 0; i < SIGNIN.accountFailures.limit; i++) {
      statuses.push((await signin('victim@example.test', WRONG, freshIp())).status)
    }
    expect(statuses).toEqual(Array(SIGNIN.accountFailures.limit).fill(401))

    const locked = await signin('victim@example.test', WRONG, freshIp())
    expect(locked.status).toBe(429)
    expect(locked.body.error.code).toBe('RATE_LIMIT_EXCEEDED')

    // Refused before the password is looked at: the right one does not get
    // through a lock the guesses caused.
    expect((await signin('victim@example.test', PASSWORD, freshIp())).status).toBe(429)

    // CONTROL: the lock is on that account, not on the project or the address.
    const ip = freshIp()
    expect((await signin('victim@example.test', PASSWORD, ip)).status).toBe(429)
    expect((await signin('bystander@example.test', PASSWORD, ip)).status).toBe(200)
  }, 120_000)

  it('still refuses one address guessing across many accounts', async () => {
    const ip = freshIp()
    const statuses: number[] = []
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) {
      statuses.push((await signin(`nobody-${i}@example.test`, WRONG, ip)).status)
    }
    expect(statuses).toEqual(Array(SIGNIN.ipFailures.limit).fill(401))
    expect((await signin('nobody-next@example.test', WRONG, ip)).status).toBe(429)

    // CONTROL: another address in the project is unaffected.
    expect((await signin('bystander@example.test', PASSWORD, freshIp())).status).toBe(200)
  }, 180_000)

  it('does not give a made-up X-Forwarded-For a fresh budget', async () => {
    // The load balancer appends the real address; whatever the client wrote
    // stays in front of it. The limit used to key on that front entry, so a
    // new made-up value per request was a new budget per request.
    const real = freshIp()
    const statuses: number[] = []
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) {
      statuses.push((await signin(`spoof-${i}@example.test`, WRONG, `100.${i}.7.7, ${real}`)).status)
    }
    expect(statuses).toEqual(Array(SIGNIN.ipFailures.limit).fill(401))
    expect((await signin('spoof-next@example.test', WRONG, `100.250.7.7, ${real}`)).status).toBe(429)
  }, 180_000)
})

it('both runtimes give the same refusal', async () => {
  // Two implementations of one endpoint, so one answer. The Express one used to
  // carry its own message and its own limit of 30 per 15 minutes.
  const refusals: Answer[] = []
  for (const name of Object.keys(runtimes) as Array<keyof typeof runtimes>) {
    const ip = freshIp()
    for (let i = 0; i < SIGNIN.ipFailures.limit; i++) await runtimes[name](projects[name], `same-${i}@example.test`, WRONG, ip)
    refusals.push(await runtimes[name](projects[name], 'same-next@example.test', WRONG, ip))
  }
  expect(refusals.map((r) => r.status)).toEqual([429, 429])
  expect(refusals[0].body).toEqual(refusals[1].body)
  // Read over real HTTP, so only from Express: jest.setup.js stubs the global
  // Response the Next handler builds, and its headers read back null here
  // (lib/security/rate-limit-response.ts). Both send throttleDecision's headers.
  expect(Number(refusals[1].retryAfter)).toBeGreaterThan(0)
}, 240_000)
