/**
 * PURCHASED CREDITS EXTEND THE AI CREDIT CAP
 * ==========================================
 *
 * Credits bought outright reach the public policy layer through the
 * `@cloud/entitlements` seam (`purchasedCredits`), exactly as granted bonus
 * credits do. enforceAiCredits must count them, or an account that paid for
 * credits would be refused the moment its plan allowance ran out.
 *
 * The seam is replaced here because it IS the Cloud provider's answer; the
 * month's usage is read from a real `account_ai_usage` row in Postgres, keyed
 * by the billing account (here the user's own, as with no organization).
 */

let mockBonus = 0
let mockPurchased = 0
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return {
    ...actual,
    cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER', monthlyAiCredits: 100 }),
    bonusCredits: async () => mockBonus,
    purchasedCredits: async () => mockPurchased,
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { enforceAiCredits, thisMonth, TOKENS_PER_CREDIT } from '@/lib/entitlements/policy'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
let userId: string

async function useCredits(credits: number): Promise<void> {
  const tokenCount = credits * TOKENS_PER_CREDIT
  await prisma.accountAiUsage.upsert({
    where: { billingAccountId_date: { billingAccountId: userId, date: thisMonth() } },
    create: { billingAccountId: userId, date: thisMonth(), tokenCount },
    update: { tokenCount },
  })
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  const user = await prisma.user.create({
    data: {
      email: `purchased-credits-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Purchased Credits Suite',
    },
    select: { id: true },
  })
  userId = user.id
}, 60_000)

afterAll(async () => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: userId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

beforeEach(() => {
  mockBonus = 0
  mockPurchased = 0
})

it('refuses at the plan allowance when nothing was bought (the control)', async () => {
  await useCredits(100)
  const result = await enforceAiCredits(userId)
  expect(result).not.toBe(true)
})

it('lets usage past the plan allowance through while purchased credits remain', async () => {
  mockPurchased = 50
  await useCredits(120)
  expect(await enforceAiCredits(userId)).toBe(true)
})

it('stacks purchased credits on top of bonus credits', async () => {
  mockBonus = 30
  mockPurchased = 50
  await useCredits(170)
  expect(await enforceAiCredits(userId)).toBe(true)
})

it('refuses once plan + bonus + purchased are spent, and names each part', async () => {
  mockBonus = 30
  mockPurchased = 50
  await useCredits(180)
  const result = await enforceAiCredits(userId)
  expect(result).not.toBe(true)
  const message = JSON.stringify(result)
  expect(message).toContain('180 AI credits')
  expect(message).toContain('100 plan + 30 bonus + 50 purchased')
})
