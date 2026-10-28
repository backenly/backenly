/**
 * run_test's get must call the get-by-id route, and no request the endpoint
 * verifier sends may list a table without a limit (lib/ai/brain/verifier.ts).
 *
 * get used to send the list request with neither an id nor a limit, so it read
 * a page of the table and reported that as a pass for a route it never called.
 * These drive runEndpointTest against a stubbed runtime and assert the requests
 * it sends and what it concludes from the answers. The project lookup is
 * stubbed too; nothing here needs a database.
 */

const mockFindProject = jest.fn()

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: { findUnique: (...args: unknown[]) => mockFindProject(...args) },
    workspace: { findFirst: async () => ({ postgresSchema: 'workspace_p1' }) },
  },
}))
// create reads the table's columns to build its sample row. None come back
// here, so create falls back to listing, the third request that lists.
jest.mock('@/lib/data-plane/regional', () => ({
  workspaceRawClient: async () => ({ $queryRawUnsafe: async () => [] }),
}))

import { runEndpointTest } from '@/lib/ai/brain/verifier'

const APP_URL = 'http://localhost:3000'
const TABLE_URL = `${APP_URL}/api/v1/p1/db/posts`
const ROW_ID = '5b7c1c2e-8d2f-4c55-9a51-2f4f0d6a9e10'

interface Sent {
  method: string
  url: string
  apiKey: string | undefined
}

type Answer = { status: number; body: unknown }

/**
 * A runtime that answers each URL from a fixed table and records every request.
 * A URL it was not given fails the request, so a request nobody expected shows
 * up in the result instead of passing quietly.
 *
 * Duck-typed rather than a real Response: jest.setup.js swaps the global one
 * for a stand-in with no text(), and the verifier reads only status and text().
 */
function runtime(answers: Record<string, Answer>): Sent[] {
  const sent: Sent[] = []
  global.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    sent.push({ method: init?.method ?? 'GET', url, apiKey: headers['x-api-key'] })
    const answer = answers[url]
    if (!answer) throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    return { status: answer.status, text: async () => JSON.stringify(answer.body) }
  }) as unknown as typeof fetch
  return sent
}

/** The runtime's list envelope (lib/postgrest/translate.ts toListEnvelope). */
function listOf(rows: unknown[]): Answer {
  return {
    status: 200,
    body: { data: rows, pagination: { total: rows.length, limit: 1, offset: 0, hasMore: false, nextCursor: null } },
  }
}

const get = () => runEndpointTest({ projectId: 'p1', tableName: 'posts', operation: 'get' })

const realFetch = global.fetch
const realAppUrl = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  mockFindProject.mockResolvedValue({ anonKey: 'anon-key' })
})

afterEach(() => {
  global.fetch = realFetch
  if (realAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = realAppUrl
})

describe('run_test get', () => {
  it('lists one row, then fetches that row by its id', async () => {
    const sent = runtime({
      [`${TABLE_URL}?limit=1`]: listOf([{ id: ROW_ID, title: 'hello' }]),
      [`${TABLE_URL}/${ROW_ID}`]: { status: 200, body: { data: { id: ROW_ID, title: 'hello' } } },
    })

    const result = await get()

    expect(sent).toEqual([
      { method: 'GET', url: `${TABLE_URL}?limit=1`, apiKey: 'anon-key' },
      { method: 'GET', url: `${TABLE_URL}/${ROW_ID}`, apiKey: 'anon-key' },
    ])
    expect(result).toMatchObject({
      ok: true,
      method: 'GET',
      endpoint: `/api/v1/p1/db/posts/${ROW_ID}`,
      statusCode: 200,
    })
  })

  it('fetches a numeric id the same way', async () => {
    const sent = runtime({
      [`${TABLE_URL}?limit=1`]: listOf([{ id: 7 }]),
      [`${TABLE_URL}/7`]: { status: 200, body: { data: { id: 7 } } },
    })

    expect(await get()).toMatchObject({ ok: true, endpoint: '/api/v1/p1/db/posts/7' })
    expect(sent.map((s) => s.url)).toEqual([`${TABLE_URL}?limit=1`, `${TABLE_URL}/7`])
  })

  it('reports an empty table as the get route not exercised, never as a pass', async () => {
    const sent = runtime({ [`${TABLE_URL}?limit=1`]: listOf([]) })

    const result = await get()

    expect(sent).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, failureKind: 'no_rows', statusCode: 200 })
    expect(result.summary).toMatch(/not exercised/)
  })

  // Each of these is a pass for list. None of them gives get a row to fetch,
  // so none of them says anything about the get-by-id route.
  it.each<[string, Answer]>([
    ['refuses the anon key', { status: 403, body: { error: 'Forbidden' } }],
    [
      'is blocked by row-level security',
      { status: 500, body: { error: 'Raw query failed. Code: `42501`. new row violates row-level security policy for table "posts"' } },
    ],
    ['returns a row with no id', listOf([{ title: 'a table without an id column' }])],
  ])('does not pass when the list %s', async (_why, answer) => {
    const sent = runtime({ [`${TABLE_URL}?limit=1`]: answer })

    const result = await get()

    expect(sent).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, failureKind: 'no_rows', statusCode: answer.status })
  })

  it('reports a list that fails as that failure', async () => {
    runtime({ [`${TABLE_URL}?limit=1`]: { status: 404, body: { error: 'Table not found' } } })

    expect(await get()).toMatchObject({
      ok: false,
      failureKind: 'not_found',
      endpoint: '/api/v1/p1/db/posts',
      statusCode: 404,
    })
  })

  it('blames the get-by-id route, not the table, when the listed row is not found by its id', async () => {
    // The list just answered, so the table is routed and generate_api ran.
    // Saying otherwise sends the agent off to regenerate an API that works.
    runtime({
      [`${TABLE_URL}?limit=1`]: listOf([{ id: ROW_ID }]),
      [`${TABLE_URL}/${ROW_ID}`]: { status: 404, body: { error: 'Record not found', code: 'NOT_FOUND' } },
    })

    const result = await get()

    expect(result).toMatchObject({
      ok: false,
      failureKind: 'not_found',
      endpoint: `/api/v1/p1/db/posts/${ROW_ID}`,
      statusCode: 404,
    })
    expect(result.summary).not.toMatch(/generate_api|not routed/)
  })
})

describe('no request lists a table without a limit', () => {
  it.each(['list', 'get', 'create'] as const)('%s', async (operation) => {
    const sent = runtime({ [`${TABLE_URL}?limit=1`]: listOf([]) })

    await runEndpointTest({ projectId: 'p1', tableName: 'posts', operation })

    const lists = sent.filter((s) => s.method === 'GET' && new URL(s.url).pathname === '/api/v1/p1/db/posts')
    expect(lists).toHaveLength(1)
    expect(new URL(lists[0].url).searchParams.get('limit')).toBe('1')
  })
})
