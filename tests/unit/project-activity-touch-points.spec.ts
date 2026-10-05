/**
 * WHERE the inactivity clock is stamped, and in what order.
 *
 * Two rules from the pause design that no end-to-end test can pin cheaply:
 *
 *   MCP     authenticate -> paused check -> stamp -> rate limit. A call
 *           refused because the project is paused must not move its clock,
 *           and must not spend the key's rate-limit window either. An MCP call
 *           is never counted as an API request.
 *   UI      a dashboard WRITE counts as use; a dashboard READ does not, or an
 *           open tab polling health would keep an abandoned backend awake.
 *
 * The collaborators are replaced with recorders (auth, the serving state, the
 * clock, the key's rate-limit read, and the two ways a request gets counted as
 * an API request). The rate-limit read is the guard's only database access, so
 * nothing here reaches one. The real clock and the real serving state are
 * covered against Postgres in tests/integration/project-activity-clock.spec.ts.
 */

const calls: string[] = []

jest.mock('@/lib/mcp/auth', () => ({
  authenticateMcp: jest.fn(async () => {
    calls.push('auth')
    return { ok: true, keyId: 'k1', projectId: 'p1', userId: 'u1', scope: 'mcp' }
  }),
  mcpAuthFailureResponse: jest.fn(() => null),
}))

let servingKind: 'serving' | 'paused' = 'serving'
jest.mock('@/lib/projects/serving-state', () => {
  const actual = jest.requireActual('@/lib/projects/serving-state')
  return {
    ...actual,
    getProjectServingState: jest.fn(async () => {
      calls.push('serving')
      return servingKind === 'paused'
        ? { kind: 'paused', pausedAt: new Date('2026-09-10T00:00:00Z'), reason: 'inactivity' }
        : { kind: 'serving' }
    }),
  }
})

jest.mock('@/lib/projects/activity', () => ({
  touchProjectActivity: jest.fn(async (id: string) => {
    calls.push(`touch:${id}`)
  }),
}))

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    apiKey: {
      // The per-key rate limit, mcpGuard's last step. A key with no row has
      // no window to spend, so the call passes and the guard runs to the end.
      findUnique: jest.fn(async () => {
        calls.push('rate')
        return null
      }),
    },
    // An MCP call is not an API request. Were the guard to count one, or to
    // record it as served API traffic (which is what gets counted), 'count'
    // would show up in the call order below.
    userAiUsage: {
      upsert: jest.fn(async () => {
        calls.push('count')
      }),
    },
  },
}))

jest.mock('@/lib/traffic/request-recorder', () => ({
  ...jest.requireActual('@/lib/traffic/request-recorder'),
  recordRuntimeRequest: jest.fn(() => {
    calls.push('count')
  }),
}))

jest.mock('@/lib/auth/middleware', () => ({
  requireAuth: jest.fn(async () => ({ userId: 'u1' })),
}))

jest.mock('@/lib/edition', () => ({
  getProjectResolver: () => ({
    resolveForUser: async (_u: string, id: string) => ({ id, name: 'p', userId: 'u1' }),
  }),
}))

import { mcpGuard } from '@/lib/mcp/guard'
import { withProjectValidation } from '@/lib/middleware/projectValidation'

const PROJECT = '0c7b5f3e-1f1d-4d0e-9b5f-6a2f3f9d1c11'

beforeEach(() => {
  calls.length = 0
  servingKind = 'serving'
})

describe('MCP', () => {
  it('stamps after the pause check and before the rate limit, and counts no API request', async () => {
    await mcpGuard({} as any)
    expect(calls).toEqual(['auth', 'serving', 'touch:p1', 'rate'])
  })

  it('neither stamps nor spends the rate limit for a paused project', async () => {
    servingKind = 'paused'
    const result = await mcpGuard({} as any)

    expect(calls).toEqual(['auth', 'serving'])
    expect(result.response?.status).toBe(503)
  })
})

describe('the dashboard', () => {
  function request(method: string, path: string) {
    const url = `http://localhost${path}`
    return { method, url, nextUrl: new URL(url), headers: new Headers() } as any
  }

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('counts a %s as use', async method => {
    await withProjectValidation(request(method, `/api/projects/${PROJECT}/tables`), async () => ({ status: 200 }) as any)
    expect(calls).toContain(`touch:${PROJECT}`)
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not count a %s', async method => {
    await withProjectValidation(request(method, `/api/projects/${PROJECT}/health`), async () => ({ status: 200 }) as any)
    expect(calls).not.toContain(`touch:${PROJECT}`)
  })
})
