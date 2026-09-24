/**
 * RESTRUCTURING IS REACHABLE FROM ITS OWN DETECTOR
 * ================================================
 *
 * The maintenance ladder (lib/autonomy/maintenance/*) is how Backenly proposes
 * restructuring an area whose individual repairs keep being needed. It had been
 * proven against a hand-inserted finding, and it could not start from a real
 * one, for two independent reasons:
 *
 *   - the observer writes `subsystem_repeat_failure` as `pending_approval`
 *     (it has no inline fix), and the sweep and the pending-ladder view read
 *     `open` only, so neither ever found a real finding;
 *   - the detector's details named no table, and the resolver refuses to plan
 *     without one ("names no table, so no subsystem can be resolved").
 *
 * This drives the real path end to end on real PostgreSQL: seeded repair
 * history, the real detector through the real observer write, then the
 * pending-ladder view and the sweep. It asserts the chain reaches the planner.
 * What the planner then decides (a runnable ladder, or an honest
 * `unsupported_recovery`) is the rollback capability registry's business and
 * is pinned elsewhere.
 */

import { PrismaClient } from '@prisma/client'

import { scenario } from '../lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../lab/seed'
import { invalidateSubsystemCache } from '@/lib/autonomy/subsystem'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { describePendingLadder } from '@/lib/autonomy/maintenance/approval'
import { sweepProjectMaintenance } from '@/lib/autonomy/maintenance/sweep'

const prisma = new PrismaClient()
const seeded: SeededProject[] = []

/** The same ledger subsystem-finding.spec.ts uses to make the auth component fire. */
const FIRING_LEDGER = {
  confirmedRepairs: [
    { type: 'missing_rls', table: 'users' },
    { type: 'missing_fk_index', table: 'sessions', column: 'user_id' },
    { type: 'missing_fk_index', table: 'verification_tokens', column: 'user_id' },
  ],
  serverErrors: [{ table: 'sessions' }],
}

const FLAGS = [
  'ENABLE_SUBSYSTEM_RECURRENCE_FINDING',
  'ENABLE_MAINTENANCE_SCHEDULER',
  'ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS',
] as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const f of FLAGS) {
    saved[f] = process.env[f]
    process.env[f] = 'true'
  }
})

afterAll(async () => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f]
    else process.env[f] = saved[f]
  }
  for (const s of seeded) await teardownScenario(prisma, s)
  await prisma.$disconnect()
})

/** Seed the firing scenario, with the Table rows the builder writes in production. */
async function firingProject(): Promise<SeededProject> {
  const s = await seedScenario(prisma, scenario('auth-heavy'), FIRING_LEDGER as any)
  seeded.push(s)
  for (const t of s.scenario.tables) {
    await prisma.table.create({ data: { name: t.name, projectId: s.projectId } })
  }
  invalidateSubsystemCache(s.projectId)
  return s
}

describe('restructuring starts from the finding its detector writes', () => {
  it('persists a finding that names a member table', async () => {
    const s = await firingProject()
    await runObserverForProject(s.projectId)

    const row = await prisma.healthFinding.findFirst({
      where: { projectId: s.projectId, type: 'subsystem_repeat_failure' },
      select: { status: true, details: true },
    })
    expect(row).not.toBeNull()
    expect(['open', 'pending_approval']).toContain(row!.status)
    const details = row!.details as { tableName?: string; membership?: string[] }
    expect(details.membership).toContain(details.tableName)
  }, 120_000)

  it('reaches the planner from the pending-ladder view and the sweep', async () => {
    const s = await firingProject()
    await runObserverForProject(s.projectId)

    const ladder = await describePendingLadder({ projectId: s.projectId })
    const refusal = 'refusal' in ladder ? String(ladder.refusal) : ''
    expect(refusal).not.toMatch(/no structural finding/)
    expect(refusal).not.toMatch(/names no table/)

    const sweep = await sweepProjectMaintenance({ projectId: s.projectId })
    expect(sweep.disposition).not.toBe('no_finding')
    expect(String((sweep as { reason?: string }).reason ?? '')).not.toMatch(/names no table/)
  }, 120_000)
})
