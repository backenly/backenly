/**
 * The quota kernel reads entitlements, and the numbers it enforces are the
 * numbers it was given.
 *
 * The kernel is the enforcement surface for API requests, MAU, realtime
 * connections and storage, and until Phase 6 it read Plan rows through
 * getUserSubscription from @/lib/billing. Rerouting it through the Entitlements
 * seam touched every call site in the file, and the file had no direct
 * coverage, so "behaviour preserving" was a claim with nothing behind it.
 *
 * These tests pin the decisions rather than the plumbing: a given set of limits
 * must produce the same allow/block outcome it produced before, and the two
 * fields the kernel used to read straight off `Plan` (apiQuotaIsLifetime and
 * maxMonthlyActiveUsers) must still drive the behaviour that depends on them.
 */
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import type { UserEntitlements } from '@/lib/entitlements/types'

const mockPrisma = {
  userAiUsage: { upsert: jest.fn() },
  projectActiveUser: { count: jest.fn() },
  project: { findUnique: jest.fn() },
  projectStorageUsage: { findFirst: jest.fn() },
}
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    userAiUsage: { upsert: (...a: unknown[]) => mockPrisma.userAiUsage.upsert(...a) },
    projectActiveUser: { count: (...a: unknown[]) => mockPrisma.projectActiveUser.count(...a) },
    project: { findUnique: (...a: unknown[]) => mockPrisma.project.findUnique(...a) },
    projectStorageUsage: { findFirst: (...a: unknown[]) => mockPrisma.projectStorageUsage.findFirst(...a) },
  },
}))

const mockGetUserEntitlements = jest.fn()
jest.mock('@/lib/entitlements', () => ({
  getUserEntitlements: (...a: unknown[]) => mockGetUserEntitlements(...a),
}))

jest.mock('@/lib/notifications/platform', () => ({ createPlatformNotification: jest.fn() }))

import {
  enforceAndTrackApiRequest,
  canAcceptNewEndUser,
  getRealtimeConnectionLimit,
} from '@/lib/quota/kernel'

/** A paid-shaped plan, expressed as entitlements. */
function entitlements(over: Partial<UserEntitlements> = {}): UserEntitlements {
  return { ...selfHostedEntitlements(), planName: 'PRO', ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.project.findUnique.mockResolvedValue({ userId: 'owner-1' })
})

describe('API request quota', () => {
  it('blocks past the cap and names the plan from entitlements', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxApiRequestsPerMonth: BigInt(10) }))
    mockPrisma.userAiUsage.upsert.mockResolvedValue({ apiRequestCount: BigInt(11) })

    const decision = await enforceAndTrackApiRequest('user-1')

    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe('PLAN_LIMIT_EXCEEDED')
    expect(decision.plan).toBe('PRO')
    expect(decision.max).toBe(10)
  })

  it('allows at the cap, because the block is strictly past it', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxApiRequestsPerMonth: BigInt(10) }))
    mockPrisma.userAiUsage.upsert.mockResolvedValue({ apiRequestCount: BigInt(10) })

    await expect(enforceAndTrackApiRequest('user-1')).resolves.toMatchObject({ allowed: true })
  })

  it('treats a null cap as unlimited and still records usage', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxApiRequestsPerMonth: null }))
    mockPrisma.userAiUsage.upsert.mockResolvedValue({ apiRequestCount: BigInt(999999) })

    await expect(enforceAndTrackApiRequest('user-1')).resolves.toMatchObject({ allowed: true })
    expect(mockPrisma.userAiUsage.upsert).toHaveBeenCalled()
  })

  it('keys the counter on LIFETIME when the quota never resets', async () => {
    // Free is metered as a lifetime total in Cloud. The kernel used to read
    // this flag off the Plan row; it now comes through the seam, and keying the
    // counter on the month instead would silently reset a Free account's
    // lifetime allowance every 1st.
    mockGetUserEntitlements.mockResolvedValue(
      entitlements({ maxApiRequestsPerMonth: BigInt(10), apiQuotaIsLifetime: true }),
    )
    mockPrisma.userAiUsage.upsert.mockResolvedValue({ apiRequestCount: BigInt(1) })

    await enforceAndTrackApiRequest('user-1')

    expect(mockPrisma.userAiUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_date: { userId: 'user-1', date: 'LIFETIME' } } }),
    )
  })

  it('fails open when there are no entitlements', async () => {
    // A billing hiccup must never take down a customer's API.
    mockGetUserEntitlements.mockResolvedValue(null)

    await expect(enforceAndTrackApiRequest('user-1')).resolves.toMatchObject({ allowed: true })
    expect(mockPrisma.userAiUsage.upsert).not.toHaveBeenCalled()
  })
})

describe('monthly active users', () => {
  it('blocks a new end-user at the MAU cap', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxMonthlyActiveUsers: 5 }))
    mockPrisma.projectActiveUser.count.mockResolvedValue(5)

    const decision = await canAcceptNewEndUser('project-1')

    expect(decision.allowed).toBe(false)
    expect(decision.max).toBe(5)
  })

  it('allows below the cap', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxMonthlyActiveUsers: 5 }))
    mockPrisma.projectActiveUser.count.mockResolvedValue(4)

    await expect(canAcceptNewEndUser('project-1')).resolves.toMatchObject({ allowed: true })
  })

  it('never counts when MAU is unlimited', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxMonthlyActiveUsers: null }))

    await expect(canAcceptNewEndUser('project-1')).resolves.toMatchObject({ allowed: true })
    expect(mockPrisma.projectActiveUser.count).not.toHaveBeenCalled()
  })
})

describe('realtime connection limit', () => {
  it('reports the owner, plan and cap from entitlements', async () => {
    mockGetUserEntitlements.mockResolvedValue(entitlements({ maxRealtimeConnections: 25 }))

    await expect(getRealtimeConnectionLimit('project-1')).resolves.toEqual({
      ownerId: 'owner-1',
      planName: 'PRO',
      max: 25,
    })
  })
})

describe('single-tenant', () => {
  it('meters nothing, because self-hosted entitlements cap nothing', async () => {
    // The self-host path used to reach this code with no Subscription row at
    // all, which returned null and fell through to fail-open. It now resolves
    // real entitlements whose caps are null, which reaches the same decision
    // for a stated reason rather than by accident.
    mockGetUserEntitlements.mockResolvedValue(selfHostedEntitlements())
    mockPrisma.userAiUsage.upsert.mockResolvedValue({ apiRequestCount: BigInt(10_000_000) })

    await expect(enforceAndTrackApiRequest('operator')).resolves.toMatchObject({ allowed: true })
    await expect(canAcceptNewEndUser('project-1')).resolves.toMatchObject({ allowed: true })
  })
})
