/**
 * THE FREE PLAN MUST BE RESOLVABLE, OR THE FAILURE MUST BE LOUD
 * =============================================================
 * Downgrade code looked up the plan named FREE. prisma/seed-billing.ts creates
 * SANDBOX, BUILDER and SCALE — it has never created FREE. So on a normally
 * seeded install every downgrade path resolved null.
 *
 * The consequences were all silent, and all in the direction that costs money:
 *
 *   • processExpiredGracePeriods logged "FREE plan not found" and `continue`d
 *     each row, returned 0, and the cron only logs when the count is non-zero.
 *     A lapsed payer kept their paid plan forever and nothing said so.
 *   • admin `uncomp` skipped the subscription update behind an `&& free` guard
 *     but still set user.tier, wrote a success audit row and returned success.
 *
 * FREE is not dead, which is why the fallback exists rather than a rename:
 * scripts/add-billing-minimal.sql creates it, so older self-hosted installs are
 * genuinely on that name and must keep working.
 *
 * These tests use a mocked Prisma on purpose. Proving the FREE-only fallback
 * against a real database would mean deleting the shared SANDBOX plan row,
 * which every other suite running against the same database depends on.
 */

const mockPlanFindUnique = jest.fn()
const mockSubscriptionFindMany = jest.fn()
const mockSubscriptionFindUnique = jest.fn()
const mockSubscriptionUpdate = jest.fn()
const mockAuditCreate = jest.fn()

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    plan: { findUnique: (...a: any[]) => mockPlanFindUnique(...a) },
    subscription: {
      findMany: (...a: any[]) => mockSubscriptionFindMany(...a),
      findUnique: (...a: any[]) => mockSubscriptionFindUnique(...a),
      update: (...a: any[]) => mockSubscriptionUpdate(...a),
    },
    auditLog: { create: (...a: any[]) => mockAuditCreate(...a) },
  },
}))

const { resolveFreePlan } = require('@/lib/billing')
const { processExpiredGracePeriods, runDailyGraceCheck } = require('@/lib/billing/grace')

const SANDBOX_PLAN = { id: 'plan-sandbox', name: 'SANDBOX', maxProjects: 1 }
const LEGACY_FREE_PLAN = { id: 'plan-free', name: 'FREE', maxProjects: 1 }

/** Drive plan.findUnique from a name -> row map, so absence is explicit. */
function seedPlans(byName: Record<string, any>) {
  mockPlanFindUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(byName[where.name] ?? null),
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAuditCreate.mockResolvedValue({})
  mockSubscriptionUpdate.mockResolvedValue({})
  mockSubscriptionFindMany.mockResolvedValue([])
})

describe('resolveFreePlan', () => {
  it('prefers SANDBOX when both names exist', async () => {
    seedPlans({ SANDBOX: SANDBOX_PLAN, FREE: LEGACY_FREE_PLAN })

    await expect(resolveFreePlan()).resolves.toMatchObject({ name: 'SANDBOX' })
  })

  it('falls back to legacy FREE for older self-hosted installs', async () => {
    seedPlans({ FREE: LEGACY_FREE_PLAN })

    await expect(resolveFreePlan()).resolves.toMatchObject({ name: 'FREE' })
  })

  it('throws with an actionable message when neither exists', async () => {
    seedPlans({})

    // Must not resolve to null/undefined: every caller is creating or
    // downgrading a subscription and has nothing to point at without a plan.
    await expect(resolveFreePlan()).rejects.toThrow(/SANDBOX/)
    await expect(resolveFreePlan()).rejects.toThrow(/seed-billing/)
  })
})

describe('expired payment grace downgrades through the resolver', () => {
  const expiredRow = { id: 'sub-1', userId: 'user-1' }
  const expiredFull = {
    id: 'sub-1',
    userId: 'user-1',
    planId: 'plan-builder',
    status: 'GRACE',
    graceUntil: new Date(Date.now() - 86_400_000),
    cancelScheduledAt: null,
    plan: { name: 'BUILDER' },
  }

  it('downgrades onto SANDBOX on a seeded install', async () => {
    seedPlans({ SANDBOX: SANDBOX_PLAN, FREE: LEGACY_FREE_PLAN })
    mockSubscriptionFindMany.mockResolvedValue([expiredRow])
    mockSubscriptionFindUnique.mockResolvedValue(expiredFull)

    const processed = await processExpiredGracePeriods()

    expect(processed).toBe(1)
    expect(mockSubscriptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planId: 'plan-sandbox', status: 'FREE' }),
      }),
    )
  })

  it('downgrades onto legacy FREE when that is the only free plan', async () => {
    seedPlans({ FREE: LEGACY_FREE_PLAN })
    mockSubscriptionFindMany.mockResolvedValue([expiredRow])
    mockSubscriptionFindUnique.mockResolvedValue(expiredFull)

    const processed = await processExpiredGracePeriods()

    expect(processed).toBe(1)
    expect(mockSubscriptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planId: 'plan-free', status: 'FREE' }),
      }),
    )
  })

  it('resolves the plan once for the whole batch, not once per row', async () => {
    seedPlans({ SANDBOX: SANDBOX_PLAN })
    mockSubscriptionFindMany.mockResolvedValue([
      { id: 'sub-1', userId: 'user-1' },
      { id: 'sub-2', userId: 'user-2' },
      { id: 'sub-3', userId: 'user-3' },
    ])
    mockSubscriptionFindUnique.mockImplementation(({ where }: any) =>
      Promise.resolve({ ...expiredFull, id: where.id }),
    )

    await processExpiredGracePeriods()

    expect(mockPlanFindUnique).toHaveBeenCalledTimes(1)
  })

  it('fails loudly and writes nothing when no free plan exists', async () => {
    seedPlans({})
    mockSubscriptionFindMany.mockResolvedValue([expiredRow])
    mockSubscriptionFindUnique.mockResolvedValue(expiredFull)

    // The old code swallowed this per row and reported success.
    await expect(processExpiredGracePeriods()).rejects.toThrow(/SANDBOX/)
    expect(mockSubscriptionUpdate).not.toHaveBeenCalled()
  })

  it('surfaces that failure through the cron wrapper instead of reporting success', async () => {
    seedPlans({})
    mockSubscriptionFindMany.mockResolvedValue([expiredRow])
    mockSubscriptionFindUnique.mockResolvedValue(expiredFull)

    const result = await runDailyGraceCheck()

    // "processed 0, errors 0" was indistinguishable from a healthy quiet day.
    expect(result).toEqual({ processed: 0, errors: 1 })
  })

  it('does not resolve a plan at all when nothing has expired', async () => {
    seedPlans({ SANDBOX: SANDBOX_PLAN })
    mockSubscriptionFindMany.mockResolvedValue([])

    await expect(processExpiredGracePeriods()).resolves.toBe(0)
    expect(mockPlanFindUnique).not.toHaveBeenCalled()
  })

  it('only ever selects GRACE rows whose deadline has passed', async () => {
    seedPlans({ SANDBOX: SANDBOX_PLAN })
    mockSubscriptionFindMany.mockResolvedValue([])

    await processExpiredGracePeriods()

    // An ACTIVE subscription with a scheduled cancellation must never be swept
    // up by the payment-recovery cron.
    const where = mockSubscriptionFindMany.mock.calls[0][0].where
    expect(where.status).toBe('GRACE')
    expect(where.graceUntil).toHaveProperty('lt')
  })
})
