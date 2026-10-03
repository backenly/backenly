/**
 * PHASE 3 — subsystem_repeat_failure as a real finding
 * ====================================================
 *
 * The evaluator becomes a row in the owner's queue. That is the first time any
 * of this work is user-visible, so the properties that matter are as much about
 * restraint as detection: one row not many, no button that cannot work, silence
 * once the condition clears, and silence once a human has said "I know".
 *
 * The finding has no executable repair by construction. Its claim is that
 * repairing individual gaps in this area has stopped working, and the remedy is
 * a structural decision about the data model. Rating it `approval` to make it
 * feel actionable would require inventing an executor verb, which is exactly how
 * `schema_not_registered` shipped pointing at REGISTER_POSTGREST_SCHEMA — a verb
 * that never existed.
 */

import { PrismaClient } from '@prisma/client'

import { scenario } from '../lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../lab/seed'
import { invalidateSubsystemCache } from '@/lib/autonomy/subsystem'
import {
  detectSubsystemRecurrence,
  DISMISSAL_SUPPRESSION_DAYS,
} from '@/lib/autonomy/subsystem-recurrence'
import { gapIdentity } from '@/lib/autonomy/desired-state'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'
import { groupFindings } from '@/lib/core/finding-groups'

const prisma = new PrismaClient()
const seeded: SeededProject[] = []

/** The ledger that makes the auth component fire. */
const FIRING_LEDGER = {
  confirmedRepairs: [
    { type: 'missing_rls', table: 'users' },
    { type: 'missing_fk_index', table: 'sessions', column: 'user_id' },
    { type: 'missing_fk_index', table: 'verification_tokens', column: 'user_id' },
  ],
  serverErrors: [{ table: 'sessions' }],
}

async function seed(id: string, ledger: Record<string, unknown> = {}): Promise<SeededProject> {
  const s = await seedScenario(prisma, scenario(id), ledger as any)
  seeded.push(s)
  invalidateSubsystemCache(s.projectId)
  return s
}

beforeAll(() => {
  process.env.ENABLE_SUBSYSTEM_RECURRENCE_FINDING = 'true'
})

afterAll(async () => {
  delete process.env.ENABLE_SUBSYSTEM_RECURRENCE_FINDING
  for (const s of seeded) await teardownScenario(prisma, s)
  await prisma.$disconnect()
})

describe('the flag gates the whole probe', () => {
  it('returns nothing while the flag is off', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    process.env.ENABLE_SUBSYSTEM_RECURRENCE_FINDING = 'false'
    try {
      expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
    } finally {
      process.env.ENABLE_SUBSYSTEM_RECURRENCE_FINDING = 'true'
    }
  })

  it('fires with the same data once the flag is on', async () => {
    // Pairs with the test above: without this, "returns nothing" would be
    // satisfied by a probe that can never fire at all.
    const s = await seed('auth-heavy', FIRING_LEDGER)
    expect(await detectSubsystemRecurrence(s.projectId)).toHaveLength(1)
  })
})

describe('the finding it emits', () => {
  it('emits exactly one, carrying its evidence', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const found = await detectSubsystemRecurrence(s.projectId)

    expect(found).toHaveLength(1)
    const f = found[0]
    expect(f.type).toBe('subsystem_repeat_failure')
    expect(f.autoFixable).toBe(false)
    expect(f.fix).toBeUndefined()
    expect(f.details.membership).toEqual([
      'password_resets', 'sessions', 'users', 'verification_tokens',
    ])
    expect(f.details.confirmedRepairCount).toBe(3)
    expect((f.details.harm as unknown[]).length).toBeGreaterThan(0)
  })

  it('is located by subsystem, never by table', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)

    const key = gapIdentity(f.type, f.details)
    expect(key).toMatch(/^subsystem_repeat_failure::subsystem:[a-z_]+:[a-z0-9]+$/)
    // Locating it by a member table would collide with that table's own gaps.
    expect(key).not.toContain('::users')
  })

  it('produces a stable identity across repeated evaluation', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const a = await detectSubsystemRecurrence(s.projectId)
    invalidateSubsystemCache(s.projectId)
    const b = await detectSubsystemRecurrence(s.projectId)

    expect(gapIdentity(a[0].type, a[0].details)).toBe(gapIdentity(b[0].type, b[0].details))
  })

  it('gets a NEW identity when the component membership changes', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const before = await detectSubsystemRecurrence(s.projectId)

    // A table joins the auth component. The old finding's gap is now
    // undetected, so the reaper withdraws it and this opens fresh — the
    // continuity reset, with no separate bookkeeping.
    //
    // The two unrelated tables are not padding. Growing the component to five
    // members without growing the schema would take it to 5 of 7 tables, past
    // the breadth guard, and the finding would vanish for that reason instead
    // of re-keying — which would have made this test pass or fail for a
    // completely different reason than the one it is named after.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${s.schema}"."mfa_devices" (
         id uuid PRIMARY KEY,
         user_id uuid REFERENCES "${s.schema}"."users"(id)
       )`,
    )
    await prisma.$executeRawUnsafe(`CREATE TABLE "${s.schema}"."plans" (id uuid PRIMARY KEY)`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${s.schema}"."regions" (id uuid PRIMARY KEY)`)
    invalidateSubsystemCache(s.projectId)
    const after = await detectSubsystemRecurrence(s.projectId)

    expect(after).toHaveLength(1)
    expect(after[0].details.membership).toContain('mfa_devices')
    expect(gapIdentity(after[0].type, after[0].details)).not.toBe(
      gapIdentity(before[0].type, before[0].details),
    )
  })

  /**
   * The interaction the test above had to be written around, pinned in its own
   * right: a component that grows past the breadth guard stops being a subject
   * Backenly will make claims about, and the finding withdraws rather than
   * re-keying. Silence is the correct outcome — "this subsystem" has become
   * "this backend", which tells the owner nothing they can act on.
   */
  it('withdraws entirely when growth pushes the component past the breadth guard', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    expect(await detectSubsystemRecurrence(s.projectId)).toHaveLength(1)

    // One new member, no new unrelated tables: 5 of 7 tables, over the guard.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${s.schema}"."mfa_devices" (
         id uuid PRIMARY KEY,
         user_id uuid REFERENCES "${s.schema}"."users"(id)
       )`,
    )
    invalidateSubsystemCache(s.projectId)

    expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
  })
})

describe('the UI contract', () => {
  it('is notify_only, so no autonomy level can act on it', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)
    expect(classifyFix(f.type, f.details as any).decision).toBe('notify_only')
  })

  it('offers no executable action but does offer a hint', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)

    expect(buildFixAction(f.type, f.details as any)).toBeNull()
    const hint = getManualRemediationHint(f.type, f.details as any)
    expect(hint).toBeTruthy()
    // The hint must name the area and tell the owner dismissal is available,
    // otherwise a finding they cannot act on has no exit.
    expect(hint).toMatch(/sessions/)
    expect(hint).toMatch(/[Dd]ismiss/)
  })

  it('renders as a non-actionable group', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)

    const [group] = groupFindings([
      { id: 'f1', type: f.type, severity: 'warning', detectedAt: new Date().toISOString(), details: f.details as any },
    ] as any)
    expect(group.actionable).toBe(false)
    expect(group.manualHint).toBeTruthy()
  })
})

describe('human dismissal suppresses it', () => {
  it('stops emitting after a human dismisses that membership', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)

    await prisma.healthFinding.create({
      data: {
        projectId: s.projectId,
        type: 'subsystem_repeat_failure',
        severity: 'warning',
        status: 'dismissed',
        details: f.details as any,
      },
    })
    invalidateSubsystemCache(s.projectId)

    expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
  })

  /**
   * The reaper also writes `status: 'dismissed'`, and treating that as a human
   * decision would mean a condition that resolved itself could never be raised
   * again when it returned. The marker `withdrawnBy` is the discriminator.
   */
  it('a REAPER withdrawal does not suppress it', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)

    await prisma.healthFinding.create({
      data: {
        projectId: s.projectId,
        type: 'subsystem_repeat_failure',
        severity: 'warning',
        status: 'dismissed',
        details: { ...(f.details as any), withdrawnBy: 'invariant_reaper' },
      },
    })
    invalidateSubsystemCache(s.projectId)

    expect(await detectSubsystemRecurrence(s.projectId)).toHaveLength(1)
  })

  it('can return once the suppression window has passed', async () => {
    const s = await seed('auth-heavy', FIRING_LEDGER)
    const [f] = await detectSubsystemRecurrence(s.projectId)

    await prisma.healthFinding.create({
      data: {
        projectId: s.projectId,
        type: 'subsystem_repeat_failure',
        severity: 'warning',
        status: 'dismissed',
        detectedAt: new Date(Date.now() - (DISMISSAL_SUPPRESSION_DAYS + 5) * 24 * 60 * 60 * 1000),
        details: f.details as any,
      },
    })
    invalidateSubsystemCache(s.projectId)

    expect(await detectSubsystemRecurrence(s.projectId)).toHaveLength(1)
  })

  it('dismissing one subsystem does not silence another', async () => {
    const s = await seed('ecommerce', {
      confirmedRepairs: [
        { type: 'missing_rls', table: 'products' },
        { type: 'missing_fk_index', table: 'product_images', column: 'product_id' },
        { type: 'missing_fk_index', table: 'reviews', column: 'product_id' },
      ],
      serverErrors: [{ table: 'products' }],
    })
    const [f] = await detectSubsystemRecurrence(s.projectId)

    // Dismiss a DIFFERENT membership hash.
    await prisma.healthFinding.create({
      data: {
        projectId: s.projectId,
        type: 'subsystem_repeat_failure',
        severity: 'warning',
        status: 'dismissed',
        details: { ...(f.details as any), membershipHash: 'some-other-area' },
      },
    })
    invalidateSubsystemCache(s.projectId)

    expect(await detectSubsystemRecurrence(s.projectId)).toHaveLength(1)
  })
})

describe('it stays silent on everything that is not this', () => {
  it('churn alone cannot create it', async () => {
    const s = await seed('auth-heavy', {
      changes: Array.from({ length: 30 }, () => ({ table: 'users' })),
    })
    expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
  })

  it('repairs split across different subsystems cannot create it', async () => {
    const s = await seed('ecommerce', {
      confirmedRepairs: [
        { type: 'missing_rls', table: 'users' },
        { type: 'missing_fk_index', table: 'products', column: 'sku' },
        { type: 'missing_fk_index', table: 'product_images', column: 'product_id' },
      ],
      serverErrors: [{ table: 'orders' }],
    })
    expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
  })

  it('the healthy control scenario stays silent', async () => {
    const s = await seed('content-community')
    expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
  })

  it('a backend with no constraint skeleton stays silent', async () => {
    const s = await seed('messy-legacy', FIRING_LEDGER)
    expect(await detectSubsystemRecurrence(s.projectId)).toEqual([])
  })
})
