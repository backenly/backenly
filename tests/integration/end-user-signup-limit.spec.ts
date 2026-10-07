/**
 * End-user sign-up lets a shared address bring in its customers, and still
 * keeps "already registered" (the existence oracle) at ten an hour.
 *
 * Sign-up was 10 per hour per address on every attempt, so a launch where
 * customers share an address (a campus, an office, a frontend signing users up
 * from its own server) was refused on the eleventh customer. Both runtimes
 * serve this endpoint and used to hold different rules too: Express gave any
 * reserved test address a bucket of 100 on the address alone, while Next
 * exempted only Backenly's signed probe. Each case runs against both, through
 * the real routes and a real workspace, with a project per runtime because the
 * two share one limiter in this process.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { POST as nextSignup } from '@/app/api/v1/[projectId]/auth/signup/route'
import { AUTH_LIMITS } from '@/lib/security/auth-rate-limit'
import { flushRecordedRequests, INTERNAL_TRAFFIC_HEADER, internalTrafficToken } from '@/lib/traffic/request-recorder'

const PASSWORD = 'Correct-Horse-Battery-9!'
const SIGNUP = AUTH_LIMITS.endUserSignup
/** More customers from one address than the old limit allowed. */
const CUSTOMERS = 15

let server: http.Server
let base: string
let ownerId: string
const projects: Record<string, string> = {}
let ipCounter = 0
const freshIp = () => `198.19.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`
const tag = crypto.randomBytes(3).toString('hex')

type Runtime = (projectId: string, email: string, ip: string, internal?: string) => Promise<{ status: number; body: any }>

const runtimes: Record<'next' | 'express', Runtime> = {
  // The Next handler, called directly (jest.setup.js stubs the global Request;
  // signin-enumeration.spec.ts has the details).
  next: async (projectId, email, ip, internal) => {
    const headers = new Map([['content-type', 'application/json'], ['x-forwarded-for', ip]])
    if (internal) headers.set(INTERNAL_TRAFFIC_HEADER, internal)
    const res = await nextSignup(
      {
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: async () => ({ email, password: PASSWORD, name: 'x' }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ projectId }) },
    )
    return { status: res.status, body: await res.json() }
  },
  express: async (projectId, email, ip, internal) => {
    const res = await fetch(`${base}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...(internal ? { [INTERNAL_TRAFFIC_HEADER]: internal } : {}),
      },
      body: JSON.stringify({ email, password: PASSWORD, name: 'x' }),
    })
    return { status: res.status, body: await res.json() }
  },
}

beforeAll(async () => {
  expect(internalTrafficToken()).toBeTruthy()
  ownerId = (await prisma.user.create({
    data: {
      email: `signup-limit-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Sign-up Limit Suite',
    },
    select: { id: true },
  })).id
  for (const name of Object.keys(runtimes)) {
    const id = (await prisma.project.create({
      data: {
        name: `signup-limit-${name}`,
        userId: ownerId,
        description: 'end-user sign-up limit',
        jwtSecret: crypto.randomBytes(32).toString('hex'),
      },
      select: { id: true },
    })).id
    projects[name] = id
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${id}"`)
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "workspace_${id}"."users" (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
         name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now())`,
    )
  }

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  for (const id of Object.values(projects)) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
}, 120_000)

describe.each(Object.keys(runtimes) as Array<keyof typeof runtimes>)('%s runtime', (name) => {
  const signup = (email: string, ip: string, internal?: string) => runtimes[name](projects[name], email, ip, internal)

  it('lets more customers sign up from one shared address than the old limit of ten', async () => {
    const ip = freshIp()
    const statuses: number[] = []
    for (let i = 0; i < CUSTOMERS; i++) statuses.push((await signup(`customer-${tag}-${i}@example.test`, ip)).status)
    // It was ten 201s and then 429s.
    expect(statuses).toEqual(Array(CUSTOMERS).fill(201))
  }, 180_000)

  it('still refuses the eleventh "already registered" answer to one address', async () => {
    const ip = freshIp()
    const taken = `taken-${tag}@example.test`
    const statuses: number[] = []
    for (let i = 0; i < SIGNUP.ipConflicts.limit + 2; i++) statuses.push((await signup(taken, ip)).status)
    expect(statuses).toEqual([201, ...Array(SIGNUP.ipConflicts.limit).fill(409), 429])

    // Refused before the lookup, so a free address from there gets the same
    // answer: the 429 says nothing about which addresses are registered.
    expect((await signup(`free-${tag}@example.test`, ip)).status).toBe(429)
    // CONTROL: the same free address from another address signs up.
    expect((await signup(`free-${tag}@example.test`, freshIp())).status).toBe(201)
  }, 180_000)

  it('exempts Backenly\'s probe only with its signed token', async () => {
    const probe = `__cv_${tag}${name}p@backenly.internal`
    const unsigned = `__cv_${tag}${name}u@backenly.internal`
    const n = SIGNUP.ipConflicts.limit + 2

    const signed: number[] = []
    const probeIp = freshIp()
    for (let i = 0; i < n; i++) signed.push((await signup(probe, probeIp, internalTrafficToken()!)).status)
    expect(signed).toEqual([201, ...Array(n - 1).fill(409)])

    // A reserved address alone is counted like anyone's. Express used to give
    // it a bucket of its own on the address.
    const counted: number[] = []
    const plainIp = freshIp()
    for (let i = 0; i < n; i++) counted.push((await signup(unsigned, plainIp)).status)
    expect(counted).toEqual([201, ...Array(SIGNUP.ipConflicts.limit).fill(409), 429])
  }, 180_000)
})

it('both runtimes give the same refusal', async () => {
  const refusals: any[] = []
  for (const name of Object.keys(runtimes) as Array<keyof typeof runtimes>) {
    const ip = freshIp()
    const taken = `same-${tag}-${name}@example.test`
    for (let i = 0; i < SIGNUP.ipConflicts.limit + 1; i++) await runtimes[name](projects[name], taken, ip)
    refusals.push(await runtimes[name](projects[name], taken, ip))
  }
  expect(refusals.map((r) => r.status)).toEqual([429, 429])
  expect(refusals[0].body).toEqual(refusals[1].body)
}, 180_000)
