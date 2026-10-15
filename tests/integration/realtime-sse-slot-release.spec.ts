/**
 * A CLIENT THAT LEAVES DURING THE SUBSCRIBE AWAIT GIVES ITS SLOT BACK
 * ===================================================================
 * Both SSE routes registered their close/abort cleanup around an awaited
 * listenerHub.subscribe(...) and only assigned `subscription` afterwards. A
 * client that disconnected DURING that await (React StrictMode remount, tab
 * navigation, the SDK recycling a connection when its filter changes) ran
 * cleanup while `subscription` was still null — and the slot the hub had
 * already reserved was never released. Each occurrence permanently consumed
 * one of the plan's concurrent-connection slots (Free = 25) until the process
 * restarted; enough churn killed realtime for the project with zero live
 * clients.
 *
 * The hub is the one seam stubbed here, with a GATE so the disconnect lands
 * deterministically inside the await. The routes, their auth, and the
 * cleanup wiring are real.
 */

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { listenerHub } from '@/lib/realtime/listener-hub'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let apiKey = ''
let server: http.Server
let base = ''

// One controlled subscribe per test: resolves when the test says so, and
// records whether the route released the reservation.
let releaseGate: () => void = () => {}
let subscribeEntered: Promise<void> = Promise.resolve()
let unsubscribed = false

function armHub() {
  unsubscribed = false
  let enteredResolve: () => void
  subscribeEntered = new Promise<void>((r) => { enteredResolve = r })
  const gate = new Promise<void>((r) => { releaseGate = r })
  jest.spyOn(listenerHub, 'subscribe').mockImplementation(async () => {
    enteredResolve!()
    await gate
    return { ok: true as const, channel: 'test-channel', unsubscribe: () => { unsubscribed = true } }
  })
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `sse-slot-${randomUUID()}@test.invalid`, name: 'SSE Slot Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `sse-slot-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  apiKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'sse-slot',
      keyPrefix: apiKey.slice(0, 16),
      keyHash: hashApiKey(apiKey),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      scope: 'runtime',
      serviceRole: false,
      rateLimit: 1000,
    },
  })

  const { default: app } = await import('@/server/app')
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  jest.restoreAllMocks()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

describe('Express SSE route', () => {
  it('releases the reservation when the socket closes during the subscribe await', async () => {
    armHub()
    const req = http.get(`${base}/api/v1/${projectId}/realtime?apiKey=${apiKey}`)
    req.on('error', () => {}) // the deliberate destroy below surfaces as ECONNRESET
    await subscribeEntered // the route is now inside the await
    req.destroy() // client leaves mid-subscribe
    await new Promise((r) => setTimeout(r, 100)) // let the close handler run first
    releaseGate() // subscribe now resolves with a reserved slot
    expect(await until(() => unsubscribed)).toBe(true)
  }, 60_000)
})

describe('Next.js SSE route', () => {
  it('releases the reservation when the client aborts during the subscribe await', async () => {
    armHub()
    const controller = new AbortController()
    const headers = new Headers()
    headers.set('x-api-key', apiKey)
    const request: any = {
      method: 'GET',
      url: `http://localhost:3000/api/v1/${projectId}/realtime`,
      nextUrl: { pathname: `/api/v1/${projectId}/realtime`, searchParams: new URLSearchParams() },
      headers,
      cookies: { get: () => undefined },
      signal: controller.signal,
      json: async () => ({}),
    }
    const { GET } = await import('@/app/api/v1/[projectId]/realtime/route')
    const resPromise = GET(request, { params: Promise.resolve({ projectId }) })
    await subscribeEntered
    controller.abort()
    await new Promise((r) => setTimeout(r, 100))
    releaseGate()
    expect(await until(() => unsubscribed)).toBe(true)
    await resPromise.catch(() => {})
  }, 60_000)
})
