/**
 * THE USAGE PAGE COUNTS EVERY SELF-HEALING CHECK OF THE CYCLE
 * ===========================================================
 * GET /api/account/autonomy-activity used to read up to 10,000 audit rows,
 * unordered, and report how many it got. Every watched project writes about
 * 1,440 AUTONOMY_TICK rows a day, so one project reached the cap in about a
 * week; the total then stuck at 10,000 and the per-day split showed whichever
 * rows came back. The route now asks the database for one count per day.
 *
 * What it pins:
 *   - the count is the database's, so 138,240 checks read as 138,240;
 *   - only AUTONOMY_TICK is counted (one per pass), only for the account's
 *     projects, and only inside the cycle, in UTC;
 *   - every day of the cycle up to today is in perDay, zero when quiet;
 *   - lastAt is the newest check, or null when none ran this cycle;
 *   - the answer keeps runsThisCycle, perDay and cycleStart for older readers.
 *
 * Database-free: the query is recorded and answered here, the session is a
 * fixed user, and the account rule is a stub that grants one organization.
 */
import type { NextRequest } from 'next/server'

const mockQueries: Array<{ sql: string; values: unknown[] }> = []
let mockRows: Array<{ day: string; count: number; lastAt: string | null }> = []
let mockProjects: Array<{ id: string }> = []
const mockFindMany = jest.fn(async (_args: unknown) => mockProjects)

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: { findMany: (args: unknown) => mockFindMany(args) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      mockQueries.push({ sql: strings.join('$'), values })
      return mockRows
    }),
  },
}))

jest.mock('@/lib/auth/route-protection', () => ({
  withAuth: (handler: any) => (req: any) => handler(req, { user: { userId: 'u_owner', email: 'owner@example.test' } }),
}))

// The caller belongs to org_northwind and nothing else.
jest.mock('@/lib/entitlements', () => ({
  accountForCaller: jest.fn(async (_userId: string, requested?: string | null) =>
    requested === 'org_northwind' ? 'org_northwind' : null,
  ),
}))

jest.mock('@/lib/usage/account', () => ({
  accountProjectsWhere: (account: string) => ({ organizationId: account }),
}))

const { GET } = require('@/app/api/account/autonomy-activity/route')

const NOW = new Date('2026-11-16T12:00:00.000Z')

function request(orgId = 'org_northwind'): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/account/autonomy-activity?orgId=${orgId}`) } as unknown as NextRequest
}

async function read(orgId?: string) {
  const res = await GET(request(orgId))
  return { status: res.status, body: await res.json() }
}

/** One row per day of November up to the 16th, `perDay` checks each. */
function november(perDay: number, lastAt: string) {
  return Array.from({ length: 16 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    count: perDay,
    lastAt: i === 15 ? lastAt : `2026-11-${String(i + 1).padStart(2, '0')}T23:59:00.000Z`,
  }))
}

beforeEach(() => {
  // Only the clock: the route's promises must still run.
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'] })
  mockQueries.length = 0
  mockRows = []
  mockProjects = []
  mockFindMany.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

it('reports every check of the cycle, far past the old 10,000-row cap', async () => {
  mockProjects = [{ id: 'p_checkout' }, { id: 'p_mobile' }, { id: 'p_support' }, { id: 'p_shop' }, { id: 'p_analytics' }, { id: 'p_play' }]
  // Six watched projects, a check a minute each: 8,640 a day.
  mockRows = november(8_640, '2026-11-16T11:59:28.000Z')

  const { status, body } = await read()

  expect(status).toBe(200)
  expect(body.runsThisCycle).toBe(138_240)
  expect(body.perDay).toHaveLength(16)
  expect(body.perDay[0]).toEqual({ date: '2026-11-01', count: 8_640 })
  expect(body.perDay[15]).toEqual({ date: '2026-11-16', count: 8_640 })
  expect(body.lastAt).toBe('2026-11-16T11:59:28.000Z')
})

it('counts only the loop’s pass marker, for the account’s projects, inside the cycle in UTC', async () => {
  mockProjects = [{ id: 'p_checkout' }, { id: 'p_mobile' }]
  mockRows = []

  await read()

  expect(mockFindMany).toHaveBeenCalledWith({ where: { organizationId: 'org_northwind' }, select: { id: true } })
  expect(mockQueries).toHaveLength(1)
  const [{ sql, values }] = mockQueries
  // One grouped count, not rows read back and counted in JS.
  expect(sql).toMatch(/COUNT\(\*\)/)
  expect(sql).toMatch(/GROUP BY 1/)
  expect(sql).not.toMatch(/LIMIT/i)
  // Only the marker the reconciler writes once per pass.
  expect(sql).toContain(`"action" = 'AUTONOMY_TICK'`)
  expect(sql).not.toMatch(/"type"\s*=/)
  // The account's projects, and the cycle's bounds: November 1 up to December 1, UTC.
  expect(values[0]).toEqual(['p_checkout', 'p_mobile'])
  expect((values[1] as Date).toISOString()).toBe('2026-11-01T00:00:00.000Z')
  expect((values[2] as Date).toISOString()).toBe('2026-12-01T00:00:00.000Z')
  expect(sql).toMatch(/"timestamp" >= \(\$::timestamptz AT TIME ZONE 'UTC'\)/)
  expect(sql).toMatch(/"timestamp" < \(\$::timestamptz AT TIME ZONE 'UTC'\)/)
})

it('lists every day up to today, zero when no check ran, and the newest check across days', async () => {
  mockProjects = [{ id: 'p_todo' }]
  mockRows = [
    { day: '2026-11-03', count: 1_440, lastAt: '2026-11-03T23:59:41.000Z' },
    { day: '2026-11-04', count: 600, lastAt: '2026-11-04T09:59:02.000Z' },
  ]

  const { body } = await read()

  expect(body.runsThisCycle).toBe(2_040)
  expect(body.perDay.map((d: { count: number }) => d.count)).toEqual([0, 0, 1_440, 600, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  // The loop stopped on the 4th (the project went idle): the last check says so.
  expect(body.lastAt).toBe('2026-11-04T09:59:02.000Z')
})

it('says no check yet this cycle as zero and a null lastAt', async () => {
  mockProjects = [{ id: 'p_todo' }]
  mockRows = []

  const { body } = await read()

  expect(body.runsThisCycle).toBe(0)
  expect(body.lastAt).toBeNull()
  expect(body.perDay).toHaveLength(16)
  expect(body.perDay.every((d: { count: number }) => d.count === 0)).toBe(true)
})

it('asks nothing of the audit log for an account with no projects', async () => {
  mockProjects = []

  const { status, body } = await read()

  expect(status).toBe(200)
  expect(mockQueries).toHaveLength(0)
  expect(body).toEqual({
    runsThisCycle: 0,
    perDay: expect.any(Array),
    cycleStart: '2026-11-01T00:00:00.000Z',
    lastAt: null,
  })
})

it('keeps the answer older readers rely on, and adds lastAt', async () => {
  mockProjects = [{ id: 'p_checkout' }]
  mockRows = [{ day: '2026-11-16', count: 720, lastAt: '2026-11-16T11:59:50.000Z' }]

  const { body } = await read()

  expect(Object.keys(body).sort()).toEqual(['cycleStart', 'lastAt', 'perDay', 'runsThisCycle'])
  expect(body.cycleStart).toBe('2026-11-01T00:00:00.000Z')
  for (const day of body.perDay) {
    expect(day).toEqual({ date: expect.stringMatching(/^2026-11-\d\d$/), count: expect.any(Number) })
  }
})

it('answers not found for an organization the caller is not in, and reads nothing', async () => {
  const { status } = await read('org_someone_else')

  expect(status).toBe(404)
  expect(mockFindMany).not.toHaveBeenCalled()
  expect(mockQueries).toHaveLength(0)
})
