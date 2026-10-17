/**
 * NEXT'S OWN /api/v1/{projectId} ROUTES SERVE ONLY A PROJECT THE RUNTIME WOULD
 * ============================================================================
 * The runtime refuses every /api/v1/{projectId} request for a project that is
 * locked or paused (server/lib/serving-gate.ts). Next owns some of those routes
 * outright: end-user sign-in, sign-up, refresh, logout and recovery, realtime,
 * storage, functions and healthz. Every one is wrapped by recordedV1, which now
 * makes the same decision from the same reader, with the same codes and words.
 *
 * Pinned against a real database and the real route handlers:
 *
 *   serving   each route reaches its own handler (no gate answer)
 *   locked    each route answers 503 FORBIDDEN with the runtime's lock message
 *   paused    each route answers 503 PROJECT_PAUSED with the paused details
 *   lifted    the same requests reach their handlers again
 */
import '@/tests/helpers/real-web-standard'

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { invalidateProjectServingState, PAUSED_CODE } from '@/lib/projects/serving-state'
import { LOCKED_MESSAGE } from '@/lib/projects/serving-response'

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

type Call = { name: string; run: () => Promise<Response> }

function request(path: string, method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/${projectId}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'serving-gate-suite' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const params = () => ({ params: Promise.resolve({ projectId }) })

const calls: Call[] = [
  { name: 'healthz', run: async () => (await import('@/app/api/v1/[projectId]/healthz/route')).GET(request('/healthz', 'GET'), params()) },
  { name: 'auth/signin', run: async () => (await import('@/app/api/v1/[projectId]/auth/signin/route')).POST(request('/auth/signin', 'POST', { email: 'nobody@example.test', password: 'not-a-real-password' }), params()) },
  { name: 'auth/signup', run: async () => (await import('@/app/api/v1/[projectId]/auth/signup/route')).POST(request('/auth/signup', 'POST', { email: 'new@example.test', password: 'not-a-real-password-1' }), params()) },
  { name: 'auth/refresh-token', run: async () => (await import('@/app/api/v1/[projectId]/auth/refresh-token/route')).POST(request('/auth/refresh-token', 'POST', { token: 'not-a-token' }), params()) },
  { name: 'auth/logout', run: async () => (await import('@/app/api/v1/[projectId]/auth/logout/route')).POST(request('/auth/logout', 'POST', { token: 'not-a-token' }), params()) },
  { name: 'auth/forgot-password', run: async () => (await import('@/app/api/v1/[projectId]/auth/forgot-password/route')).POST(request('/auth/forgot-password', 'POST', { email: 'nobody@example.test' }), params()) },
]

async function bodyOf(res: Response): Promise<any> {
  return res.clone().json().catch(() => ({}))
}

/** The gate's answers carry these codes; a route's own answer never does with this status pair. */
function gateCode(body: any): string | undefined {
  return body?.error?.code ?? body?.code
}

async function setState(state: { lockedDownAt?: Date | null; pausedAt?: Date | null }) {
  await prisma.project.update({ where: { id: projectId }, data: state as any })
  invalidateProjectServingState(projectId)
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `serving-gate-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'Serving Gate Suite' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'serving-gate', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
      select: { id: true },
    })
  ).id
}, 60_000)

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('a serving project', () => {
  it.each(calls.map((c) => [c.name, c] as const))('%s reaches its own handler', async (_name, call) => {
    await setState({ lockedDownAt: null, pausedAt: null })
    const res = await call.run()
    const body = await bodyOf(res)
    expect(gateCode(body)).not.toBe(PAUSED_CODE)
    expect(JSON.stringify(body)).not.toContain(LOCKED_MESSAGE)
  }, 60_000)
})

describe('a locked project', () => {
  it.each(calls.map((c) => [c.name, c] as const))('%s answers the runtime gate\'s 503', async (_name, call) => {
    await setState({ lockedDownAt: new Date(), pausedAt: null })
    try {
      const res = await call.run()
      const body = await bodyOf(res)
      expect(res.status).toBe(503)
      expect(gateCode(body)).toBe('FORBIDDEN')
      expect(JSON.stringify(body)).toContain(LOCKED_MESSAGE)
    } finally {
      await setState({ lockedDownAt: null })
    }
  }, 60_000)
})

describe('a paused project', () => {
  it.each(calls.map((c) => [c.name, c] as const))('%s answers the paused 503 with its details', async (_name, call) => {
    await setState({ lockedDownAt: null, pausedAt: new Date() })
    try {
      const res = await call.run()
      const body = await bodyOf(res)
      expect(res.status).toBe(503)
      expect(gateCode(body)).toBe(PAUSED_CODE)
      expect(JSON.stringify(body)).toContain(projectId)
    } finally {
      await setState({ pausedAt: null })
    }
  }, 60_000)
})

describe('lifting the lock', () => {
  it('lets the same request reach its handler again', async () => {
    await setState({ lockedDownAt: new Date(), pausedAt: null })
    expect((await calls[0].run()).status).toBe(503)
    await setState({ lockedDownAt: null })
    const res = await calls[0].run()
    expect(JSON.stringify(await bodyOf(res))).not.toContain(LOCKED_MESSAGE)
  }, 60_000)
})
