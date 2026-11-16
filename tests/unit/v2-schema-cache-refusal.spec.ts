/**
 * /api/v2 RIDES OUT A SCHEMA-CACHE RELOAD, AS /db DOES
 * ====================================================
 *
 * Production QA re-test (2026-11-16): during a merge the REST API briefly
 * answered 503 DATA_PLANE_UNAVAILABLE. PostgREST answers 503 PGRST002 while a
 * failed schema-cache reload is retried, and refuses the request before
 * reading the body or opening a transaction, so the request never ran. The
 * runtime sends it again for about 2 s (lib/postgrest/schema-cache-retry.ts),
 * and only then answers 503, with Retry-After: 1.
 *
 * This drives the real v2 router and its error-shape middleware with PostgREST
 * stubbed, and fakes only what sits in front of the upstream call: the key
 * lookup, the region's PostgREST address, the exposure gate and the usage
 * checks. The /db side is in tests/unit/postgrest-handler.spec.ts.
 */

jest.mock('@/server/routes/dynamic', () => ({
  getProjectIdFromAuth: async () => ({
    success: true,
    projectId: 'b0e1f7a2-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    isServiceRole: true,
  }),
  authRefusalStatus: () => 401,
  refuseIfKeyLacksMethodPermission: () => false,
}))
jest.mock('@/server/lib/auth', () => ({
  enforceKeyRateLimit: jest.fn(),
  enforceRateLimitByKeyId: jest.fn(),
}))
jest.mock('@/lib/data-plane/regional', () => ({
  projectPostgrest: async () => ({ url: 'http://127.0.0.1:3002', jwtSecret: 'test-secret-value' }),
}))
jest.mock('@/lib/postgrest/exposure', () => ({
  checkExposure: async () => ({ allowed: true }),
}))
jest.mock('@/lib/postgrest/registration', () => ({
  ensureSchemaRegistered: jest.fn(async () => ({ registered: false })),
}))
jest.mock('@/lib/projects/activity', () => ({
  touchProjectActivity: async () => {},
}))
jest.mock('@/lib/usage/restrictions', () => ({
  isGrowingWrite: (method: string) => ['POST', 'PUT', 'PATCH'].includes(method),
  projectRestriction: async () => ({ restricted: false }),
  restrictionDetails: () => ({}),
  restrictionMessage: () => '',
  RESTRICTED_CODE: 'PLAN_LIMIT_EXCEEDED',
}))

import v2Routes from '@/server/routes/v2'
import { postgrestErrorShape } from '@/server/lib/v2-error-shape'

const PROJECT = 'b0e1f7a2-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
const REFUSAL = { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }

interface Answered {
  status: number
  headers: Record<string, string>
  json?: any
  text?: string
}

/** Answers in order; the last answer repeats. */
function upstreamAnswers(answers: Array<{ status: number; body: unknown }>) {
  global.fetch = jest.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(next.body),
    }
  }) as unknown as typeof fetch
}

/**
 * One request through the router, as Express would hand it over, resolving
 * when the handler answers. The error-shape middleware wraps res.json first,
 * as server/app.ts mounts it ahead of the router.
 */
function send(method: string, path: string, body?: unknown): { answered: Promise<Answered>; res: Answered } {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = String(v); return this },
    getHeader(k: string) { return this.headers[k.toLowerCase()] },
    status(c: number) { this.statusCode = c; return this },
    type(t: string) { this.headers['content-type'] = t; return this },
  }
  const view: Answered = { status: 0, headers: res.headers }
  const answered = new Promise<Answered>((resolve, reject) => {
    res.json = (b: unknown) => { view.status = res.statusCode; view.json = b; resolve(view); return res }
    res.send = (t: string) => { view.status = res.statusCode; view.text = t; resolve(view); return res }
    const req: any = {
      method,
      url: path,
      originalUrl: `/api/v2${path}`,
      headers: { 'x-api-key': 'caller-key', 'content-type': 'application/json' },
      query: {},
      body,
    }
    postgrestErrorShape(req, res, () => {})
    v2Routes(req, res, (err?: unknown) => reject(err ?? new Error(`no v2 route answered ${method} ${path}`)))
  })
  return { answered, res: view }
}

let random: jest.SpyInstance
beforeEach(() => {
  jest.useFakeTimers()
  // No jitter: the waits are exactly 250, 500 and 1000 ms.
  random = jest.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  random.mockRestore()
  jest.useRealTimers()
})

describe('/api/v2 while PostgREST reloads its schema cache (PGRST002)', () => {
  it('sends the request again and returns PostgREST\'s rows once the cache is back', async () => {
    upstreamAnswers([
      { status: 503, body: REFUSAL },
      { status: 200, body: [{ id: 1, name: 'ready' }] },
    ])
    const { answered, res } = send('GET', `/${PROJECT}/orders?select=*`)
    await jest.advanceTimersByTimeAsync(249)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(0)
    await jest.advanceTimersByTimeAsync(1)
    const out = await answered

    expect(global.fetch).toHaveBeenCalledTimes(2)
    const [firstUrl, first] = (global.fetch as jest.Mock).mock.calls[0]
    const [secondUrl, second] = (global.fetch as jest.Mock).mock.calls[1]
    expect(secondUrl).toBe(firstUrl)
    expect(secondUrl).toContain('select=*')
    expect(second.headers).toBe(first.headers)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.text!)).toEqual([{ id: 1, name: 'ready' }])
  })

  it('sends a write again with the same body bytes', async () => {
    upstreamAnswers([
      { status: 503, body: REFUSAL },
      { status: 201, body: [{ id: 9, name: 'x' }] },
    ])
    const { answered } = send('POST', `/${PROJECT}/orders`, { name: 'x' })
    await jest.advanceTimersByTimeAsync(250)
    const out = await answered

    const calls = (global.fetch as jest.Mock).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1][1].method).toBe('POST')
    expect(calls[1][1].body).toBe(calls[0][1].body)
    expect(JSON.parse(calls[1][1].body)).toEqual({ name: 'x' })
    expect(out.status).toBe(201)
  })

  it('answers 503 in PostgREST\'s error shape with Retry-After: 1 once about 2 s pass', async () => {
    upstreamAnswers([{ status: 503, body: REFUSAL }])
    const { answered, res } = send('DELETE', `/${PROJECT}/orders/7`)
    await jest.advanceTimersByTimeAsync(1_749)
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(res.status).toBe(0)
    await jest.advanceTimersByTimeAsync(1)
    const out = await answered

    expect(global.fetch).toHaveBeenCalledTimes(4)
    expect(out.status).toBe(503)
    expect(out.headers['retry-after']).toBe('1')
    expect(out.json).toEqual({
      code: 'DATA_PLANE_UNAVAILABLE',
      message: expect.stringMatching(/did not run this request/),
      details: null,
      hint: null,
    })
  })

  it('does not send again a 503 that is not PGRST002', async () => {
    upstreamAnswers([{ status: 503, body: { code: 'PGRST000', message: 'Could not connect' } }])
    const { answered } = send('POST', `/${PROJECT}/orders`, { name: 'x' })
    const out = await answered

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(out.status).toBeGreaterThanOrEqual(500)
    expect(out.headers['retry-after']).toBeUndefined()
  })
})
