/**
 * A PERSON AND AN AGENT SEE THE SAME METER, AND NEITHER CAN RAISE THE LIMIT HERE
 * ==============================================================================
 * The account's usage this month is described once (lib/usage/describe.ts):
 * pooled usage against included and the cap, the month-end projection from the
 * ledger, the estimated cost past the plan, the spend limit and any grace. The
 * Usage page reads it from GET /api/usage/account; an agent reads it through
 * the MCP usage section (get_usage). Nothing an agent can call changes the
 * spend limit or turns overage on.
 *
 * Real database. Only the entitlements provider is stubbed: the plan and the
 * overage policy are the inputs, and the public edition has no Plan table.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import type { OveragePolicy, UserEntitlements } from '@/lib/entitlements/types'

const GiB = 1024 * 1024 * 1024

let ent: UserEntitlements
let policy: OveragePolicy | null = null
jest.mock('@/lib/entitlements', () => ({
  ...jest.requireActual('@/lib/entitlements'),
  getUserEntitlements: () => Promise.resolve(ent),
  getOveragePolicy: () => Promise.resolve(policy),
}))

let currentUserId = ''
jest.mock('@/lib/auth/server', () => ({
  ...jest.requireActual('@/lib/auth/server'),
  requireUser: () => Promise.resolve({ userId: currentUserId, email: 'meter@test.invalid', role: 'user' }),
}))

const { forecastAccount } = require('@/lib/usage/forecast')
const { describeAccountUsage } = require('@/lib/usage/describe')
const { invalidateAccountLimits } = require('@/lib/usage/overage')
const { invalidateRestrictions } = require('@/lib/usage/restrictions')
const { GET: accountUsageRoute } = require('@/app/api/usage/account/route')
const { executeAction } = require('@/lib/ai/minimal-executor')
const { buildDispatchable } = require('@/lib/mcp/catalog')
const { BRAIN_TOOLS } = require('@/lib/ai/brain/tools')

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
    maxMonthlyActiveUsers: 1_000,
    maxPostgresStorageMb: 1_024,
    maxFileStorageMb: 1_024,
    maxAiFunctionInvocationsPerMonth: 1_000,
    includedEgressMb: 1_024,
    ...over,
  }
}

async function account() {
  const user = await prisma.user.create({ data: { email: `meter-${randomUUID()}@test.invalid`, name: 'Meter' }, select: { id: true } })
  users.push(user.id)
  const project = await prisma.project.create({ data: { name: 'meter', userId: user.id }, select: { id: true } })
  return { userId: user.id, projectId: project.id }
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`)

async function ledger(userId: string, projectId: string, axis: string, iso: string, quantity: number, source = 'app') {
  await prisma.usageDaily.create({
    data: { billingAccountId: userId, projectId, axis, day: day(iso), source, quantity: BigInt(quantity) },
  })
}

beforeAll(() => assertSafeTestDatabase())

beforeEach(() => {
  ent = pro()
  policy = null
  invalidateAccountLimits()
  invalidateRestrictions()
})

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "usage_daily" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.$executeRaw`DELETE FROM "usage_limit_states" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.project.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('the month-end forecast', () => {
  it('projects counters from the last seven full days, across the month boundary', async () => {
    const { userId, projectId } = await account()
    // Now is 2026-09-05 12:00; 30 days in September, 5 elapsed, 25 left.
    const now = new Date('2026-09-05T12:00:00Z')
    for (const d of ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
      await ledger(userId, projectId, 'egress_bytes', d, 700)
    }
    await ledger(userId, projectId, 'egress_bytes', '2026-09-05', 100) // today, not in the trend
    // A source the close does not bill never counts.
    await ledger(userId, projectId, 'egress_bytes', '2026-09-03', 999_999, 'alb')

    const f = await forecastAccount(userId, now)

    expect(f.egress_bytes.monthToDate).toBe(4 * 700 + 100)
    expect(f.egress_bytes.projected).toBe(4 * 700 + 100 + 700 * 25)
  })

  it('projects storage as the month average with today held for the days left', async () => {
    const { userId, projectId } = await account()
    const now = new Date('2026-09-10T08:00:00Z')
    for (let d = 1; d <= 10; d++) {
      await ledger(userId, projectId, 'db_bytes', `2026-09-${String(d).padStart(2, '0')}`, d * 100, 'pg')
    }

    const f = await forecastAccount(userId, now)

    const byteDays = (100 * 10 * 11) / 2 // 100 + 200 + ... + 1000
    expect(f.db_bytes.monthToDate).toBe(Math.round(byteDays / 10))
    expect(f.db_bytes.projected).toBe(Math.round((byteDays + 1000 * 20) / 30))
  })
})

describe('the account description', () => {
  it('pools usage, shows the cap, the projection and what past-the-plan usage is estimated to cost', async () => {
    const { userId, projectId } = await account()
    await prisma.project.update({ where: { id: projectId }, data: { storageUsed: BigInt(2 * GiB) } })
    policy = { mode: 'enforce', spendLimitCents: 1_000 }

    const d = await describeAccountUsage(userId)

    expect(d.planName).toBe('BUILDER')
    expect(d.overage).toMatchObject({ mode: 'enforce', spendLimitCents: 1_000, active: true })
    const files = d.axes.find((a: any) => a.axis === 'file_bytes')
    expect(files).toMatchObject({ unit: 'bytes', used: 2 * GiB, included: GiB })
    // 1 GB past the plan at $0.0213 is 2.13 cents, shown as 2; the $10 limit
    // leaves $9.9787 of headroom.
    expect(files.estimatedCents).toBe(2)
    expect(files.cap).toBe(2 * GiB + Math.floor(((1_000 - 2.13) / 2.13) * GiB))
    expect(JSON.parse(JSON.stringify(d))).toEqual(d) // JSON-safe: no BigInt anywhere
  })

  it('names the grace period, and a restriction once it has run out', async () => {
    const { userId } = await account()
    const overSince = new Date(Date.now() - 9 * 86_400_000)
    await prisma.usageLimitState.create({ data: { billingAccountId: userId, axis: 'db_bytes', overSince } })

    const d = await describeAccountUsage(userId)

    const db = d.axes.find((a: any) => a.axis === 'db_bytes')
    expect(db.grace).toMatchObject({ overSince: overSince.toISOString(), restricted: true })
    expect(d.graceDays).toBe(7)
  })

  it('says overage can never be charged where there is no commercial half', async () => {
    const { userId } = await account()
    const d = await describeAccountUsage(userId)
    expect(d.overage).toMatchObject({ mode: null, spendLimitCents: 0, active: false })
  })
})

describe('the two readers', () => {
  it('GET /api/usage/account answers for the caller\'s own account only', async () => {
    const mine = await account()
    const theirs = await account()
    await prisma.project.update({ where: { id: theirs.projectId }, data: { storageUsed: BigInt(5 * GiB) } })
    currentUserId = mine.userId

    const res = await accountUsageRoute({ nextUrl: new URL(`http://x/api/usage/account?billingAccountId=${theirs.userId}`) }, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.axes.find((a: any) => a.axis === 'file_bytes').used).toBe(0)
  })

  it('the MCP usage read returns the same description, and says who can raise the limit', async () => {
    const { userId, projectId } = await account()
    policy = { mode: 'shadow', spendLimitCents: 5_000 }

    const result = await executeAction({ action: 'GET_USAGE', params: {} }, projectId)

    expect(result.success).toBe(true)
    expect(result.data).toEqual(JSON.parse(JSON.stringify(await describeAccountUsage(userId))))
    expect(result.message).toMatch(/Overage mode: shadow\. Spend limit: \$50\.00/)
    expect(result.message).toMatch(/Only the account owner can raise the spend limit/)
  })

  it('offers an agent no way to change the spend limit or turn overage on', () => {
    const writes = /spend|overage|billing|payment|invoice|subscri|charge|credit/
    const mcp: string[] = buildDispatchable().map((t: any) => t.name)
    const brain: string[] = BRAIN_TOOLS.map((t: any) => t.name ?? t.function?.name).filter(Boolean)
    expect(mcp.filter((n) => writes.test(n))).toEqual([])
    expect(brain.filter((n) => writes.test(n))).toEqual([])
  })
})
