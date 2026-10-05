/**
 * The quota kernel reads entitlements, and the numbers it enforces are the
 * numbers it was given.
 *
 * The kernel is the enforcement surface for MAU, realtime connections and
 * storage, and until Phase 6 it read Plan rows through getUserSubscription from
 * @/lib/billing. Rerouting it through the Entitlements seam touched every call
 * site in the file, and the file had no direct coverage, so "behaviour
 * preserving" was a claim with nothing behind it.
 *
 * These tests pin the decisions rather than the plumbing: a given set of limits
 * must produce the same allow/block outcome it produced before, and the field
 * the kernel used to read straight off `Plan` (maxMonthlyActiveUsers) must
 * still drive the behaviour that depends on it.
 *
 * API requests are not here at all: they are unlimited on every plan, so the
 * kernel has nothing to enforce for them.
 */
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'
import type { UserEntitlements } from '@/lib/entitlements/types'

const mockPrisma = {
  projectActiveUser: { count: jest.fn() },
  project: { findUnique: jest.fn() },
  projectStorageUsage: { findFirst: jest.fn() },
}
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
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

import * as kernel from '@/lib/quota/kernel'
import { canAcceptNewEndUser, getRealtimeConnectionLimit } from '@/lib/quota/kernel'

/** A paid-shaped plan, expressed as entitlements. */
function entitlements(over: Partial<UserEntitlements> = {}): UserEntitlements {
  return { ...selfHostedEntitlements(), planName: 'PRO', ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.project.findUnique.mockResolvedValue({ userId: 'owner-1' })
})

describe('API requests', () => {
  it('have no gate, because no plan caps them', () => {
    // Free used to be refused past 100,000 requests in total. The count the
    // Usage page shows is kept by lib/traffic/request-recorder.ts.
    expect(Object.keys(kernel).filter((name) => /apiRequest/i.test(name))).toEqual([])
  })
})

describe('monthly active users', () => {
  it('fails open when there are no entitlements', async () => {
    // A billing hiccup must never stop a customer's end users signing up.
    mockGetUserEntitlements.mockResolvedValue(null)

    await expect(canAcceptNewEndUser('project-1')).resolves.toMatchObject({ allowed: true })
    expect(mockPrisma.projectActiveUser.count).not.toHaveBeenCalled()
  })

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
