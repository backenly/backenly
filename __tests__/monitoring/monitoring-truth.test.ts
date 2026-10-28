/**
 * MONITORING READS WHAT THE RUNTIME RECORDS
 * =========================================
 * The runtime records every request in `api_request_logs`. The monitoring
 * surfaces read `Log` — a table no runtime path writes (its only writers are
 * platform auth events with no projectId). Three lies followed:
 *
 *   - `monitoring {metrics}`: "No API metrics available yet" on any traffic
 *   - `monitoring {errors}`: "No errors in the last hour! Your APIs are
 *     running smoothly." while request_logs held the 500s
 *   - the console Logs tab: "No logs yet" forever
 *
 * Pinned here against seeded runtime rows:
 *
 *   - metrics report count, error rate and latency percentiles from the real
 *     record, excluding preview-branch traffic
 *   - errors report the 5xx grouped by endpoint with count and last-seen,
 *     window-scoped, branch-excluded
 *   - the logs route serves the union of legacy Log rows and runtime requests,
 *     with working severity/type/search filters and database-side counts
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { executeAction } from '@/lib/ai/minimal-executor'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdProjectIds: string[] = []
let projectId = ''
let ownerToken = ''

const MIN = 60 * 1000

beforeAll(async () => {
  assertSafeTestDatabase()
  const email = `mon-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Monitoring Truth Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  ownerToken = (await createSession(u.id, email, 'user')).token
  const p = await prisma.project.create({
    data: { name: `mon-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id

  const now = Date.now()
  const row = (over: Partial<{ method: string; path: string; statusCode: number; duration: number; timestamp: Date; branchId: string | null }>) => ({
    projectId,
    userId: u.id,
    method: 'GET',
    path: '/v2/posts',
    statusCode: 200,
    duration: 100,
    timestamp: new Date(now - 5 * MIN),
    branchId: null as string | null,
    ...over,
  })
  await prisma.apiRequestLog.createMany({
    data: [
      row({ duration: 50 }),
      row({ duration: 100 }),
      row({ duration: 150 }),
      row({ method: 'POST', path: '/v2/orders', statusCode: 500, duration: 30, timestamp: new Date(now - 10 * MIN) }),
      row({ method: 'POST', path: '/v2/orders', statusCode: 500, duration: 40, timestamp: new Date(now - 20 * MIN) }),
      row({ path: '/v2/missing', statusCode: 404, duration: 10 }),
      // Preview-branch traffic: never a production signal — and the ONLY 5xx
      // inside the last five minutes, so the clean-window answer below is a
      // statement about branch exclusion, not about an empty table.
      row({ method: 'POST', path: '/v2/orders', statusCode: 500, branchId: 'branch-1', timestamp: new Date(now - 2 * MIN) }),
      // Outside the 60-minute window.
      row({ method: 'POST', path: '/v2/orders', statusCode: 500, timestamp: new Date(now - 3 * 60 * MIN) }),
    ],
  })
  // One legacy Log row, to prove the union serves both stores.
  await prisma.log.create({
    data: { projectId, type: 'system', severity: 'info', message: 'legacy system note', service: 'platform' },
  })
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.apiRequestLog.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.log.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
  resetSingleTenantCache()
})

describe('monitoring.metrics', () => {
  it('reports real traffic: count, error rate, percentiles — branch rows excluded', async () => {
    const result = await executeAction(
      { action: 'GET_METRICS', params: { windowMinutes: 60 } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    const stats = (result.data as any)?.stats
    expect(stats?.count).toBe(6)
    expect(stats?.serverErrorCount).toBe(2)
    expect(result.message).toContain('6 requests')
    expect(result.message).toContain('error rate')
    expect(result.message).toContain('p95')
    expect(result.message).not.toContain('No API metrics available yet')
  })
})

describe('monitoring.errors', () => {
  it('reports the 5xx grouped by endpoint with count and last-seen', async () => {
    const result = await executeAction(
      { action: 'GET_ERRORS', params: { windowMinutes: 60 } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect((result.data as any)?.count).toBe(2)
    expect(result.message).toContain('POST /v2/orders')
    expect(result.message).toContain('500 × 2')
    expect(result.message).not.toContain('running smoothly')
  })

  it('answers honestly when the window really is clean', async () => {
    const result = await executeAction(
      { action: 'GET_ERRORS', params: { windowMinutes: 5 } } as any,
      projectId
    )

    // The only 5xx in the last five minutes is the preview-branch row, which
    // is not a production signal.
    expect(result.success).toBe(true)
    expect((result.data as any)?.count).toBe(0)
    expect(result.message).toContain('No 5xx')
  })
})

describe('the Logs explorer route', () => {
  async function fetchLogs(query: string) {
    const { GET } = await import('@/app/api/logs/route')
    const headers: Record<string, string> = { authorization: `Bearer ${ownerToken}` }
    const res: any = await GET({
      method: 'GET',
      url: `http://localhost:3000/api/logs?projectId=${projectId}${query}`,
      nextUrl: {
        pathname: '/api/logs',
        searchParams: new URLSearchParams(`projectId=${projectId}${query}`),
      },
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      cookies: { get: () => undefined },
    } as any)
    return { status: res.status, body: await res.json() }
  }

  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })
  afterEach(() => {
    delete process.env.BACKENLY_EDITION
    resetSingleTenantCache()
  })

  it('serves runtime requests and legacy rows as one explorer', async () => {
    const { status, body } = await fetchLogs('')

    expect(status).toBe(200)
    // 6 production runtime rows in the hour + 1 older + 1 legacy Log row;
    // the branch row is excluded.
    expect(body.stats.total).toBe(8)
    expect(body.stats.error).toBe(3)
    expect(body.stats.warning).toBe(1)
    const messages = body.logs.map((l: any) => l.message)
    expect(messages).toContain('POST /v2/orders -> 500')
    expect(messages).toContain('legacy system note')
  })

  it('severity and type filters work across the union', async () => {
    const errors = await fetchLogs('&severity=error')
    expect(errors.body.pagination.total).toBe(3)

    const system = await fetchLogs('&type=system')
    expect(system.body.pagination.total).toBe(1)
    expect(system.body.logs[0].message).toBe('legacy system note')

    const search = await fetchLogs('&search=orders')
    expect(search.body.pagination.total).toBe(3)
  })
})
