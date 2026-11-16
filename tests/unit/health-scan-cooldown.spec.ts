/**
 * PATCH /api/projects/[id]/health: Autonomy's "Scan now" (project console
 * rebuild, 2026-11-16, Operate backend change).
 *
 *   - one scan a project every ten minutes, the budget "Look now" keeps;
 *   - a refused scan runs nothing and says when to ask again, as a 429 with
 *     the wait (also sent as Retry-After) and the code SCANNED_RECENTLY;
 *   - a scan that failed gives its budget back, so the person can retry;
 *   - the role floor is unchanged: DEVELOPER and above ('write').
 *
 * Database-free: the project check, the rate-limit store, the observer and
 * every read the answer makes are stubbed per case.
 */

let allowed = true
let retryAfter: number | undefined = 420
const consume = jest.fn(async () => (allowed ? { allowed: true } : { allowed: false, retryAfter }))
const refund = jest.fn(async () => {})
jest.mock('@/lib/security/auth-rate-limit', () => ({
  consume: (...args: unknown[]) => (consume as any)(...args),
  refund: (...args: unknown[]) => (refund as any)(...args),
}))

const floors: unknown[] = []
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: async (_req: unknown, handler: (v: { projectId: string }) => unknown, opts: unknown) => {
    floors.push(opts)
    return handler({ projectId: 'p1' })
  },
}))

let observe: () => Promise<unknown> = async () => ({})
const runObserverForProject = jest.fn(() => observe())
jest.mock('@/lib/services/workspace-observer', () => ({ runObserverForProject: () => runObserverForProject() }))

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    healthFinding: { findMany: async () => [] },
    project: { findUnique: async () => ({ lastObservedAt: new Date('2026-11-16T03:02:00Z') }) },
  },
}))
jest.mock('@/lib/autonomy/resolution', () => ({ countRepairs: async () => ({ verified: 0, unverified: 0 }), recentlyResolved: async () => [] }))
jest.mock('@/lib/autonomy/sensor-state', () => ({ loadSensorState: async () => null }))
jest.mock('@/lib/autonomy/loop-tick', () => ({ getLastLoopTickAt: async () => null }))
jest.mock('@/lib/mcp/pending-approvals', () => ({ countPendingAgentApprovals: async () => 0 }))
jest.mock('@/lib/evolution-engine/request', () => ({ countWaitingRequests: async () => 0 }))
jest.mock('@/lib/operational-memory/held-action-targets', () => ({ withHeldActions: async (_p: unknown, rows: unknown) => rows }))
jest.mock('@/lib/operational-memory/ledger', () => ({ resolvePendingActionMemory: async () => {} }))

import { PATCH } from '@/app/api/projects/[id]/health/route'

const patch = () =>
  PATCH({ method: 'PATCH', url: 'http://localhost/api/projects/p1/health' } as any, { params: Promise.resolve({ id: 'p1' }) })

beforeEach(() => {
  allowed = true
  retryAfter = 420
  observe = async () => ({})
  consume.mockClear()
  refund.mockClear()
  runObserverForProject.mockClear()
  floors.length = 0
})

it('scans when the project has not been scanned on request in the last ten minutes', async () => {
  const res = await patch()
  expect(res.status).toBe(200)
  expect(runObserverForProject).toHaveBeenCalledTimes(1)
  expect(consume).toHaveBeenCalledWith('health-scan:p1', 1, 10 * 60_000)
})

it('refuses a second scan within ten minutes without running it, and says when to ask again', async () => {
  allowed = false
  const res = await patch()
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.code).toBe('SCANNED_RECENTLY')
  // Sent as Retry-After too; the test environment's Response does not carry init headers.
  expect(body.retryAfter).toBe(420)
  expect(body.error).toBe('Backenly scanned this project in the last 10 minutes. Scan again in 7 minutes.')
  expect(runObserverForProject).not.toHaveBeenCalled()
})

it('says one minute, not zero, when the wait is under a minute', async () => {
  allowed = false
  retryAfter = 12
  const body = await (await patch()).json()
  expect(body.error).toContain('Scan again in 1 minute.')
})

it('gives the budget back when the scan itself failed, so the person can retry', async () => {
  observe = async () => {
    throw new Error('observer crashed')
  }
  const res = await patch()
  expect(res.status).toBe(500)
  expect(refund).toHaveBeenCalledWith('health-scan:p1')
})

it('keeps the role floor at write (DEVELOPER and above)', async () => {
  await patch()
  expect(floors).toEqual([{ floor: 'write' }])
})
