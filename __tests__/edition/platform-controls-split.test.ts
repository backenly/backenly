/**
 * lib/platform/controls.ts was mixed, and its public half is load-bearing.
 *
 * The module carried Backenly's Cloud admission heuristics next to the Phase 3
 * self-hosted first-operator machinery, the operator kill switches, the
 * deployment's security audit log and per-project lockdown. Moving it private
 * wholesale would have taken all of that away from OSS: a self-host install
 * would have had no way to create its first account.
 *
 * These tests hold the split in place. They assert what a SELF-HOSTED
 * deployment can still do for itself, and that the one genuinely Cloud
 * decision does not run there.
 *
 * The first-operator race and the real-database admission path are covered by
 * __tests__/auth/first-account-claim.test.ts and
 * __tests__/auth/first-operator-admission.test.ts, which run against a real
 * PostgreSQL. This suite covers the rest of the split.
 */
const mockPrisma = {
  user: { count: jest.fn() },
  platformControl: { findUnique: jest.fn() },
  blocklist: { findMany: jest.fn() },
  securityEvent: { create: jest.fn() },
  project: { findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
}
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    user: { count: (...a: unknown[]) => mockPrisma.user.count(...a) },
    platformControl: { findUnique: (...a: unknown[]) => mockPrisma.platformControl.findUnique(...a) },
    blocklist: { findMany: (...a: unknown[]) => mockPrisma.blocklist.findMany(...a) },
    securityEvent: { create: (...a: unknown[]) => mockPrisma.securityEvent.create(...a) },
    project: {
      findUnique: (...a: unknown[]) => mockPrisma.project.findUnique(...a),
      update: (...a: unknown[]) => mockPrisma.project.update(...a),
    },
    auditLog: { create: (...a: unknown[]) => mockPrisma.auditLog.create(...a) },
  },
}))

const mockAssessSignupAdmission = jest.fn()
jest.mock('@/lib/platform-signals', () => ({
  assessSignupAdmission: (...a: unknown[]) => mockAssessSignupAdmission(...a),
}))

import {
  assertAiAllowed,
  assertSignupAllowed,
  assertWritable,
  getPlatformControls,
  invalidateBlocklistCache,
  invalidatePlatformControlsCache,
  isProjectLockedDown,
  recordSecurityEvent,
  setProjectLockdown,
} from '@/lib/platform-controls'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_PUBLIC_SIGNUP = process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP

/** Every switch off, which is what an untouched deployment looks like. */
function controls(over: Record<string, unknown> = {}) {
  return {
    aiFrozen: false,
    signupsDisabled: false,
    maintenanceMode: false,
    readOnly: false,
    note: null,
    updatedAt: new Date(0),
    updatedBy: null,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  invalidatePlatformControlsCache()
  invalidateBlocklistCache()
  mockPrisma.platformControl.findUnique.mockResolvedValue(controls())
  mockPrisma.blocklist.findMany.mockResolvedValue([])
  mockPrisma.securityEvent.create.mockResolvedValue({})
  mockAssessSignupAdmission.mockResolvedValue({ ok: true, reason: '', status: 200 })
})

afterEach(() => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP = ORIGINAL_PUBLIC_SIGNUP
  invalidatePlatformControlsCache()
  invalidateBlocklistCache()
})

describe('kill switches still work in OSS', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('assertAiAllowed refuses when aiFrozen', async () => {
    mockPrisma.platformControl.findUnique.mockResolvedValue(controls({ aiFrozen: true }))
    await expect(assertAiAllowed()).resolves.toMatchObject({ ok: false, status: 503 })
  })

  it('assertAiAllowed allows when nothing is set', async () => {
    await expect(assertAiAllowed()).resolves.toMatchObject({ ok: true })
  })

  it('assertWritable refuses in read-only', async () => {
    mockPrisma.platformControl.findUnique.mockResolvedValue(controls({ readOnly: true }))
    await expect(assertWritable()).resolves.toMatchObject({ ok: false, status: 503 })
  })

  it('assertWritable refuses in maintenance mode', async () => {
    mockPrisma.platformControl.findUnique.mockResolvedValue(controls({ maintenanceMode: true }))
    await expect(assertWritable()).resolves.toMatchObject({ ok: false, status: 503 })
  })

  it('fails open when the control table is unreachable', async () => {
    // A broken control row must not brick a deployment.
    mockPrisma.platformControl.findUnique.mockRejectedValue(new Error('no table'))
    await expect(getPlatformControls(true)).resolves.toMatchObject({ aiFrozen: false, readOnly: false })
  })
})

describe('security events still record in OSS', () => {
  it('writes a real SecurityEvent row', async () => {
    await recordSecurityEvent({ kind: 'login_failed', summary: 'bad password', ip: '10.0.0.1' })

    expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'login_failed', severity: 'info', summary: 'bad password' }),
      }),
    )
  })

  it('never throws when the write fails', async () => {
    // Recording must not break the request it is describing.
    mockPrisma.securityEvent.create.mockRejectedValue(new Error('db down'))
    await expect(recordSecurityEvent({ kind: 'x', summary: 'y' })).resolves.toBeUndefined()
  })
})

describe('project lockdown still works in OSS', () => {
  it('sets the lockdown columns and records it', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: 'p1', name: 'demo', userId: 'u1' })
    mockPrisma.project.update.mockResolvedValue({})
    mockPrisma.auditLog.create.mockResolvedValue({})

    await setProjectLockdown('p1', true, 'abuse', { userId: 'admin', userEmail: 'a@b.c' })

    expect(mockPrisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ lockedDownReason: 'abuse' }),
      }),
    )
    expect(mockPrisma.securityEvent.create).toHaveBeenCalled()
  })

  it('reports a locked project as locked', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ lockedDownAt: new Date() })
    await expect(isProjectLockedDown('p1')).resolves.toBe(true)
  })
})

describe('signup admission: what a deployment decides for itself', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP = ''
  })

  it('admits the first self-hosted operator', async () => {
    mockPrisma.user.count.mockResolvedValue(0)
    await expect(assertSignupAllowed('operator@acceptance.test', '1.2.3.4')).resolves.toMatchObject({ ok: true })
  })

  it('closes registration after the first account', async () => {
    mockPrisma.user.count.mockResolvedValue(1)

    const guard = await assertSignupAllowed('second@example.com', null)

    expect(guard.ok).toBe(false)
    expect(guard.status).toBe(403)
    expect(guard.reason).toMatch(/BACKENLY_ALLOW_PUBLIC_SIGNUP/)
  })

  it('reopens registration when the operator asks for it', async () => {
    process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP = 'true'
    mockPrisma.user.count.mockResolvedValue(5)

    await expect(assertSignupAllowed('someone@example.com', null)).resolves.toMatchObject({ ok: true })
  })

  it('honours signupsDisabled', async () => {
    mockPrisma.user.count.mockResolvedValue(0)
    mockPrisma.platformControl.findUnique.mockResolvedValue(controls({ signupsDisabled: true }))

    await expect(assertSignupAllowed('operator@example.com', null)).resolves.toMatchObject({
      ok: false,
      status: 503,
    })
  })

  it('honours the operator blocklist, even for the first operator', async () => {
    // A hand-added entry is an explicit decision. The self-host branch skips
    // the SCORING, not the list somebody wrote.
    mockPrisma.user.count.mockResolvedValue(0)
    mockPrisma.blocklist.findMany.mockResolvedValue([{ kind: 'domain', value: 'banned.test' }])

    const guard = await assertSignupAllowed('someone@banned.test', null)

    expect(guard.ok).toBe(false)
    expect(guard.status).toBe(403)
    expect(mockPrisma.securityEvent.create).toHaveBeenCalled()
  })

  it('never runs Cloud admission for the first self-hosted operator', async () => {
    mockPrisma.user.count.mockResolvedValue(0)

    await assertSignupAllowed('operator@company.internal', null)

    // Applied to the one account that makes a private install usable, the
    // deliverability heuristics only lock the operator out of their own box.
    expect(mockAssessSignupAdmission).not.toHaveBeenCalled()
  })
})

describe('signup admission: what Cloud decides about a stranger', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
    mockPrisma.user.count.mockResolvedValue(100)
  })

  it('delegates to PlatformSignals once the public gates pass', async () => {
    await assertSignupAllowed('stranger@example.com', '9.9.9.9')

    expect(mockAssessSignupAdmission).toHaveBeenCalledWith({ email: 'stranger@example.com', ip: '9.9.9.9' })
  })

  it('returns the private verdict unchanged', async () => {
    mockAssessSignupAdmission.mockResolvedValue({
      ok: false,
      reason: 'Sign-up is not allowed for this email address.',
      status: 403,
      score: 12,
      signals: ['disposable_domain'],
    })

    await expect(assertSignupAllowed('burner@temp.test', null)).resolves.toMatchObject({
      ok: false,
      status: 403,
      score: 12,
    })
  })

  it('runs the kill switches and the blocklist BEFORE Cloud admission', async () => {
    // Ordering matters: an operator's explicit block must not depend on a
    // heuristic agreeing with it, and must not cost a scoring round-trip.
    mockPrisma.blocklist.findMany.mockResolvedValue([{ kind: 'email', value: 'known@bad.test' }])

    const guard = await assertSignupAllowed('known@bad.test', null)

    expect(guard.ok).toBe(false)
    expect(mockAssessSignupAdmission).not.toHaveBeenCalled()
  })
})
