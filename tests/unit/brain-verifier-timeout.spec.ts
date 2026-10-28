/**
 * The endpoint verifier gives up on a runtime that does not answer, and says
 * that is what happened (lib/ai/brain/verifier.ts).
 *
 * run_test calls the project's runtime from inside the agent turn, which MCP
 * caps at 90 seconds. Its fetch had no deadline, so one hung connection could
 * spend the whole turn, and the run then timed out without saying why. A
 * request the deadline cuts off is reported as a timeout: not a pass, because
 * nothing was verified, and not fetch_failed, which means the connection
 * itself failed.
 *
 * fetch is stubbed with a runtime that never answers, and a test that waits
 * on the deadline shortens it, so it runs in milliseconds. The project lookup
 * is stubbed too; nothing here needs a database.
 */

const mockFindProject = jest.fn()

jest.mock('@/lib/db/prisma', () => ({
  prisma: { project: { findUnique: (...args: unknown[]) => mockFindProject(...args) } },
}))

import { runEndpointTest } from '@/lib/ai/brain/verifier'

const TIMEOUT_MS = 25

/**
 * A promise that never settles on its own. Like a real fetch on a hung
 * connection, it ends only when the request's signal aborts, with the signal's
 * reason, so a request sent without a signal waits forever.
 */
function neverAnswered<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** The signal each request was sent with, in order. */
let signals: Array<AbortSignal | undefined>

/**
 * Answers are duck-typed rather than real Responses: jest.setup.js swaps the
 * global Response for a stand-in with no text(), and the verifier reads only
 * status and text().
 */
function stubFetch(answer: (init: RequestInit) => Promise<unknown>) {
  signals = []
  global.fetch = (async (_url: string, init: RequestInit = {}) => {
    signals.push(init.signal ?? undefined)
    return answer(init)
  }) as unknown as typeof fetch
}

const realFetch = global.fetch
const realAppUrl = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  mockFindProject.mockResolvedValue({ anonKey: 'anon-key' })
})

afterEach(() => {
  global.fetch = realFetch
  if (realAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = realAppUrl
})

describe('a runtime that never answers', () => {
  it.each(['list', 'get'] as const)('ends a %s test with a timeout instead of hanging the turn', async (operation) => {
    stubFetch((init) => neverAnswered(init.signal))

    const result = await runEndpointTest({ projectId: 'p1', tableName: 'posts', operation, timeoutMs: TIMEOUT_MS })

    expect(result).toMatchObject({
      ok: false,
      failureKind: 'timeout',
      method: 'GET',
      endpoint: '/api/v1/p1/db/posts',
      statusCode: null,
    })
    expect(result.summary).toMatch(/did not answer within/)
    // The request was aborted, not merely abandoned: a request left running
    // would hold its connection open after the turn had moved on.
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason).toMatchObject({ name: 'TimeoutError' })
  })

  it('ends with a timeout when the body stalls after the status line', async () => {
    // The status alone is not an answer: a 200 whose body never arrives must
    // not be reported as an endpoint that works.
    stubFetch(async (init) => ({ status: 200, text: () => neverAnswered<string>(init.signal) }))

    const result = await runEndpointTest({ projectId: 'p1', tableName: 'posts', operation: 'list', timeoutMs: TIMEOUT_MS })

    expect(result).toMatchObject({ ok: false, failureKind: 'timeout', statusCode: 200 })
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe('a runtime that does answer', () => {
  it('reports a connection that failed as fetch_failed, not as a timeout', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })

    const result = await runEndpointTest({ projectId: 'p1', tableName: 'posts', operation: 'list' })

    expect(result).toMatchObject({ ok: false, failureKind: 'fetch_failed', statusCode: null })
    expect(result.summary).toMatch(/failed: fetch failed/)
    // Every request carries a deadline, including one that sets no timeout.
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]?.aborted).toBe(false)
  })

  it('judges an answer that arrives in time as before', async () => {
    stubFetch(async () => ({ status: 200, text: async () => '{"data":[]}' }))

    const result = await runEndpointTest({ projectId: 'p1', tableName: 'posts', operation: 'list', timeoutMs: TIMEOUT_MS })

    expect(result).toMatchObject({ ok: true, statusCode: 200 })
    expect(result.failureKind).toBeUndefined()
  })
})
