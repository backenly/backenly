/**
 * The quota kernel reads entitlements, and the numbers it enforces are the
 * numbers it was given.
 *
 * The kernel is the enforcement surface for MAU, realtime connections and
 * storage, and the counter for API requests. Until Phase 6 it read Plan rows through
 * getUserSubscription from @/lib/billing. Rerouting it through the Entitlements
 * seam touched every call site in the file, and the file had no direct
 * coverage, so "behaviour preserving" was a claim with nothing behind it.
 *
 * These tests pin the decisions rather than the plumbing: a given set of limits
 * must produce the same allow/block outcome it produced before, and
 * maxMonthlyActiveUsers, which the kernel used to read straight off `Plan`,
 * must still drive the behaviour that depends on it. API requests are the
 * exception: they are unlimited on every plan, so no entitlement may cap them.
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
  trackApiRequest,
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

describe('API requests', () => {
  it('counts against the current month and never consults entitlements', async () => {
    // Free used to be metered against a lifetime total of 100,000 and refused
    // with a 429 past it. API requests are now unlimited on every plan, so a
    // cap on the Plan row, lifetime or monthly, must not reach this path.
    mockGetUserEntitlements.mockResolvedValue(
      entitlements({ planName: 'SANDBOX', maxApiRequestsPerMonth: BigInt(10), apiQuotaIsLifetime: true }),
    )
    mockPrisma.userAiUsage.upsert.mockResolvedValue({ userId: 'user-1' })

    expect(trackApiRequest('user-1')).toBeUndefined()

    const month = new Date().toISOString().slice(0, 7)
    expect(mockPrisma.userAiUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_date: { userId: 'user-1', date: month } },
        update: { apiRequestCount: { increment: 1 } },
      }),
    )
    expect(mockGetUserEntitlements).not.toHaveBeenCalled()
  })

  it('swallows a failed counter write', async () => {
    // The request has already been let through; a lost count must not
    // surface as an unhandled rejection.
    mockPrisma.userAiUsage.upsert.mockRejectedValue(new Error('database unavailable'))

    expect(() => trackApiRequest('user-1')).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
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

    await expect(canAcceptNewEndUser('project-1')).resolves.toMatchObject({ allowed: true })
  })
})
