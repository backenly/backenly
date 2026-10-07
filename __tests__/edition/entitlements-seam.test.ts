/**
 * The Entitlements seam: what the product may ask, and what it may not reach.
 *
 * lib/quota/kernel.ts used to import getUserSubscription from @/lib/billing, so
 * every metered limit in the public product depended on Backenly's commercial
 * implementation. That is the edge Phase 6 severs. These tests pin the two
 * properties that make the severing real rather than cosmetic:
 *
 *   1. single-tenant resolves entitlements WITHOUT any database read, so a
 *      self-host install needs no Plan row and no Subscription row;
 *   2. cloud delegates to the @cloud/* provider, which resolves overlay-first,
 *      so the private overlay can replace it without touching public source.
 *
 * Entitlements belong to a billing account (lib/usage/account.ts): on Cloud an
 * organization, so a person's own entitlements are their own account's, which
 * only the provider can name.
 *
 * The alias assertions exist because the whole mechanism is a build-time
 * resolution order. Reversing the two entries in `paths` would silently make
 * the public fallback win inside composed Cloud, and nothing else in the suite
 * would notice.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

const mockPrisma = {
  subscription: { findFirst: jest.fn() },
  plan: { findUnique: jest.fn() },
}
// The factory is hoisted above the const, so it must not touch mockPrisma at
// factory time. Forwarding through arrow functions defers the reference to
// call time, which is what lets an unexpected read fail as an assertion
// rather than as a TDZ error during module load.
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    subscription: { findFirst: (...a: unknown[]) => mockPrisma.subscription.findFirst(...a) },
    plan: { findUnique: (...a: unknown[]) => mockPrisma.plan.findUnique(...a) },
  },
}))

const mockCloudEntitlements = jest.fn()
const mockAccountOfUser = jest.fn()
const mockAccountForCaller = jest.fn()
jest.mock('@cloud/entitlements', () => ({
  cloudEntitlements: (...a: unknown[]) => mockCloudEntitlements(...a),
  accountOfUser: (...a: unknown[]) => mockAccountOfUser(...a),
  accountForCaller: (...a: unknown[]) => mockAccountForCaller(...a),
}))

import {
  accountForCaller,
  accountOfUser,
  getAccountEntitlements,
  getUserEntitlements,
  selfHostedEntitlements,
} from '@/lib/entitlements'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

afterEach(() => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  jest.clearAllMocks()
})

describe('single-tenant entitlements', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('never reads a Subscription or a Plan row', async () => {
    const ent = await getUserEntitlements('any-user')

    expect(ent).not.toBeNull()
    expect(ent!.planName).toBe('SELF_HOSTED')
    // The point of the edition, not an optimisation: resolveFreePlan() throws
    // on an unseeded database, so any read here would break a fresh install.
    expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.plan.findUnique).not.toHaveBeenCalled()
  })

  it('does not consult the Cloud provider at all', async () => {
    await getUserEntitlements('any-user')
    expect(mockCloudEntitlements).not.toHaveBeenCalled()
  })

  it('reports every metered limit as unlimited', async () => {
    const ent = (await getUserEntitlements('any-user'))!

    // null means UNLIMITED throughout the seam. Zero would mean "blocked", and
    // a number would mean "metered", so this is the assertion that keeps a
    // self-hoster's own hardware from being capped.
    expect(ent.maxPostgresStorageMb).toBeNull()
    expect(ent.maxFileStorageMb).toBeNull()
    expect(ent.maxRealtimeConnections).toBeNull()
    expect(ent.maxMonthlyActiveUsers).toBeNull()
    expect(ent.maxAiFunctionInvocationsPerMonth).toBeNull()
    expect(ent.maxTriggersPerProject).toBeNull()
  })

  it('caps projects at one, because that is the edition', async () => {
    const ent = (await getUserEntitlements('any-user'))!
    expect(ent.maxProjects).toBe(1)
  })

  it('has no organizations: a person is their own account, and the only one they can read', async () => {
    await expect(accountOfUser('user-1')).resolves.toBe('user-1')
    await expect(accountForCaller('user-1')).resolves.toBe('user-1')
    await expect(accountForCaller('user-1', 'user-1')).resolves.toBe('user-1')
    await expect(accountForCaller('user-1', 'someone-else')).resolves.toBeNull()
    expect(mockAccountOfUser).not.toHaveBeenCalled()
    expect(mockAccountForCaller).not.toHaveBeenCalled()
  })
})

describe('cloud entitlements', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('delegates to the @cloud provider', async () => {
    mockCloudEntitlements.mockResolvedValue({ ...selfHostedEntitlements(), planName: 'PRO' })

    const ent = await getAccountEntitlements('org-1')

    expect(mockCloudEntitlements).toHaveBeenCalledWith('org-1')
    expect(ent!.planName).toBe('PRO')
  })

  it("answers a person's own entitlements from the account the provider names for them", async () => {
    mockAccountOfUser.mockResolvedValue('org-of-user-1')
    mockCloudEntitlements.mockResolvedValue({ ...selfHostedEntitlements(), planName: 'PRO' })

    const ent = await getUserEntitlements('user-1')

    expect(mockAccountOfUser).toHaveBeenCalledWith('user-1')
    expect(mockCloudEntitlements).toHaveBeenCalledWith('org-of-user-1')
    expect(ent!.planName).toBe('PRO')
  })

  it('lets the provider decide which account a caller may read', async () => {
    mockAccountForCaller.mockResolvedValueOnce('org-1').mockResolvedValueOnce(null)

    await expect(accountForCaller('user-1', 'org-1')).resolves.toBe('org-1')
    await expect(accountForCaller('user-1', 'org-2')).resolves.toBeNull()
    expect(mockAccountForCaller).toHaveBeenNthCalledWith(1, 'user-1', 'org-1')
    expect(mockAccountForCaller).toHaveBeenNthCalledWith(2, 'user-1', 'org-2')
  })

  it('passes a missing subscription through as null rather than unlimited', async () => {
    // null is "no active subscription", which callers already treat as a block.
    // Substituting self-hosted entitlements here would hand every unsubscribed
    // Cloud account an uncapped platform.
    mockCloudEntitlements.mockResolvedValue(null)

    await expect(getAccountEntitlements('org-2')).resolves.toBeNull()
  })
})

describe('@cloud alias resolution order', () => {
  const OVERLAY_FIRST = 'lib/cloud'
  const OSS_SECOND = 'lib/edition/oss'

  it.each(['tsconfig.json', 'tsconfig.server.json'])('%s prefers the overlay', (file) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, ''))
    const entries: string[] = cfg.compilerOptions.paths['@cloud/*']

    expect(entries).toHaveLength(2)
    expect(entries[0]).toContain(OVERLAY_FIRST)
    expect(entries[1]).toContain(OSS_SECOND)
  })

  it('jest maps @cloud the same way the compilers do', () => {
    // Asserted on the source rather than the resolved object: next/jest exports
    // an async factory that dynamic-imports next.config, which a jest worker
    // cannot evaluate without --experimental-vm-modules. The declared order is
    // the thing worth protecting anyway.
    const src = fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8')
    const mapping = /\^@cloud\/\(\.\*\)\$'\]?\s*:\s*\[([^\]]+)\]/.exec(src)

    expect(mapping).not.toBeNull()
    const overlayAt = mapping![1].indexOf(OVERLAY_FIRST)
    const ossAt = mapping![1].indexOf(OSS_SECOND)
    expect(overlayAt).toBeGreaterThan(-1)
    expect(ossAt).toBeGreaterThan(-1)
    expect(overlayAt).toBeLessThan(ossAt)
  })
})

describe('public product does not reach into billing', () => {
  it('lib/quota/kernel.ts imports the seam, not the implementation', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/quota/kernel.ts'), 'utf8')

    // Restoring the old import is the mutation this guards: it compiles, it
    // passes every quota test, and it silently re-couples the public product to
    // a module that is leaving the repository.
    expect(src).not.toMatch(/from '@\/lib\/billing/)
    expect(src).toMatch(/from '@\/lib\/entitlements'/)
  })
})
