/**
 * A KEY EVERY USER OF AN APP SENDS IS LIMITED PER CLIENT (#618)
 * =============================================================
 * Every project key, the browser key all of an app's users share included, had
 * one window: 1,000 requests an hour, counted on the key, with a 429 for every
 * user of the app once it was spent. Seven open tabs heartbeating presence
 * every 25 seconds spent it alone. Driven here through the runtime
 * (server/app.ts on a port) and the Next v1 presence route in this process,
 * with a real project, keys and end-user tokens. Each client arrives through
 * a proxy the platform trusts, with its own address in X-Forwarded-For:
 *
 *   a shared key        each address gets the key's limit, and one at its
 *                       limit leaves another untouched, on every door: the v1
 *                       middleware, /db, /api/v2 and the Next routes, one
 *                       window per address across all of them
 *   the key's count     requests let through are still counted on the key,
 *                       past its limit, with its last use, for the console
 *   a service-role key  one window for the key, whoever calls, as before
 *   presence writes     joins, heartbeats and leaves spend nothing of the
 *                       key's limit; a user writing in a loop is refused after
 *                       60 a minute, and one address after 600, before its key
 *                       is even looked up
 *
 * The module on its own is pinned in tests/unit/shared-key-rate.spec.ts.
 */

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto, { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db'
import { GET as nextList, POST as nextJoin, DELETE as nextLeave } from '@/app/api/v1/[projectId]/presence/route'
import { closeRateLimitBackend } from '@/lib/security/rate-limit-backend'
import {
  PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE,
  PRESENCE_WRITES_PER_MINUTE,
  SHARED_KEY_BURST_LIMIT,
  countClientRequest,
} from '@/lib/security/shared-key-rate'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { hashApiKey } from '@/server/lib/end-user-identity'

jest.setTimeout(120_000)

let ownerId = ''
let projectId = ''
let jwtSecret = ''
let server: http.Server | undefined
let runtime = ''

/** A client of the app, by its address; documentation addresses (RFC 5737), none of them a proxy. */
let lastAddress = 0
const newAddress = () => `203.0.113.${++lastAddress}`

const userToken = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@limits.test`, projectId, role: 'user', jti: randomUUID() }, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })

/** A key of this project: a browser key unless `serviceRole`. */
/** A browser key; with no rate given, the schema's default, which nobody chose: the burst brake decides. */
async function makeKey(rateLimit = 1000, { serviceRole = false } = {}) {
  const raw = `${serviceRole ? 'svc' : 'proj'}_live_${crypto.randomBytes(24).toString('hex')}`
  const { id } = await prisma.apiKey.create({
    data: {
      name: `limits-${randomUUID()}`, keyPrefix: raw.slice(0, 16), keyHash: hashApiKey(raw),
      keyType: 'public', serviceRole, permissions: ['read', 'write'], capabilities: [],
      rateLimit, rateLimitWindow: 3600, projectId, userId: ownerId,
    },
    select: { id: true },
  })
  return { raw, id }
}

interface Call {
  key: string
  from: string
  token?: string
}
const headers = ({ key, from, token }: Call): Record<string, string> => ({
  'x-api-key': key,
  'x-forwarded-for': from,
  'content-type': 'application/json',
  ...(token ? { 'x-user-token': token } : {}),
})

/** One request through the runtime, on `path` under the project. */
const viaRuntime = (call: Call, path: string, init: RequestInit = {}) =>
  fetch(`${runtime}${path.startsWith('/api/') ? path : `/api/v1/${projectId}${path}`}`, { ...init, headers: headers(call) })

/** One request through the Next presence route in this process. */
async function viaNext(call: Call, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<Response> {
  const url = `http://next.backenly.test/api/v1/${projectId}/presence${method === 'DELETE' ? `?userId=${encodeURIComponent(String((body as any)?.userId))}` : ''}`
  const request = new NextRequest(url, { method, headers: headers(call), ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  const route = { GET: nextList, POST: nextJoin, DELETE: nextLeave }[method]
  return route(request, { params: Promise.resolve({ projectId }) })
}

/**
 * Spend all but `left` of an address's burst window with this key, as its
 * earlier requests would have: the same window, in the store this process
 * shares with the runtime it serves, so a test does not race the window with
 * hundreds of requests.
 */
async function spend(raw: string, id: string, from: string, left: number, rateLimit = 1000): Promise<void> {
  const key = { id, keyHash: hashApiKey(raw), rateLimit, rateLimitWindow: 3600, shared: true }
  const limit = rateLimit === 1000 ? SHARED_KEY_BURST_LIMIT : rateLimit
  for (let i = 0; i < limit - left; i++) await countClientRequest(key, from)
}

const list = (call: Call) => viaRuntime(call, '/presence')
const join = (call: Call, userId: string) =>
  viaRuntime(call, '/presence', { method: 'POST', body: JSON.stringify({ userId, metadata: { name: userId } }) })

const keyRow = (id: string) =>
  prisma.apiKey.findUniqueOrThrow({ where: { id }, select: { requestCount: true, lastUsed: true } })

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (
    await prisma.user.create({
      data: { email: `shared-key-limits-${randomUUID()}@example.test`, name: 'shared key limits fixture' },
      select: { id: true },
    })
  ).id
  jwtSecret = crypto.randomBytes(32).toString('hex')
  projectId = (
    await prisma.project.create({ data: { name: `shared-key-limits-${randomUUID()}`, userId: ownerId, jwtSecret }, select: { id: true } })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  runtime = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await closeRateLimitBackend()
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('a key every user of an app sends', () => {
  it(`gives each address ${SHARED_KEY_BURST_LIMIT} requests per 10 seconds through the runtime when the owner set no rate: one at it leaves another untouched`, async () => {
    const { raw, id } = await makeKey()
    const a = { key: raw, from: newAddress() }
    const b = { key: raw, from: newAddress() }

    await spend(raw, id, a.from, 2)
    for (let i = 0; i < 2; i++) expect((await list(a)).status).toBe(200)
    const refused = await list(a)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(10)
    expect(await refused.json()).toMatchObject({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: expect.stringContaining('300 requests per 10 second(s) from each address with this key') },
    })

    const other = await list(b)
    expect(other.status).toBe(200)
    expect(other.headers.get('x-ratelimit-limit')).toBe(String(SHARED_KEY_BURST_LIMIT))
    expect(other.headers.get('x-ratelimit-remaining')).toBe(String(SHARED_KEY_BURST_LIMIT - 1))
  })

  it('is counted per address on /db and /api/v2 too, one window across both doors', async () => {
    const { raw, id } = await makeKey()
    const a = { key: raw, from: newAddress() }
    const b = { key: raw, from: newAddress() }

    await spend(raw, id, a.from, 2)
    expect((await viaRuntime(a, '/db/notes')).status).not.toBe(429)
    expect((await viaRuntime(a, `/api/v2/${projectId}/notes`)).status).not.toBe(429)
    expect((await viaRuntime(a, '/db/notes')).status).toBe(429)
    expect((await viaRuntime(a, `/api/v2/${projectId}/notes`)).status).toBe(429)

    expect((await viaRuntime(b, '/db/notes')).status).not.toBe(429)
    expect((await viaRuntime(b, `/api/v2/${projectId}/notes`)).status).not.toBe(429)
  })

  it('holds each address to the burst brake through the Next routes, one window per address with the runtime', async () => {
    const { raw, id } = await makeKey()
    const a = { key: raw, from: newAddress() }
    const b = { key: raw, from: newAddress() }

    await spend(raw, id, a.from, 3)
    expect((await viaNext(a, 'GET')).status).toBe(200)
    expect((await list(a)).status).toBe(200)
    expect((await viaNext(a, 'GET')).status).toBe(200)
    expect((await viaNext(a, 'GET')).status).toBe(429)
    expect((await list(a)).status).toBe(429)

    expect((await viaNext(b, 'GET')).status).toBe(200)
  })

  it('holds each address to the rate its owner set, on both runtimes, and another address is untouched', async () => {
    // Lowered, to hold each visitor to less.
    const { raw, id } = await makeKey(5)
    const a = { key: raw, from: newAddress() }
    await spend(raw, id, a.from, 2, 5)
    expect((await list(a)).status).toBe(200)
    expect((await viaNext(a, 'GET')).status).toBe(200)
    const refused = await list(a)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({
      error: { message: expect.stringContaining('5 requests per 60 minute(s) from each address with this key') },
    })
    expect((await viaNext(a, 'GET')).status).toBe(429)
    expect((await list({ key: raw, from: newAddress() })).status).toBe(200)
  })

  it('lets one address past the burst brake when the owner raised the rate for it, as a server or a load test needs', async () => {
    const { raw, id } = await makeKey(100_000)
    const a = { key: raw, from: newAddress() }
    // Further than a key with no rate set would go from one address in ten seconds.
    await spend(raw, id, a.from, 100_000 - SHARED_KEY_BURST_LIMIT - 10, 100_000)
    const statuses: number[] = []
    for (let i = 0; i < 20; i++) statuses.push((await list(a)).status)
    expect(statuses.every((s) => s === 200)).toBe(true)
    const last = await list(a)
    expect(last.headers.get('x-ratelimit-limit')).toBe('100000')
  })

  it("is still counted on the key, with its last use, for the console", async () => {
    const { raw, id } = await makeKey()
    for (const from of [newAddress(), newAddress(), newAddress()]) {
      for (let i = 0; i < 3; i++) await list({ key: raw, from })
    }
    // All nine let through (each address is far from its burst brake) and
    // counted on the key, whose own count decides nothing here.
    const row = await keyRow(id)
    expect(row.requestCount).toBe(9)
    expect(Math.abs(row.lastUsed!.getTime() - Date.now())).toBeLessThan(60_000)
  })
})

describe('a key one caller holds', () => {
  it('has one window for the key, whichever address calls, as before', async () => {
    const { raw, id } = await makeKey(3, { serviceRole: true })
    for (let i = 0; i < 3; i++) expect((await list({ key: raw, from: newAddress() })).status).toBe(200)
    const refused = await list({ key: raw, from: newAddress() })
    expect(refused.status).toBe(429)
    expect((await refused.json()).error.message).not.toContain('each address')
    expect((await keyRow(id)).requestCount).toBe(3)
  })
})

describe('presence writes', () => {
  it("spend nothing of a shared key's limit, through the runtime and the Next route", async () => {
    const { raw } = await makeKey(3)
    const userId = randomUUID()
    const signedIn = { key: raw, from: newAddress(), token: userToken(userId) }

    for (let i = 0; i < 8; i++) expect((await join(signedIn, userId)).status).toBe(200)
    for (let i = 0; i < 8; i++) expect((await viaNext(signedIn, 'POST', { userId, metadata: {} })).status).toBe(200)
    expect((await viaRuntime(signedIn, `/presence?userId=${userId}`, { method: 'DELETE' })).status).toBe(200)
    expect((await viaNext(signedIn, 'DELETE', { userId })).status).toBe(200)

    // Eighteen presence writes, and the address's three requests (its owner's rate) are all still there.
    const read = await list(signedIn)
    expect(read.status).toBe(200)
    expect(read.headers.get('x-ratelimit-remaining')).toBe('2')
  })

  it(`are refused after ${PRESENCE_WRITES_PER_MINUTE} a minute for one user, on both runtimes, and another user is untouched`, async () => {
    const { raw } = await makeKey(1000)
    const userId = randomUUID()
    const writer = { key: raw, from: newAddress(), token: userToken(userId) }

    for (let i = 0; i < PRESENCE_WRITES_PER_MINUTE; i++) expect((await join(writer, userId)).status).toBe(200)
    const refused = await join(writer, userId)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' })
    expect((await viaNext(writer, 'POST', { userId, metadata: {} })).status).toBe(429)

    const other = randomUUID()
    expect((await join({ key: raw, from: writer.from, token: userToken(other) }, other)).status).toBe(200)
  })

  it(`are refused after ${PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE} a minute from one address, before the key is looked up, on both runtimes`, async () => {
    // A key nobody issued: every write is refused for it, until the address's window refuses first.
    const flood = { key: `proj_live_${crypto.randomBytes(24).toString('hex')}`, from: newAddress() }
    for (let i = 0; i < PRESENCE_WRITES_PER_ADDRESS_PER_MINUTE; i++) expect((await join(flood, 'anyone')).status).toBe(401)

    const refused = await join(flood, 'anyone')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', error: expect.stringContaining('from this address') })
    expect((await viaNext(flood, 'POST', { userId: 'anyone' })).status).toBe(429)

    expect((await join({ ...flood, from: newAddress() }, 'anyone')).status).toBe(401)
  })
})
