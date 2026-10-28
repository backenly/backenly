/**
 * FUNCTION CREATION REPORTS WHAT ITS OWN SMOKE TEST FOUND
 * =======================================================
 * `functions { action: "create" }` invokes the generated handler once before
 * calling it deployed. Two lies lived downstream of that test:
 *
 *   - the response said "custom function ready" with success:true even when
 *     the smoke test (and the repair retry) FAILED, so the agent told its
 *     human the endpoint works and the first real request 500d;
 *   - the smoke test classified failures by sniffing the error TEXT, so any
 *     handler error mentioning "database" or "connect" — the most common words
 *     in a broken query's message — was filed as untestable infrastructure and
 *     reported clean.
 *
 * Now the runner types handler failures (RouteModuleHandlerError), the smoke
 * outcome travels into the stored row (status 'error' + lastError) and the
 * response (success:false, data.verification), and "ready" is only said about
 * code that was invoked and ran.
 *
 * The LLM is the only mock (delegating, call-queue): generation returns canned
 * route modules; validation, the vm runner, the smoke test and the database
 * are all real.
 */

import { randomUUID } from 'crypto'

jest.mock('@/lib/ai/llm/chat', () => {
  const actual = jest.requireActual('@/lib/ai/llm/chat')
  return {
    ...actual,
    chat: jest.fn(async () => {
      const next = (global as any).__CANNED_CODE__?.shift()
      if (typeof next !== 'string') throw new Error('test: no canned code queued for chat()')
      return { text: next, result: {} }
    }),
  }
})

import { prisma } from '@/lib/db/prisma'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { executeRouteModuleFunction, RouteModuleHandlerError } from '@/lib/services/ai-functions/route-module-runner'

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

// Passes static validation (compiles, evaluates, exports GET) and runs clean.
const GOOD = `
import { NextResponse } from 'next/server'
export async function GET(req: Request) {
  return NextResponse.json({ ok: true })
}
`

// Passes static validation; throws when INVOKED. The message deliberately
// contains "database" and "connect": the old classifier read those words as
// "infrastructure unavailable" and reported the broken function clean.
const BROKEN = `
import { NextResponse } from 'next/server'
export async function GET(req: Request) {
  throw new Error('relation "orders" does not exist - database connection failed')
}
`

function queueCanned(...codes: string[]) {
  ;(global as any).__CANNED_CODE__ = [...codes]
}

async function create(name: string) {
  return executeGenerateFunction({ name, description: `smoke truthfulness probe ${name}`, method: 'GET' }, projectId)
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `fn-truth-${randomUUID()}@test.invalid`, name: 'Fn Truth Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `fn-truth-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('the runner names who failed', () => {
  it('a handler throw is a RouteModuleHandlerError, even when it mentions the database', async () => {
    await expect(
      executeRouteModuleFunction(BROKEN, projectId, { type: 'manual', data: {} }, 'GET /fn/x', { testRun: true })
    ).rejects.toBeInstanceOf(RouteModuleHandlerError)
  }, 60_000)

  it('a compile failure stays a plain Error — machinery, not the handler', async () => {
    const err = await executeRouteModuleFunction(
      'export async function GET( {', projectId, { type: 'manual', data: {} }, 'GET /fn/x', { testRun: true }
    ).then(() => null, (e) => e)
    expect(err).not.toBeNull()
    expect(err).not.toBeInstanceOf(RouteModuleHandlerError)
  }, 60_000)
})

describe('create reports the smoke outcome', () => {
  it('code that runs is reported ready, stored active, verification passed', async () => {
    queueCanned(GOOD)
    const res = await create('truth-good')
    expect(res.success).toBe(true)
    expect(res.message).toContain('custom function ready')
    expect(res.data?.verification).toBe('passed')
    const row = await prisma.aiFunction.findFirst({ where: { projectId, name: 'truth-good' } })
    expect(row?.status).toBe('active')
    expect(row?.lastError).toBeNull()
  }, 120_000)

  it('code that fails its smoke test twice is NOT reported ready', async () => {
    // generation → BROKEN, repair pass → BROKEN again
    queueCanned(BROKEN, BROKEN)
    const res = await create('truth-broken')
    expect(res.success).toBe(false)
    expect(res.message).toContain('FAILED its runtime smoke test')
    expect(res.message).not.toContain('custom function ready')
    expect(res.data?.verification).toBe('failed')
    const row = await prisma.aiFunction.findFirst({ where: { projectId, name: 'truth-broken' } })
    // stored for inspection, but as the error it is — not a healthy row
    expect(row?.status).toBe('error')
    expect(row?.lastError).toContain('SMOKE_TEST_FAILED')
  }, 120_000)

  it('a failing first draft that the repair pass fixes is ready, and says it was repaired', async () => {
    queueCanned(BROKEN, GOOD)
    const res = await create('truth-repaired')
    expect(res.success).toBe(true)
    expect(res.data?.verification).toBe('repaired')
    expect(res.message).toContain('repaired')
    const row = await prisma.aiFunction.findFirst({ where: { projectId, name: 'truth-repaired' } })
    expect(row?.status).toBe('active')
  }, 120_000)
})
