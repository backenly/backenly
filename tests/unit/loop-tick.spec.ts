/**
 * The dashboard's "Self-healing loop — checked N ago" must quote the loop's own
 * clock, not the daily observer's.
 *
 * The bug this guards: `lastCheckedAt` is `Project.lastObservedAt`, stamped only
 * at the end of `runObserverForProject` (daily cron `10 0 * * *`). The reconciler
 * runs every minute and stamps nothing on the project. So the one surface whose
 * job is to prove the every-minute promise quoted a once-a-day timestamp, and a
 * backend reconciled sixty seconds ago rendered "checked 11h ago" — contradicting
 * the cadence the pricing page sells on every plan, including Free.
 *
 * These tests pin the two clocks apart. If someone ever "simplifies" the health
 * route by folding lastReconciledAt back into lastCheckedAt, the regression case
 * below fails with the exact 11h/1min shape that was reported.
 */

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    auditLog: { findFirst: jest.fn() },
    healthFinding: { findMany: jest.fn(), findFirst: jest.fn() },
    correctionEvent: { count: jest.fn() },
    project: { findUnique: jest.fn() },
  },
}))

// The route is only reachable through project auth; the handler under test is
// what we care about, so validation resolves to a fixed project.
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) =>
    handler({ projectId: 'p1', userId: 'u1' }),
}))

import { prisma } from '@/lib/db/prisma'
import { getLastLoopTickAt, LOOP_TICK_ACTIONS } from '@/lib/autonomy/loop-tick'

const mockPrisma = prisma as unknown as {
  auditLog: { findFirst: jest.Mock }
  healthFinding: { findMany: jest.Mock; findFirst: jest.Mock }
  correctionEvent: { count: jest.Mock }
  project: { findUnique: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getLastLoopTickAt', () => {
  it('returns the most recent tick timestamp', async () => {
    const ts = new Date('2026-07-30T10:50:00.000Z')
    mockPrisma.auditLog.findFirst.mockResolvedValue({ timestamp: ts })

    expect(await getLastLoopTickAt('p1')).toEqual(ts)
  })

  it('returns null when the loop has not run inside the lookback', async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null)

    // Null is a real answer — "this project is not being reconciled". Callers
    // must surface it rather than substituting the observer's stamp.
    expect(await getLastLoopTickAt('p1')).toBeNull()
  })

  it('counts every action that means a pass happened, not just AUTONOMY_TICK', async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null)
    await getLastLoopTickAt('p1')

    const where = mockPrisma.auditLog.findFirst.mock.calls[0][0].where
    // A pass that ended in a change-freeze still checked the backend. Dropping
    // any of these would make a healthy-but-frozen project read as never checked.
    expect(where.action.in).toEqual(expect.arrayContaining([...LOOP_TICK_ACTIONS]))
    expect(where.projectId).toBe('p1')
  })

  it('bounds the scan to 24h so it cannot sort the whole audit history', async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null)
    const before = Date.now()
    await getLastLoopTickAt('p1')

    // audit_logs has no composite [projectId, action, timestamp] index, and the
    // loop adds ~43k rows a month per project. An unbounded ORDER BY on a
    // per-dashboard-load query is the thing this bound exists to prevent.
    const where = mockPrisma.auditLog.findFirst.mock.calls[0][0].where
    const since = where.timestamp.gte as Date
    const lookbackMs = before - since.getTime()
    expect(lookbackMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
    expect(lookbackMs).toBeLessThan(24 * 60 * 60 * 1000 + 5000)

    expect(mockPrisma.auditLog.findFirst.mock.calls[0][0].orderBy).toEqual({
      timestamp: 'desc',
    })
  })

  it('degrades to null instead of throwing when the query fails', async () => {
    mockPrisma.auditLog.findFirst.mockRejectedValue(new Error('db down'))

    // The health route must still render; a missing timestamp is recoverable,
    // a 500 on the dashboard is not.
    await expect(getLastLoopTickAt('p1')).resolves.toBeNull()
  })
})

describe('GET /api/projects/[id]/health — the two clocks stay separate', () => {
  const ELEVEN_HOURS_AGO = new Date(Date.now() - 11 * 60 * 60 * 1000)
  const ONE_MINUTE_AGO = new Date(Date.now() - 60 * 1000)

  // The GET handler reads exactly one thing off the request — `new URL(request.url)`
  // for the ?history / ?digest branches — and withProjectValidation is mocked, so
  // a real NextRequest buys nothing. It also cannot be built here: jest.setup.js
  // polyfills a global Request whose `url` is a plain assignment, while
  // NextRequest defines `url` as a getter-only property.
  const request = { url: 'http://localhost:3000/api/projects/p1/health' } as any

  async function callGet() {
    const { GET } = require('@/app/api/projects/[id]/health/route')
    const res = await GET(request, { params: { id: 'p1' } })
    return (await res.json()).data
  }

  it('reports the per-minute loop pass, not the daily observer sweep', async () => {
    mockPrisma.healthFinding.findMany.mockResolvedValue([])
    mockPrisma.correctionEvent.count.mockResolvedValue(0)
    mockPrisma.healthFinding.findFirst.mockResolvedValue(null)
    mockPrisma.project.findUnique.mockResolvedValue({ lastObservedAt: ELEVEN_HOURS_AGO })
    mockPrisma.auditLog.findFirst.mockResolvedValue({ timestamp: ONE_MINUTE_AGO })

    const data = await callGet()

    // This is the reported bug, exactly: the observer swept 11h ago, the loop
    // reconciled a minute ago, and the loop's header must say a minute.
    expect(data.lastReconciledAt).toBe(ONE_MINUTE_AGO.toISOString())
    expect(new Date(data.lastCheckedAt).toISOString()).toBe(ELEVEN_HOURS_AGO.toISOString())
    expect(data.lastReconciledAt).not.toBe(data.lastCheckedAt)
  })

  it('leaves lastReconciledAt null rather than falling back to the observer stamp', async () => {
    mockPrisma.healthFinding.findMany.mockResolvedValue([])
    mockPrisma.correctionEvent.count.mockResolvedValue(0)
    mockPrisma.healthFinding.findFirst.mockResolvedValue(null)
    mockPrisma.project.findUnique.mockResolvedValue({ lastObservedAt: ELEVEN_HOURS_AGO })
    mockPrisma.auditLog.findFirst.mockResolvedValue(null)

    const data = await callGet()

    // A loop that has not ticked must read "first check running…", never a
    // borrowed timestamp that makes a stalled loop look healthy.
    expect(data.lastReconciledAt).toBeNull()
  })
})
