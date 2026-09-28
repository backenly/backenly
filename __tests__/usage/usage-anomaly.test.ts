/**
 * A SPIKE IS NAMED THE DAY IT HAPPENS, WITH ITS EVIDENCE, AND WITHDRAWN WHEN IT ENDS
 * ================================================================================
 * The spend guard's detector: a project whose daily egress, function runs or
 * new MAU jumped far past its own fourteen-day median (and past an absolute
 * floor) gets one `usage_anomaly_<axis>` finding in the Autonomy queue, carrying
 * the ledger reading, the baseline and, for egress, the request paths that
 * carried the day. It is refreshed while the spike lasts, never duplicated, and
 * resolved once a day is back near normal.
 *
 * Real database.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { evaluateUsageAnomalies, judge, ANOMALY_FLOOR } from '@/lib/usage/anomaly'
import { classifyFix } from '@/lib/core/fix-classifier'
import { getManualRemediationHint } from '@/lib/core/fix-actions'
import { normalizeFindingType } from '@/lib/core/types'

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const GB = 1024 ** 3
const users: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

async function project() {
  const user = await prisma.user.create({ data: { email: `spike-${randomUUID()}@test.invalid`, name: 'Spike' }, select: { id: true } })
  users.push(user.id)
  const p = await prisma.project.create({ data: { name: 'spike', userId: user.id }, select: { id: true } })
  return { userId: user.id, projectId: p.id }
}

const d = (iso: string) => new Date(`${iso}T00:00:00Z`)

async function egress(userId: string, projectId: string, iso: string, bytes: number, source = 'app') {
  await prisma.usageDaily.create({
    data: { billingAccountId: userId, projectId, axis: 'egress_bytes', day: d(iso), source, quantity: BigInt(Math.round(bytes)) },
  })
}

/** Fourteen ordinary days before `iso`, at `bytes` each. */
async function baseline(userId: string, projectId: string, iso: string, bytes: number) {
  for (let i = 1; i <= 14; i++) {
    await egress(userId, projectId, new Date(d(iso).getTime() - i * 86_400_000).toISOString().slice(0, 10), bytes)
  }
}

const findings = (projectId: string) =>
  prisma.healthFinding.findMany({ where: { projectId, type: { startsWith: 'usage_anomaly_' } }, orderBy: { detectedAt: 'asc' } })

beforeAll(() => assertSafeTestDatabase())

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "usage_daily" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.project.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('judging a day', () => {
  it('needs both the ratio and the floor', () => {
    const history = Array(14).fill(0.1 * GB)
    expect(judge('egress_bytes', 2 * GB, history).spike).toBe(true) // 20x, over 1 GB
    expect(judge('egress_bytes', 0.4 * GB, history).spike).toBe(false) // 4x
    expect(judge('egress_bytes', 0.9 * GB, Array(14).fill(0.01 * GB)).spike).toBe(false) // 90x, under the floor
    expect(judge('egress_bytes', 1.2 * GB, Array(14).fill(0)).spike).toBe(true) // no history: the floor decides
    expect(ANOMALY_FLOOR.egress_bytes).toBe(GB)
  })
})

describe('the finding', () => {
  it('names the spike with its ledger evidence and the paths that carried it', async () => {
    const { userId, projectId } = await project()
    await baseline(userId, projectId, '2026-09-20', 0.1 * GB)
    await egress(userId, projectId, '2026-09-20', 1.2 * GB)
    // The load balancer measures the same responses: never counted twice.
    await egress(userId, projectId, '2026-09-20', 50 * GB, 'alb')
    await prisma.apiRequestLog.createMany({
      data: [
        ...Array(30).fill(0).map(() => ({ projectId, userId, method: 'GET', path: `/api/v1/${projectId}/db/photos`, statusCode: 200, duration: 3, timestamp: new Date('2026-09-20T10:00:00Z') })),
        ...Array(5).fill(0).map(() => ({ projectId, userId, method: 'GET', path: `/api/v1/${projectId}/db/users`, statusCode: 200, duration: 3, timestamp: new Date('2026-09-20T11:00:00Z') })),
        // The next day's traffic is not this day's evidence.
        ...Array(99).fill(0).map(() => ({ projectId, userId, method: 'GET', path: '/elsewhere', statusCode: 200, duration: 3, timestamp: new Date('2026-09-21T01:00:00Z') })),
      ],
    })

    const r = await evaluateUsageAnomalies(d('2026-09-20'))

    expect(r.raised).toBeGreaterThanOrEqual(1)
    const [f] = await findings(projectId)
    expect(f).toMatchObject({ type: 'usage_anomaly_egress_bytes', status: 'open', severity: 'warning', source: 'usage_monitor', category: 'reliability' })
    const details = f.details as any
    expect(details.title).toBe('egress 12x its usual level on 2026-09-20')
    expect(details.observed).toBe(Math.round(1.2 * GB))
    expect(details.baseline).toBe(Math.round(0.1 * GB))
    expect(details.topPaths.map((p: any) => [p.path, p.requests])).toEqual([
      [`/api/v1/${projectId}/db/photos`, 30],
      [`/api/v1/${projectId}/db/users`, 5],
    ])
    expect(getManualRemediationHint(f.type, details)).toContain(`/api/v1/${projectId}/db/photos`)
  })

  it('is refreshed while the spike lasts, then resolved once a day is back near normal', async () => {
    const { userId, projectId } = await project()
    await baseline(userId, projectId, '2026-09-20', 0.1 * GB)
    await egress(userId, projectId, '2026-09-20', 1.5 * GB)
    await egress(userId, projectId, '2026-09-21', 2.5 * GB)
    await egress(userId, projectId, '2026-09-22', 0.12 * GB)

    await evaluateUsageAnomalies(d('2026-09-20'))
    await evaluateUsageAnomalies(d('2026-09-21'))
    let rows = await findings(projectId)
    expect(rows).toHaveLength(1)
    expect((rows[0].details as any).day).toBe('2026-09-21')

    await evaluateUsageAnomalies(d('2026-09-22'))
    rows = await findings(projectId)
    expect(rows.map((f) => f.status)).toEqual(['resolved'])
  })

  it('withdraws itself when the project goes quiet altogether', async () => {
    const { userId, projectId } = await project()
    await baseline(userId, projectId, '2026-06-10', 0.1 * GB)
    await egress(userId, projectId, '2026-06-10', 2 * GB)
    await evaluateUsageAnomalies(d('2026-06-10'))
    expect((await findings(projectId)).map((f) => f.status)).toEqual(['open'])

    // Months later there is no reading for it at all.
    await evaluateUsageAnomalies(d('2026-09-25'))
    expect((await findings(projectId)).map((f) => f.status)).toEqual(['resolved'])
  })

  it('says nothing about ordinary growth or a quiet project', async () => {
    const steady = await project()
    await baseline(steady.userId, steady.projectId, '2026-09-20', 0.5 * GB)
    await egress(steady.userId, steady.projectId, '2026-09-20', 1.1 * GB) // 2.2x

    const tiny = await project()
    await egress(tiny.userId, tiny.projectId, '2026-09-20', 50 * 1024 * 1024) // 50 MB from nothing

    await evaluateUsageAnomalies(d('2026-09-20'))

    expect(await findings(steady.projectId)).toEqual([])
    expect(await findings(tiny.projectId)).toEqual([])
  })
})

describe('the finding type is registered like every other', () => {
  it('normalizes per axis, is notify-only, and has a manual hint', () => {
    expect(normalizeFindingType('usage_anomaly_egress_bytes', null)?.base).toBe('usage_anomaly')
    expect(classifyFix('usage_anomaly_fn_runs', null).decision).toBe('notify_only')
    expect(getManualRemediationHint('usage_anomaly_egress_bytes', { axis: 'egress_bytes' })).toMatch(/file downloads/)
  })
})
