/**
 * A self-hosted install may deploy, add a domain and create a trigger.
 *
 * REGRESSION. Before the enforcement family moved to the Entitlements seam it
 * called getUserSubscription directly, so on a single-tenant database with no
 * Subscription row every helper took the `!sub` branch and returned
 *
 *   PLAN_LIMIT_EXCEEDED  "No active subscription found"
 *
 * while selfHostedEntitlements() reported allowDeployment, allowWebhooks and
 * allowCustomDomain as true. Measured on a fresh single-tenant database, all
 * three of the helpers below blocked. A self-hoster could not deploy their own
 * backend, and the message told them to buy a plan.
 *
 * The invariant these tests hold down is not "deployment is allowed" but the
 * reason it is allowed: single-tenant enforcement must derive its answer from
 * the edition, and must never reach the Plan or Subscription tables to do it.
 * That is why the Prisma mock asserts on calls rather than returning fixtures.
 */
const mockPrisma = {
  subscription: { findFirst: jest.fn() },
  plan: { findUnique: jest.fn(), findMany: jest.fn() },
  userAiUsage: { findUnique: jest.fn(), upsert: jest.fn() },
}
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    subscription: { findFirst: (...a: unknown[]) => mockPrisma.subscription.findFirst(...a) },
    plan: {
      findUnique: (...a: unknown[]) => mockPrisma.plan.findUnique(...a),
      findMany: (...a: unknown[]) => mockPrisma.plan.findMany(...a),
    },
    userAiUsage: {
      findUnique: (...a: unknown[]) => mockPrisma.userAiUsage.findUnique(...a),
      upsert: (...a: unknown[]) => mockPrisma.userAiUsage.upsert(...a),
    },
  },
}))

import {
  enforceCustomDomain,
  enforceDeployment,
  enforceProjectCreation,
  enforceTriggerCreation,
  enforceWebhook,
} from '@/lib/entitlements/policy'
import { initializeAccountEntitlements } from '@/lib/entitlements'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

beforeEach(() => {
  jest.clearAllMocks()
  process.env.BACKENLY_EDITION = 'single-tenant'
  // A fresh self-host database: no Plan row and no Subscription row. Anything
  // that reaches for one gets nothing, exactly as it would in production.
  mockPrisma.subscription.findFirst.mockResolvedValue(null)
  mockPrisma.plan.findUnique.mockResolvedValue(null)
})

afterEach(() => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe('single-tenant with no Subscription row', () => {
  it('allows deployment', async () => {
    await expect(enforceDeployment('operator')).resolves.toBe(true)
  })

  it('allows a custom domain', async () => {
    await expect(enforceCustomDomain('operator')).resolves.toBe(true)
  })

  it('allows trigger creation', async () => {
    await expect(enforceTriggerCreation('operator', 'project-1', 0)).resolves.toBe(true)
  })

  it('allows webhooks', async () => {
    await expect(enforceWebhook('operator')).resolves.toBe(true)
  })

  it('allows the first project and refuses the second', async () => {
    // One deployment is one project, so the cap is the edition speaking rather
    // than a plan withholding something.
    await expect(enforceProjectCreation('operator', 0)).resolves.toBe(true)

    const second = await enforceProjectCreation('operator', 1)
    expect(second).not.toBe(true)
    expect(second).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' })
  })

  it('never reads a Subscription or a Plan row to decide any of it', async () => {
    // This is the mutation guard. Pointing any of these helpers back at
    // getUserSubscription would still return `true` for a seeded Cloud database,
    // so asserting only on the decision would not catch the regression. The
    // absence of the read is the property that actually distinguishes them.
    await Promise.all([
      enforceDeployment('operator'),
      enforceCustomDomain('operator'),
      enforceTriggerCreation('operator', 'project-1', 0),
      enforceWebhook('operator'),
      enforceProjectCreation('operator', 0),
    ])

    expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.plan.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.plan.findMany).not.toHaveBeenCalled()
  })

  it('creates no Subscription row when an account is initialized', async () => {
    // Signup calls this. In single-tenant it must do nothing at all, or the
    // self-host install grows the very billing rows it exists without.
    await initializeAccountEntitlements('operator')

    expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.plan.findUnique).not.toHaveBeenCalled()
  })
})

describe('cloud with no Subscription row', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('still blocks, because that is a real unsubscribed account', async () => {
    // The self-host fix must not become a free pass in Cloud. Same absent row,
    // opposite and correct answer.
    const decision = await enforceDeployment('someone')

    expect(decision).not.toBe(true)
    expect(decision).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      currentPlan: 'NONE',
      message: 'No active subscription found',
    })
    expect(mockPrisma.subscription.findFirst).toHaveBeenCalled()
  })
})
