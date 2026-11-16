/**
 * The projects list's live state, and the words it is said in.
 *
 * projectLiveStatus (lib/projects/live-status.ts) answers for every listed
 * project at once. What these tests hold it to:
 *
 *   - a fixed number of grouped queries, whatever the number of projects:
 *     never one query per project;
 *   - only the ids it was given, de-duplicated and capped, so the route's
 *     access rule (the projects list's own) is the only one there is;
 *   - "waiting" adds up the same queues the top bar does: held findings and
 *     unexpired agent approvals;
 *   - the loop's clock is bounded to a day and read from the loop's own tick
 *     actions; no pass is null, never a substituted time;
 *   - "your agent" is the CALLER's MCP credential, never a teammate's.
 *
 * And the labels (components/projects/labels.ts): "Last used" never claims a
 * precision the hourly activity clock does not have.
 *
 * Prisma is mocked: the subject is which queries are asked and how their rows
 * become the answer, not Postgres.
 */

const mockFindingGroupBy = jest.fn()
const mockApprovalGroupBy = jest.fn()
const mockAuditGroupBy = jest.fn()
const mockKeyGroupBy = jest.fn()

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    healthFinding: { groupBy: (...a: any[]) => mockFindingGroupBy(...a) },
    agentApprovalRequest: { groupBy: (...a: any[]) => mockApprovalGroupBy(...a) },
    auditLog: { groupBy: (...a: any[]) => mockAuditGroupBy(...a) },
    apiKey: { groupBy: (...a: any[]) => mockKeyGroupBy(...a) },
  },
}))

import {
  LIVE_STATUS_MAX_PROJECTS,
  LOOP_CHECK_LOOKBACK_MS,
  projectLiveStatus,
} from '@/lib/projects/live-status'
import { LOOP_TICK_ACTIONS } from '@/lib/autonomy/loop-tick'
import { checkedAgo, lastUsed } from '@/components/projects/labels'

const NOW = new Date('2026-11-16T12:00:00.000Z')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const CALLER = 'user-1'

beforeEach(() => {
  jest.clearAllMocks()
  mockFindingGroupBy.mockResolvedValue([])
  mockApprovalGroupBy.mockResolvedValue([])
  mockAuditGroupBy.mockResolvedValue([])
  mockKeyGroupBy.mockResolvedValue([])
})

describe('projectLiveStatus', () => {
  it('asks nothing for no projects', async () => {
    await expect(projectLiveStatus([], CALLER, NOW)).resolves.toEqual([])
    expect(mockFindingGroupBy).not.toHaveBeenCalled()
    expect(mockApprovalGroupBy).not.toHaveBeenCalled()
    expect(mockAuditGroupBy).not.toHaveBeenCalled()
    expect(mockKeyGroupBy).not.toHaveBeenCalled()
  })

  it('asks four grouped queries whatever the number of projects, never one per project', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    await projectLiveStatus(many, CALLER, NOW)
    for (const query of [mockFindingGroupBy, mockApprovalGroupBy, mockAuditGroupBy, mockKeyGroupBy]) {
      expect(query).toHaveBeenCalledTimes(1)
      expect(query.mock.calls[0][0].by).toEqual(['projectId'])
      expect(query.mock.calls[0][0].where.projectId).toEqual({ in: many })
    }
  })

  it('reads only the ids it is given, once each, and at most the cap', async () => {
    const many = Array.from({ length: LIVE_STATUS_MAX_PROJECTS + 25 }, (_, i) => `id-${i}`)
    const rows = await projectLiveStatus([...many, 'id-0', 'id-1'], CALLER, NOW)
    expect(rows).toHaveLength(LIVE_STATUS_MAX_PROJECTS)
    expect(rows.map((r) => r.id)).toEqual(many.slice(0, LIVE_STATUS_MAX_PROJECTS))
    expect(mockFindingGroupBy.mock.calls[0][0].where.projectId.in).toHaveLength(LIVE_STATUS_MAX_PROJECTS)
  })

  it('adds held findings and unexpired agent approvals into one waiting count', async () => {
    mockFindingGroupBy.mockResolvedValue([{ projectId: A, _count: { _all: 2 } }])
    mockApprovalGroupBy.mockResolvedValue([
      { projectId: A, _count: { _all: 1 } },
      { projectId: B, _count: { _all: 3 } },
    ])
    const rows = await projectLiveStatus([A, B, C], CALLER, NOW)
    expect(rows.find((r) => r.id === A)?.waiting).toBe(3)
    expect(rows.find((r) => r.id === B)?.waiting).toBe(3)
    expect(rows.find((r) => r.id === C)?.waiting).toBe(0)

    expect(mockFindingGroupBy.mock.calls[0][0].where.status).toBe('pending_approval')
    const approvals = mockApprovalGroupBy.mock.calls[0][0].where
    expect(approvals.status).toBe('pending')
    // An approval that expired unanswered is not waiting on anyone.
    expect(approvals.expiresAt).toEqual({ gt: NOW })
  })

  it("reads the loop's own ticks within a day, and says null where there is none", async () => {
    const tick = new Date(NOW.getTime() - 40_000)
    mockAuditGroupBy.mockResolvedValue([{ projectId: A, _max: { timestamp: tick } }])
    const rows = await projectLiveStatus([A, B], CALLER, NOW)
    expect(rows.find((r) => r.id === A)?.lastCheckAt).toBe(tick.toISOString())
    expect(rows.find((r) => r.id === B)?.lastCheckAt).toBeNull()

    const where = mockAuditGroupBy.mock.calls[0][0].where
    expect(where.action).toEqual({ in: [...LOOP_TICK_ACTIONS] })
    expect(where.timestamp).toEqual({ gte: new Date(NOW.getTime() - LOOP_CHECK_LOOKBACK_MS) })
    expect(LOOP_CHECK_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000)
  })

  it("counts the caller's own MCP credentials only, used and unexpired", async () => {
    const seen = new Date(NOW.getTime() - 6 * 60_000)
    mockKeyGroupBy.mockResolvedValue([{ projectId: B, _max: { lastUsed: seen } }])
    const rows = await projectLiveStatus([A, B], CALLER, NOW)
    expect(rows.find((r) => r.id === A)?.agentLastSeenAt).toBeNull()
    expect(rows.find((r) => r.id === B)?.agentLastSeenAt).toBe(seen.toISOString())

    const where = mockKeyGroupBy.mock.calls[0][0].where
    expect(where.userId).toBe(CALLER)
    expect(where.scope).toBe('mcp')
    expect(where.lastUsed).toEqual({ not: null })
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: NOW } }])
  })

  it('fails as a whole rather than answering with made-up zeros', async () => {
    mockAuditGroupBy.mockRejectedValue(new Error('statement timeout'))
    await expect(projectLiveStatus([A], CALLER, NOW)).rejects.toThrow('statement timeout')
  })
})

describe('lastUsed: the activity clock is hourly, and the words say so', () => {
  const now = NOW.getTime()
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour

  it('says "within the last hour", never minutes', () => {
    expect(lastUsed(new Date(now - 12 * min), now).column).toBe('Within the last hour')
    expect(lastUsed(new Date(now - 59 * min), now).fact).toBe('Used within the last hour')
  })

  it('counts hours, then days, then gives the date', () => {
    expect(lastUsed(new Date(now - 3 * hour - 10 * min), now).column).toBe('3 h ago')
    expect(lastUsed(new Date(now - 2 * day - 5 * hour), now).column).toBe('2 d ago')
    expect(lastUsed(new Date(now - 41 * day), now).column).toBe('Oct 6')
  })

  it('says a project was never used, in words', () => {
    expect(lastUsed(null, now)).toEqual({ column: 'Not yet', fact: 'Not used yet', exact: null })
  })
})

describe('checkedAgo: the self-healing loop, in words', () => {
  const now = NOW.getTime()

  it('rounds seconds down to tens, then minutes and hours', () => {
    expect(checkedAgo(new Date(now - 4_000), now)).toBe('Checked just now')
    expect(checkedAgo(new Date(now - 47_000), now)).toBe('Checked 40 s ago')
    expect(checkedAgo(new Date(now - 125_000), now)).toBe('Checked 2 min ago')
    expect(checkedAgo(new Date(now - 3 * 3_600_000), now)).toBe('Checked 3 h ago')
  })

  it('says nothing when there is no pass to report', () => {
    expect(checkedAgo(null, now)).toBeNull()
    expect(checkedAgo(new Date(now - 25 * 3_600_000), now)).toBeNull()
  })
})
