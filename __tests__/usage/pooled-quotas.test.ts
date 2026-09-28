/**
 * QUOTAS ARE THE ACCOUNT'S, AND ONLY THE OWNER'S SPEND LIMIT RAISES THEM
 * =====================================================================
 * Every usage quota used to be checked per project, so an owner with N projects
 * had N times the plan: two projects of 6 GB and 5 GB against a 10 GB plan were
 * both "within quota". Quotas now pool across the owner's projects, and past
 * the included quantity only an `enforce` overage policy with a spend limit
 * above $0 raises the cap, by exactly what the remaining limit buys.
 *
 * Alerts are sent once per account, month, axis and level, however often the
 * sweep runs.
 *
 * Real database throughout. Only the entitlements provider is stubbed: the
 * plan and the overage policy are the inputs under test, and the public edition
 * has no Plan table.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import type { OveragePolicy, UserEntitlements } from '@/lib/entitlements/types'
import { utcDay, utcPeriod } from '@/lib/usage/axes'

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

let ent: UserEntitlements
let policy: OveragePolicy | null = null
jest.mock('@/lib/entitlements', () => ({
  ...jest.requireActual('@/lib/entitlements'),
  getUserEntitlements: () => Promise.resolve(ent),
  getOveragePolicy: () => Promise.resolve(policy),
}))

const { canAcceptNewEndUser, enforceDbStorage, enforceRealtimeConnection } = require('@/lib/quota/kernel')
const { assertQuotaAvailable, getProjectQuota, QuotaExceededError } = require('@/lib/services/storageQuota')
const { enforceAiFunctionInvocation } = require('@/lib/entitlements/policy')
const { accountUsage } = require('@/lib/usage/pool')
const { computeAccountLimits, effectiveCap, invalidateAccountLimits } = require('@/lib/usage/overage')
const { evaluateAccountAlerts, recordQuotaWarning } = require('@/lib/usage/alerts')

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const users: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

function pro(over: Partial<UserEntitlements> = {}): UserEntitlements {
  return {
    ...selfHostedEntitlements(),
    planName: 'BUILDER',
    maxMonthlyActiveUsers: 3,
    maxPostgresStorageMb: 10 * 1024,
    maxFileStorageMb: 10 * 1024,
    maxAiFunctionInvocationsPerMonth: 10,
    includedEgressMb: 1024,
    ...over,
  }
}

/** One owner with two projects. In-app notifications only, so no mail is attempted. */
async function account(storage: [number, number] = [0, 0]) {
  const user = await prisma.user.create({
    data: { email: `pool-${randomUUID()}@test.invalid`, name: 'Pool' },
    select: { id: true },
  })
  users.push(user.id)
  await prisma.notificationPreference.create({
    data: { userId: user.id, type: 'usage_limit', emailEnabled: false, inAppEnabled: true },
  })
  const [a, b] = await Promise.all(
    storage.map((bytes, i) =>
      prisma.project.create({
        data: { name: `pool-${i}-${randomUUID().slice(0, 6)}`, userId: user.id, storageUsed: BigInt(bytes) },
        select: { id: true },
      }),
    ),
  )
  return { userId: user.id, a: a.id, b: b.id }
}

async function activeUsers(projectId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await prisma.projectActiveUser.create({ data: { projectId, endUserId: randomUUID(), month: utcPeriod() } })
  }
}

async function dbSize(projectId: string, mb: number, month = utcPeriod()) {
  await prisma.projectUsage.upsert({
    where: { projectId_month: { projectId, month } },
    update: { dbStorageUsedMb: mb },
    create: { projectId, month, dbStorageUsedMb: mb },
  })
}

async function usageNotifications(userId: string) {
  return prisma.platformNotification.findMany({ where: { userId, type: 'usage_limit' }, orderBy: { createdAt: 'asc' } })
}

beforeAll(() => assertSafeTestDatabase())

beforeEach(() => {
  ent = pro()
  policy = null
  invalidateAccountLimits()
})

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "usage_alerts" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.$executeRaw`DELETE FROM "usage_limit_states" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.$executeRaw`DELETE FROM "usage_daily" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.userAiUsage.deleteMany({ where: { userId: { in: users } } })
  await prisma.project.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('quotas pool across the owner\'s projects', () => {
  it('file storage: 6 GB + 5 GB is over a 10 GB plan, whichever project uploads', async () => {
    const { a, b } = await account([6 * GiB, 5 * GiB])

    await expect(assertQuotaAvailable(a, MiB)).rejects.toBeInstanceOf(QuotaExceededError)
    await expect(assertQuotaAvailable(b, MiB)).rejects.toBeInstanceOf(QuotaExceededError)

    const quota = await getProjectQuota(a)
    expect(quota.used).toBe(BigInt(11 * GiB))
    expect(quota.projectUsed).toBe(BigInt(6 * GiB))
    expect(quota.limit).toBe(BigInt(10 * GiB))
  })

  it('file storage: the remaining pool, not each project\'s own room, bounds an upload', async () => {
    const { b } = await account([4 * GiB, 5 * GiB])

    await expect(assertQuotaAvailable(b, GiB / 2)).resolves.toBeUndefined()
    await expect(assertQuotaAvailable(b, GiB + GiB / 2)).rejects.toBeInstanceOf(QuotaExceededError)
  })

  it('database: each project\'s latest size, summed, against the plan', async () => {
    const { a, b } = await account()
    await dbSize(a, 6 * 1024)
    await dbSize(b, 5 * 1024)
    // An older, larger reading is not the project's size any more.
    await dbSize(b, 9 * 1024, '2020-01')

    await expect(enforceDbStorage(a)).resolves.toMatchObject({ allowed: false, code: 'PLAN_LIMIT_EXCEEDED' })
    expect((await accountUsage((await prisma.project.findUnique({ where: { id: a } }))!.userId)).dbBytes).toBe(
      BigInt(11 * GiB),
    )

    // A different owner with the same per-project sizes is inside their own pool.
    const other = await account()
    await dbSize(other.a, 6 * 1024)
    await expect(enforceDbStorage(other.a)).resolves.toMatchObject({ allowed: true })
  })

  it('MAU: end users of every project count toward one cap', async () => {
    const { a, b } = await account()
    await activeUsers(a, 2)
    await activeUsers(b, 1)

    await expect(canAcceptNewEndUser(a)).resolves.toMatchObject({ allowed: false, max: 3, used: 3 })
    await expect(canAcceptNewEndUser(b)).resolves.toMatchObject({ allowed: false })

    const other = await account()
    await activeUsers(other.a, 2)
    await expect(canAcceptNewEndUser(other.a)).resolves.toMatchObject({ allowed: true })
  })

  it('realtime: live streams of the owner\'s other projects count toward one cap', async () => {
    ent = pro({ maxRealtimeConnections: 3 })
    const { a, b } = await account()
    const other = await account()
    const live: Record<string, number> = { [b]: 3, [other.a]: 50 }
    const count = (ids: string[]) => ids.reduce((sum, id) => sum + (live[id] ?? 0), 0)

    await expect(enforceRealtimeConnection(a, 0, count)).resolves.toMatchObject({ allowed: false, used: 3, max: 3 })
    live[b] = 2
    await expect(enforceRealtimeConnection(a, 0, count)).resolves.toMatchObject({ allowed: true })
    // Another owner's streams never count against this account.
    await expect(enforceRealtimeConnection(other.b, 0, count)).resolves.toMatchObject({ allowed: false, used: 50 })
  })

  it('egress: the ledger\'s billed sources only, across projects', async () => {
    const { userId, a, b } = await account()
    const day = utcDay()
    await prisma.usageDaily.createMany({
      data: [
        { billingAccountId: userId, projectId: a, axis: 'egress_bytes', day, source: 'app', quantity: BigInt(300) },
        { billingAccountId: userId, projectId: b, axis: 'egress_bytes', day, source: 's3', quantity: BigInt(200) },
        // The load balancer measures the same responses as `app`: never both.
        { billingAccountId: userId, projectId: a, axis: 'egress_bytes', day, source: 'alb', quantity: BigInt(9999) },
      ],
    })
    expect((await accountUsage(userId)).egressBytes).toBe(BigInt(500))
  })
})

describe('only an enforce policy with a spend limit raises a cap', () => {
  it('buys exactly the units the remaining limit pays for', async () => {
    const { a, b, userId } = await account()
    await activeUsers(a, 2)
    await activeUsers(b, 1)

    policy = { mode: 'enforce', spendLimitCents: 100 }
    // $1.00 at $0.003 per MAU is 333 more users past the 3 included.
    expect(await effectiveCap(userId, 'mau', 3)).toBe(336)
    await expect(canAcceptNewEndUser(a)).resolves.toMatchObject({ allowed: true })
  })

  it('stays a hard cap in shadow, with a $0 limit, and on a plan without overage', async () => {
    const { a, b } = await account()
    await activeUsers(a, 2)
    await activeUsers(b, 1)

    for (const [p, e] of [
      [{ mode: 'shadow', spendLimitCents: 100_000 }, pro()],
      [{ mode: 'enforce', spendLimitCents: 0 }, pro()],
      [{ mode: 'off', spendLimitCents: 100_000 }, pro()],
      [{ mode: 'enforce', spendLimitCents: 100_000 }, pro({ planName: 'SANDBOX' })],
      [null, pro()],
    ] as Array<[OveragePolicy | null, UserEntitlements]>) {
      policy = p
      ent = e
      invalidateAccountLimits()
      await expect(canAcceptNewEndUser(a)).resolves.toMatchObject({ allowed: false })
    }
  })

  it('files: overage already used is paid from the same limit', async () => {
    const { a } = await account([11 * GiB, 0])
    // 1 GB past the plan is an estimated $0.03 of a $0.30 limit; the $0.27
    // left buys 9 GB more at $0.03 per GB, so the cap is 20 GB.
    policy = { mode: 'enforce', spendLimitCents: 30 }

    await expect(assertQuotaAvailable(a, 8 * GiB)).resolves.toBeUndefined()
    invalidateAccountLimits()
    await expect(assertQuotaAvailable(a, 10 * GiB)).rejects.toBeInstanceOf(QuotaExceededError)
  })

  it('function runs: past the included runs only within the limit', async () => {
    const { userId } = await account()
    await prisma.userAiUsage.create({ data: { userId, date: utcPeriod(), aiFunctionInvocations: 10 } })

    await expect(enforceAiFunctionInvocation(userId)).resolves.not.toBe(true)

    policy = { mode: 'enforce', spendLimitCents: 100 }
    invalidateAccountLimits()
    await expect(enforceAiFunctionInvocation(userId)).resolves.toBe(true)
  })

  it('one limit is shared by every axis', () => {
    const usage = {
      billingAccountId: 'acct',
      period: '2026-09',
      mau: 3,
      fnRuns: 10 + 1_000_000, // $2.00 past the included runs
      egressBytes: BigInt(0),
      dbBytes: BigInt(0),
      fileBytes: BigInt(0),
    }
    const limits = computeAccountLimits(pro(), usage, { mode: 'enforce', spendLimitCents: 250 }, 'direct')
    expect(limits.estimatedCents).toBeCloseTo(200, 6)
    // The $0.50 left buys 166 MAU, not the 833 a full $2.50 would.
    expect(limits.axes.mau.headroom).toBe(166)
    expect(limits.axes.mau.cap).toBe(3 + 166)
    expect(limits.axes.fn_runs.cap).toBe(1_000_010 + 250_000)
    // Unlimited axes stay unlimited.
    expect(computeAccountLimits(pro({ maxMonthlyActiveUsers: null }), usage, null).axes.mau.cap).toBeNull()
  })
})

describe('usage alerts', () => {
  it('records every crossed level, sends one message for the highest, and never repeats', async () => {
    const { userId, a } = await account()
    await dbSize(a, 8.7 * 1024) // 87% of 10 GB

    await expect(evaluateAccountAlerts(userId)).resolves.toEqual({ recorded: 2, sent: 1 })
    await expect(evaluateAccountAlerts(userId)).resolves.toEqual({ recorded: 0, sent: 0 })

    let sent = await usageNotifications(userId)
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe("You've used 80% of your included database storage")
    expect(sent[0].metadata).toMatchObject({ axis: 'db_bytes', level: '80', limitLabel: '10 GB' })

    await dbSize(a, 10.5 * 1024)
    await expect(evaluateAccountAlerts(userId)).resolves.toEqual({ recorded: 1, sent: 1 })
    sent = await usageNotifications(userId)
    expect(sent).toHaveLength(2)
    expect(sent[1].title).toBe("You've used all of your included database storage")
    expect(sent[1].body).toContain('Schema changes and bulk writes')
  })

  it('keeps one continuous over-limit stretch for the grace period', async () => {
    const { userId, a } = await account()
    await dbSize(a, 11 * 1024)

    const first = new Date('2026-09-10T00:00:00Z')
    await evaluateAccountAlerts(userId, first)
    await evaluateAccountAlerts(userId, new Date('2026-09-12T00:00:00Z'))
    const state = () =>
      prisma.usageLimitState.findUnique({ where: { billingAccountId_axis: { billingAccountId: userId, axis: 'db_bytes' } } })
    expect((await state())?.overSince?.toISOString()).toBe(first.toISOString())

    await dbSize(a, 2 * 1024)
    await evaluateAccountAlerts(userId, new Date('2026-09-13T00:00:00Z'))
    expect((await state())?.overSince).toBeNull()
  })

  it('alerts on the spend limit when overage is being used', async () => {
    const { userId } = await account()
    await prisma.userAiUsage.create({ data: { userId, date: utcPeriod(), aiFunctionInvocations: 10 + 450_000 } })
    policy = { mode: 'enforce', spendLimitCents: 100 } // $0.90 of $1.00 estimated

    await evaluateAccountAlerts(userId)
    const spend = (await usageNotifications(userId)).filter((n) => (n.metadata as any)?.axis === 'spend')
    expect(spend).toHaveLength(1)
    expect(spend[0].title).toBe("You've reached 80% of your spend limit")
    const levels = await prisma.usageAlert.findMany({ where: { billingAccountId: userId, axis: 'spend' } })
    expect(levels.map((l) => l.level).sort()).toEqual(['50', '80'])
  })

  it('warns once on quotas that are never billed', async () => {
    const { userId } = await account()
    await expect(recordQuotaWarning(userId, 'api_requests', 85, 100, 'LIFETIME')).resolves.toBe(true)
    await expect(recordQuotaWarning(userId, 'api_requests', 95, 100, 'LIFETIME')).resolves.toBe(false)
    await expect(recordQuotaWarning(userId, 'realtime_connections', 10, 100, utcPeriod())).resolves.toBe(false)
    const sent = await usageNotifications(userId)
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe("You're at 85% of your API requests")
  })
})
