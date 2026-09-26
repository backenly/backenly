/**
 * WHERE the inactivity clock is stamped, and in what order.
 *
 * Two rules from the pause design that no end-to-end test can pin cheaply:
 *
 *   MCP     authenticate -> paused check -> stamp -> quota. A call refused
 *           because the project is paused must not move its clock, and must
 *           not spend quota either.
 *   UI      a dashboard WRITE counts as use; a dashboard READ does not, or an
 *           open tab polling health would keep an abandoned backend awake.
 *
 * The collaborators are replaced with recorders (auth, the serving state, the
 * clock, quota). No database is mocked: nothing here reaches one. The real
 * clock and the real serving state are covered against Postgres in
 * tests/integration/project-activity-clock.spec.ts.
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

jest.mock('@/lib/quota/kernel', () => ({
  // Refuses, so mcpGuard stops before its rate-limit step (which is a DB read).
  enforceAndTrackApiRequest: jest.fn(async () => {
    calls.push('quota')
    return { allowed: false, message: 'over quota', code: 'PLAN_LIMIT_EXCEEDED' }
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
  it('stamps after the pause check and before quota', async () => {
    await mcpGuard({} as any)
    expect(calls).toEqual(['auth', 'serving', 'touch:p1', 'quota'])
  })

  it('neither stamps nor spends quota for a paused project', async () => {
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
