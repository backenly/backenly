/**
 * EVERY FUNCTION INVOCATION ROUTE ANSWERS WITH THE REAL STATUS (#604)
 * ===================================================================
 * Two status-code problems on the routes a client calls a function by:
 *
 *  1. /api/v1/{projectId}/fn/{name}, the documented URL, answered a run the
 *     plan refused with 500 FUNCTION_EXECUTION_ERROR. A 500 tells a client to
 *     retry and monitoring that the app is down; POST /functions and
 *     /functions/invoke already answered 402 PLAN_LIMIT_EXCEEDED, which the
 *     errors doc says means "do not retry in a loop".
 *  2. POST /functions and /functions/invoke answered 200, with success: true,
 *     whatever the handler said, so a function that answered 401 or 503
 *     reached its caller as a success. /fn already answered with the
 *     handler's own status.
 *
 * Here the real runtime serves /fn, and the two Next routes are called as
 * Next calls them, through recordedV1, with a real API key, against real
 * function rows run by the real executor. Only the plan's monthly run count is
 * stood in for, to make it run out.
 */

const mockPlan = { runsUsedUp: false }

jest.mock('@/lib/entitlements/policy', () => {
  const actual = jest.requireActual('@/lib/entitlements/policy')
  return {
    ...actual,
    enforceAiFunctionInvocation: jest.fn(async (billingAccountId: string) =>
      mockPlan.runsUsedUp
        ? actual.violation('free', "You've used all 1,000 function runs your Free plan allows this month, across all of your projects.")
        : actual.enforceAiFunctionInvocation(billingAccountId),
    ),
  }
})

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import jwt from 'jsonwebtoken'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { POST as invokeByName } from '@/app/api/v1/[projectId]/functions/route'
import { POST as invokeById } from '@/app/api/v1/[projectId]/functions/invoke/route'
import { POST as dashboardRun } from '@/app/api/projects/[id]/ai-functions/[functionId]/run/route'
import { startStandInSupervisor } from '@/tests/helpers/stand-in-function-supervisor'

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''
let apiKey = ''
const ids: Record<string, string> = {}

interface Answer {
  status: number
  body: any
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** POST /api/v1/{projectId}/fn/{name}, through the runtime. */
async function viaFn(name: string): Promise<Answer> {
  const res = await fetch(`${base}/api/v1/${projectId}/fn/${name}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  return { status: res.status, body: await readBody(res) }
}

function nextRequest(path: string, body: unknown): any {
  const headers = new Headers()
  headers.set('x-api-key', apiKey)
  return {
    method: 'POST',
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path, searchParams: new URLSearchParams() },
    headers,
    cookies: { get: () => undefined },
    json: async () => body,
  }
}

/** POST /api/v1/{projectId}/functions { name }, as Next calls it. */
async function viaFunctions(name: string): Promise<Answer> {
  const res = await invokeByName(nextRequest(`/api/v1/${projectId}/functions`, { name, data: {} }), {
    params: Promise.resolve({ projectId }),
  })
  return { status: res.status, body: await readBody(res) }
}

/** POST /api/v1/{projectId}/functions/invoke { functionId }, as Next calls it. */
async function viaInvoke(name: string): Promise<Answer> {
  const res = await invokeById(nextRequest(`/api/v1/${projectId}/functions/invoke`, { functionId: ids[name], payload: {} }), {
    params: Promise.resolve({ projectId }),
  })
  return { status: res.status, body: await readBody(res) }
}

async function deploy(name: string, code: string, triggerType: string): Promise<void> {
  ids[name] = (await prisma.aiFunction.create({
    data: { projectId, name, description: name, generatedCode: code, triggerType, status: 'active' },
    select: { id: true },
  })).id
}

const routeModule = (answer: string) =>
  ["import { NextResponse } from 'next/server'", 'export async function POST(req) {', `  return ${answer}`, '}'].join('\n')

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({
    data: { email: `fn-status-${randomUUID()}@example.test`, name: 'Function status' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: `fn-status-${randomUUID().slice(0, 8)}`, userId: ownerId },
    select: { id: true },
  })).id
  apiKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'app',
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

  await deploy('members-only', routeModule("NextResponse.json({ error: 'Sign in to see the members' }, { status: 401 })"), 'http')
  await deploy('warehouse', routeModule("NextResponse.json({ error: 'The warehouse is unavailable', retryAfter: 30 }, { status: 503 })"), 'http')
  await deploy('nothing-to-say', routeModule('NextResponse.json(null, { status: 204 })'), 'http')
  await deploy('plain-answer', 'return { ok: true }', 'manual')

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterEach(() => {
  mockPlan.runsUsedUp = false
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (projectId) {
    await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a run the plan refuses', () => {
  it('is a 402 PLAN_LIMIT_EXCEEDED on /fn, /functions and /functions/invoke', async () => {
    mockPlan.runsUsedUp = true
    for (const answer of [await viaFn('plain-answer'), await viaFunctions('plain-answer'), await viaInvoke('plain-answer')]) {
      expect(answer.status).toBe(402)
      expect(answer.body).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' })
      expect(answer.body.message).toContain('function runs your Free plan allows this month')
    }
    // At /fn, as on the Next routes, it says an upgrade lifts it.
    expect((await viaFn('plain-answer')).body).toMatchObject({ upgradeRequired: true })
  }, 60_000)
})

describe("a run that completed answers with the handler's own status", () => {
  it('a 401 is a 401, and the envelope is the function\'s, not one of Backenly\'s errors', async () => {
    const fn = await viaFn('members-only')
    expect(fn).toEqual({ status: 401, body: { error: 'Sign in to see the members' } })

    const byName = await viaFunctions('members-only')
    expect(byName.status).toBe(401)
    expect(byName.body).toEqual({
      data: {
        name: 'members-only',
        success: false,
        result: { status: 401, body: { error: 'Sign in to see the members' } },
        durationMs: expect.any(Number),
      },
    })

    const byId = await viaInvoke('members-only')
    expect(byId.status).toBe(401)
    expect(byId.body).toEqual({
      data: {
        functionId: ids['members-only'],
        success: false,
        returnValue: { status: 401, body: { error: 'Sign in to see the members' } },
        durationMs: expect.any(Number),
      },
    })
  }, 60_000)

  it('a 503 is a 503, so retry middleware and monitoring see it', async () => {
    for (const answer of [await viaFn('warehouse'), await viaFunctions('warehouse'), await viaInvoke('warehouse')]) {
      expect(answer.status).toBe(503)
    }
    expect((await viaFunctions('warehouse')).body.data).toMatchObject({
      success: false,
      result: { status: 503, body: { error: 'The warehouse is unavailable', retryAfter: 30 } },
    })
  }, 60_000)

  it('a 204 is a 204 with no body', async () => {
    for (const answer of [await viaFn('nothing-to-say'), await viaFunctions('nothing-to-say'), await viaInvoke('nothing-to-say')]) {
      expect(answer).toEqual({ status: 204, body: null })
    }
  }, 60_000)

  it('a plain function, which chooses no status, is still a 200 with its envelope', async () => {
    expect(await viaFn('plain-answer')).toMatchObject({ status: 200, body: { success: true, name: 'plain-answer', result: { ok: true } } })
    expect(await viaFunctions('plain-answer')).toMatchObject({
      status: 200,
      body: { data: { name: 'plain-answer', success: true, result: { ok: true } } },
    })
    expect(await viaInvoke('plain-answer')).toMatchObject({
      status: 200,
      body: { data: { functionId: ids['plain-answer'], success: true, returnValue: { ok: true } } },
    })
  }, 60_000)
})

describe('a run the function runner turns away for capacity', () => {
  /** The dashboard's Run, by the project's owner, with a real platform session. */
  async function viaDashboardRun(name: string): Promise<Response> {
    const token = jwt.sign({ userId: ownerId, email: `${ownerId}@example.test`, role: 'user' }, process.env.JWT_SECRET!, { expiresIn: '10m' })
    await prisma.session.create({ data: { userId: ownerId, token, expiresAt: new Date(Date.now() + 10 * 60_000) } })
    const headers = new Headers()
    headers.set('authorization', `Bearer ${token}`)
    const request: any = {
      method: 'POST',
      url: `http://localhost:3000/api/projects/${projectId}/ai-functions/${ids[name]}/run`,
      nextUrl: { pathname: `/api/projects/${projectId}/ai-functions/${ids[name]}/run`, searchParams: new URLSearchParams() },
      headers,
      cookies: { get: () => undefined },
      json: async () => ({ event: {} }),
    }
    return dashboardRun(request, { params: Promise.resolve({ id: projectId, functionId: ids[name] }) })
  }

  // A stand-in supervisor on a UNIX socket; Windows has no supervisor.
  ;(process.platform === 'win32' ? it.skip : it)(
    "is a 503 FUNCTION_RUNNER_BUSY with Retry-After on /fn, /functions, /functions/invoke and the dashboard's Run",
    async () => {
      const supervisor = await startStandInSupervisor()
      supervisor.use()
      try {
        const fn = await fetch(`${base}/api/v1/${projectId}/fn/plain-answer`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        const byName = await invokeByName(nextRequest(`/api/v1/${projectId}/functions`, { name: 'plain-answer', data: {} }), {
          params: Promise.resolve({ projectId }),
        })
        const byId = await invokeById(nextRequest(`/api/v1/${projectId}/functions/invoke`, { functionId: ids['plain-answer'], payload: {} }), {
          params: Promise.resolve({ projectId }),
        })
        const run = await viaDashboardRun('plain-answer')
        for (const res of [fn, byName, byId, run]) {
          expect(res.status).toBe(503)
          expect(res.headers.get('retry-after')).toBe('5')
          expect(await readBody(res)).toMatchObject({ code: 'FUNCTION_RUNNER_BUSY' })
        }
      } finally {
        await supervisor.close()
        await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
      }
    },
    60_000,
  )
})
