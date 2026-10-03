/**
 * The sandbox lifecycle primitive performs a decision it did not make.
 *
 * REGRESSION. upgradeSandboxToProduction used to call getUserSubscription and
 * refuse with NO_SUBSCRIPTION. That was a duplicate of the enforceDeployment
 * call twelve lines above it in the deploy route, and on a self-hosted install
 * it was the SECOND reason deploying failed: the entitlements seam allowed the
 * deploy, and then this refused it with "No active subscription. Upgrade to Pro
 * to deploy." Fixing the enforcement family in the previous commit did not fix
 * the deploy path, because the commercial check had been copied into the
 * lifecycle function as well.
 *
 * Removing a gate is only safe if the caller really does gate, so that ordering
 * is pinned here rather than assumed, and a second ungated caller fails the
 * suite.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

const mockPrisma = {
  project: { findUnique: jest.fn(), update: jest.fn() },
  subscription: { findFirst: jest.fn() },
  plan: { findUnique: jest.fn() },
}
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: {
      findUnique: (...a: unknown[]) => mockPrisma.project.findUnique(...a),
      update: (...a: unknown[]) => mockPrisma.project.update(...a),
    },
    subscription: { findFirst: (...a: unknown[]) => mockPrisma.subscription.findFirst(...a) },
    plan: { findUnique: (...a: unknown[]) => mockPrisma.plan.findUnique(...a) },
  },
}))

const mockCanWriteProject = jest.fn()
jest.mock('@/lib/edition/guard', () => ({
  canWriteProject: (...a: unknown[]) => mockCanWriteProject(...a),
}))

import { getSandboxStatus, promoteSandboxToProduction } from '@/lib/projects/sandbox-lifecycle'

beforeEach(() => {
  jest.clearAllMocks()
  mockCanWriteProject.mockResolvedValue(true)
  mockPrisma.subscription.findFirst.mockResolvedValue(null)
  mockPrisma.plan.findUnique.mockResolvedValue(null)
})

describe('promoteSandboxToProduction', () => {
  it('promotes a sandbox with no Subscription row anywhere in sight', async () => {
    // This is the self-host case. Before the split it returned NO_SUBSCRIPTION.
    mockPrisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      expiresAt: new Date(Date.now() + 86_400_000),
      isDeployed: false,
    })
    mockPrisma.project.update.mockResolvedValue({})

    await expect(promoteSandboxToProduction('p1', 'operator')).resolves.toEqual({ success: true })
  })

  it('never consults a Subscription or a Plan', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: 'p1', expiresAt: null, isDeployed: false })
    mockPrisma.project.update.mockResolvedValue({})

    await promoteSandboxToProduction('p1', 'operator')

    expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.plan.findUnique).not.toHaveBeenCalled()
  })

  it('clears the expiry and marks the project deployed', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({
      id: 'p1',
      expiresAt: new Date(Date.now() + 86_400_000),
      isDeployed: false,
    })
    mockPrisma.project.update.mockResolvedValue({})

    await promoteSandboxToProduction('p1', 'operator')

    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ expiresAt: null, isDeployed: true, environment: 'production' }),
      }),
    )
  })

  it('still refuses a caller who may not write the project', async () => {
    // Authorization is NOT delegated to the caller. Only the commercial check
    // was removed; a library performing a privileged action still asks.
    mockCanWriteProject.mockResolvedValue(false)

    await expect(promoteSandboxToProduction('p1', 'stranger')).resolves.toMatchObject({
      success: false,
      errorCode: 'PROJECT_NOT_FOUND',
    })
    expect(mockPrisma.project.update).not.toHaveBeenCalled()
  })

  it('refuses a project that is already in production', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: 'p1', expiresAt: null, isDeployed: true })

    await expect(promoteSandboxToProduction('p1', 'operator')).resolves.toMatchObject({
      success: false,
      errorCode: 'ALREADY_PRODUCTION',
    })
    expect(mockPrisma.project.update).not.toHaveBeenCalled()
  })
})

describe('getSandboxStatus', () => {
  it('reports a project with no expiry as production', async () => {
    // The single-tenant case: bootstrap never sets expiresAt.
    expect(getSandboxStatus({ expiresAt: null })).toMatchObject({
      isSandbox: false,
      isExpired: false,
      countdownMessage: 'Production — never expires',
    })
  })

  it('reports an elapsed expiry as expired', () => {
    expect(getSandboxStatus({ expiresAt: new Date(Date.now() - 1000) })).toMatchObject({
      isSandbox: true,
      isExpired: true,
      daysRemaining: 0,
    })
  })

  it('counts down whole days remaining', () => {
    const threeDays = new Date(Date.now() + 3 * 86_400_000 + 60_000)
    expect(getSandboxStatus({ expiresAt: threeDays })).toMatchObject({
      isSandbox: true,
      isExpired: false,
      daysRemaining: 3,
    })
  })
})

describe('the deploy route gates before it promotes', () => {
  const ROUTE = 'app/api/project/deploy/route.ts'

  it('calls enforceDeployment before promoteSandboxToProduction', () => {
    const src = fs.readFileSync(path.join(ROOT, ROUTE), 'utf8')

    const gate = src.indexOf('enforceDeployment(')
    const promote = src.indexOf('promoteSandboxToProduction(')

    expect(gate).toBeGreaterThan(-1)
    expect(promote).toBeGreaterThan(-1)
    // Ordering is the whole safety argument for removing the inner check.
    expect(gate).toBeLessThan(promote)
  })

  it('has no other caller of the promotion primitive', () => {
    // A caller that skipped enforceDeployment would deploy on a plan that does
    // not allow it. The primitive cannot catch that any more, so the tree must.
    //
    // Matches the call form, not the bare name, so the "moved to" note left
    // behind in lib/billing/sandbox.ts is not mistaken for a caller.
    const { execSync } = require('child_process') as typeof import('child_process')
    const hits = execSync(
      'git grep -l "promoteSandboxToProduction(" -- app lib server scripts',
      { cwd: ROOT, encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((p) => p.split('\\').join('/'))
      .filter((p) => p !== 'lib/projects/sandbox-lifecycle.ts') // the definition

    expect(hits).toEqual(['app/api/project/deploy/route.ts'])
  })
})
