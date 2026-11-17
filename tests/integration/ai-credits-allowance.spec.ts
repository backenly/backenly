/**
 * The AI credits Usage and MCP show are the ones the credit gate counts: the
 * plan's, plus bonus and bought credits.
 *
 * Production QA re-test, 2026-11-16, #98: the org stood at "575 of 200" and
 * backend_chat still ran. The gate (enforceAiCredits, aiCreditCap) counts
 * bonus and purchased credits; the meters showed the plan's 200 alone, so the
 * page read "over the limit" while the gate correctly allowed the call.
 *
 * The `@cloud/entitlements` seam is replaced because it is the Cloud
 * provider's answer (plan, bonus, purchased); usage is a real account_ai_usage
 * row, and the description, the gate and the MCP summary are the real ones.
 */
let mockPlanCredits: number | null = 200
let mockBonus = 0
let mockPurchased = 0
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return {
    ...actual,
    cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', monthlyAiCredits: mockPlanCredits }),
    bonusCredits: async () => mockBonus,
    purchasedCredits: async () => mockPurchased,
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { enforceAiCredits, thisMonth, TOKENS_PER_CREDIT } from '@/lib/entitlements/policy'
import { invalidateUsageCache } from '@/lib/entitlements/usage-cache'
import { describeAccountUsage } from '@/lib/usage/describe'
import { invalidateAccountLimits } from '@/lib/usage/overage'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
let userId: string
let projectId: string

async function useCredits(credits: number): Promise<void> {
  const tokenCount = credits * TOKENS_PER_CREDIT
  await prisma.accountAiUsage.upsert({
    where: { billingAccountId_date: { billingAccountId: userId, date: thisMonth() } },
    create: { billingAccountId: userId, date: thisMonth(), tokenCount },
    update: { tokenCount },
  })
  invalidateUsageCache(userId)
  invalidateAccountLimits(userId)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  userId = (await prisma.user.create({
    data: { email: `ai-credits-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'AI credits' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'ai-credits', userId }, select: { id: true } })).id
}, 60_000)

afterAll(async () => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: userId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

beforeEach(() => {
  mockPlanCredits = 200
  mockBonus = 0
  mockPurchased = 0
})

it('the usage description carries the allowance the gate counts, and the gate agrees', async () => {
  mockBonus = 500
  await useCredits(575)
  const usage = await describeAccountUsage(userId)
  expect(usage?.aiCredits).toEqual({ used: 575, plan: 200, bonus: 500, purchased: 0, cap: 700, left: 125 })
  expect(await enforceAiCredits(userId)).toBe(true)
}, 60_000)

it('at the allowance nothing is left, and the gate refuses', async () => {
  mockPurchased = 100
  await useCredits(300)
  expect((await describeAccountUsage(userId))?.aiCredits).toEqual({ used: 300, plan: 200, bonus: 0, purchased: 100, cap: 300, left: 0 })
  expect(await enforceAiCredits(userId)).not.toBe(true)
}, 60_000)

it("the MCP usage summary says how many credits are left, and of what", async () => {
  mockBonus = 500
  await useCredits(575)
  const { executeAction } = await import('@/lib/ai/minimal-executor')
  const result = await executeAction({ action: 'GET_USAGE', params: {} } as any, projectId)
  expect(result.success).toBe(true)
  expect(result.message).toContain('- AI credits: 575 used of 700 this month (200 plan + 500 bonus); 125 left')
}, 60_000)

it('CONTROL: a plan without a credit cap has no allowance to show', async () => {
  mockPlanCredits = null
  await useCredits(50)
  expect((await describeAccountUsage(userId))?.aiCredits ?? null).toBeNull()
}, 60_000)
