/**
 * A CLIENT'S ERROR IS NOT THE BACKEND FAILING
 * ===========================================
 * A request with a wrong key is recorded as the project's traffic on purpose
 * (it is often the project's own app holding a revoked key), and it answers
 * 401. Counted as a failure, a burst of them from strangers lowered every rate
 * and could revert a change that broke nothing (production QA re-test
 * 2026-11-16, #73). Google's SRE Workbook: "5XX responses count against SLO,
 * while all other requests are considered successful."
 *
 *   • the reader-switch check judges errors a change can cause (5xx, and 400,
 *     403, 404, 409, 422), never a refused credential (401) or a rate limit (429);
 *   • the agent's metrics give the error rate on 5xx and the 4xx as their own number;
 *   • the per-endpoint numbers Monitoring and the agent read say 5xx and 4xx apart.
 *
 * Real request log rows; nothing else is needed.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { observeSwitch } from '@/lib/autonomy/maintenance/observe'
import { getPerformanceBreakdown, getRuntimeWindowStats } from '@/lib/services/metrics'
import { executeAction } from '@/lib/ai/minimal-executor'

const HOUR = 60 * 60 * 1000
let ownerId = ''

async function project(): Promise<string> {
  return (await prisma.project.create({ data: { name: `failures-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
}

async function served(projectId: string, at: Date, statusCode: number, n: number, path = '/db/orders') {
  await prisma.apiRequestLog.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      projectId,
      userId: ownerId,
      method: 'GET',
      path,
      statusCode,
      duration: 40,
      timestamp: new Date(at.getTime() + i * 1000),
    })),
  })
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `failures-${randomUUID()}@example.test`, name: 'Failures' }, select: { id: true } })).id
})

afterAll(async () => {
  await prisma.apiRequestLog.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('the reader-switch check', () => {
  const switchedAt = new Date(Date.now() - HOUR)
  const before = new Date(switchedAt.getTime() - 50 * 60 * 1000)
  const after = new Date(switchedAt.getTime() + 10 * 60 * 1000)

  it('does not call a burst of wrong-key 401s after a switch a regression', async () => {
    const id = await project()
    await served(id, before, 200, 40)
    await served(id, after, 200, 40)
    await served(id, after, 401, 30)

    const o = await observeSwitch(id, switchedAt, HOUR)

    expect(o.outcome).not.toBe('regressed')
    expect(o.shouldRevert).toBe(false)
    expect(o.after.errors).toBe(0)
  })

  it('does not call a burst of rate-limited 429s a regression either', async () => {
    const id = await project()
    await served(id, before, 200, 40)
    await served(id, after, 200, 40)
    await served(id, after, 429, 30)

    expect((await observeSwitch(id, switchedAt, HOUR)).shouldRevert).toBe(false)
  })

  it('still reverts on the errors a switch can cause: missing rows and server errors', async () => {
    const missing = await project()
    await served(missing, before, 200, 40)
    await served(missing, after, 200, 40)
    await served(missing, after, 404, 30)
    expect(await observeSwitch(missing, switchedAt, HOUR)).toMatchObject({ outcome: 'regressed', shouldRevert: true })

    const failing = await project()
    await served(failing, before, 200, 40)
    await served(failing, after, 200, 40)
    await served(failing, after, 500, 5)
    expect(await observeSwitch(failing, switchedAt, HOUR)).toMatchObject({ outcome: 'regressed', shouldRevert: true })
  })
})

describe('the error rate', () => {
  it("an agent's metrics give 0% for 401s only, and the 4xx as their own number", async () => {
    const id = await project()
    const recent = new Date(Date.now() - 20 * 60 * 1000)
    await served(id, recent, 200, 50)
    await served(id, recent, 401, 50)

    const r = await executeAction({ action: 'GET_METRICS', params: { windowMinutes: 60 } }, id)

    expect(r.success).toBe(true)
    expect(r.data.stats).toMatchObject({ count: 100, serverErrorCount: 0, clientErrorCount: 50, errorRatePct: 0 })
    expect(r.message).toContain('error rate 0.0%')
    expect(r.message).toContain('50 × 4xx')
    expect(r.message).not.toMatch(/50\.0% errors/)
  })

  it('counts a 5xx against the rate, and only a 5xx', async () => {
    const id = await project()
    const recent = new Date(Date.now() - 20 * 60 * 1000)
    await served(id, recent, 200, 80)
    await served(id, recent, 404, 10)
    await served(id, recent, 503, 10)

    const w = await getRuntimeWindowStats(id, new Date(Date.now() - HOUR), new Date())

    expect(w).toMatchObject({ count: 100, serverErrorCount: 10, clientErrorCount: 10, errorRatePct: 10, reliabilityPct: 90 })
  })

  it('says 5xx and 4xx apart for each endpoint', async () => {
    const id = await project()
    const recent = new Date(Date.now() - 20 * 60 * 1000)
    await served(id, recent, 200, 6, '/db/movies')
    await served(id, recent, 401, 2, '/db/movies')
    await served(id, recent, 500, 2, '/db/movies')

    const [movies] = await getPerformanceBreakdown('1h', 'api', id)

    expect(movies).toMatchObject({ id: 'GET /db/movies', requests: 10, errorRate: 20, clientErrorRate: 20 })
  })
})
