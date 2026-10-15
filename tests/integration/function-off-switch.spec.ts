/**
 * THE FUNCTION OFF SWITCH SWITCHES EVERY DOOR OFF — AND ONLY THE SWITCH DOES
 * ==========================================================================
 * The console Power toggle and MCP set_active write `status: 'inactive'`, but
 * the four invocation gates each kept their own status list:
 *
 *   - the public /fn/ endpoint and the deep executor refused only the older
 *     'disabled'/'deleted' spellings, so a function its owner had switched off
 *     STAYED LIVE to anyone with a project key;
 *   - the Next.js invoke-by-name route filtered on `status: 'active'`, so one
 *     thrown run (which records status='error') removed the function from that
 *     surface while /fn/ kept serving it.
 *
 * One predicate now decides: the deliberate OFF states refuse, 'error' never
 * gates the next run. This drives the real Express app over HTTP, the real
 * Next.js handler, and the real executor against a real database.
 */

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''
let apiKey = ''
let fnId = ''

const FN_NAME = 'off-switch-probe'

async function callFn(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1/${projectId}/fn/${FN_NAME}`, {
    headers: { 'x-api-key': apiKey },
  })
  return { status: res.status, body: await res.json() }
}

async function invokeByName(): Promise<{ status: number; body: any }> {
  const { POST } = await import('@/app/api/v1/[projectId]/functions/route')
  const headers = new Headers()
  headers.set('x-api-key', apiKey)
  const req: any = {
    method: 'POST',
    url: `http://localhost:3000/api/v1/${projectId}/functions`,
    nextUrl: { pathname: `/api/v1/${projectId}/functions`, searchParams: new URLSearchParams() },
    headers,
    cookies: { get: () => undefined },
    json: async () => ({ name: FN_NAME, data: {} }),
  }
  const res: any = await POST(req, { params: Promise.resolve({ projectId }) })
  return { status: res.status, body: await res.json() }
}

async function setStatus(status: string): Promise<void> {
  // 'inactive' is exactly what the console toggle (PUT ai-functions route) and
  // MCP set_active write; 'error' is what the executor writes after a throw.
  await prisma.aiFunction.update({ where: { id: fnId }, data: { status } })
}

beforeAll(async () => {
  assertSafeTestDatabase()

  ownerId = (
    await prisma.user.create({
      data: { email: `fn-off-${randomUUID()}@test.invalid`, name: 'Off Switch Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `fn-off-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id

  apiKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'off-switch',
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

  fnId = (
    await prisma.aiFunction.create({
      data: {
        projectId,
        name: FN_NAME,
        description: 'returns ok',
        generatedCode: 'return { ok: true }',
        triggerType: 'http',
        status: 'active',
      },
      select: { id: true },
    })
  ).id

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await prisma.aiFunctionLog.deleteMany({ where: { functionId: fnId } }).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 120_000)

describe('while the function is on', () => {
  it('the public /fn/ endpoint serves it', async () => {
    const res = await callFn()
    expect(res.status).toBe(200)
  }, 60_000)
})

describe('after the owner switches it off (status=inactive, as the console and set_active write)', () => {
  // beforeEach, not beforeAll: on the unfixed code a served run OVERWRITES the
  // owner's 'inactive' with 'active' on success, so a single leaked call would
  // mask every later assertion behind that side effect.
  beforeEach(() => setStatus('inactive'))

  it('the public /fn/ endpoint refuses with FUNCTION_DISABLED', async () => {
    const res = await callFn()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('FUNCTION_DISABLED')
  }, 60_000)

  it('the invoke-by-name route answers 404', async () => {
    const res = await invokeByName()
    expect(res.status).toBe(404)
  }, 60_000)

  it('the executor itself refuses, so no caller can slip past a route gate', async () => {
    const result = await executeAiFunction(fnId, projectId, { type: 'manual', data: {} }, { selfHeal: false })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('NOT_FOUND')
  }, 60_000)
})

describe("a failed run's status='error' is a record, not an off switch", () => {
  beforeEach(() => setStatus('error'))

  it('the public /fn/ endpoint still serves it — the next call is how it recovers', async () => {
    const res = await callFn()
    expect(res.status).toBe(200)
  }, 60_000)

  it('the invoke-by-name route still serves it too, instead of 404ing until a success it prevents', async () => {
    const res = await invokeByName()
    expect(res.status).toBe(200)
  }, 60_000)
})
