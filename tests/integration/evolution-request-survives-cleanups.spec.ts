/**
 * An architecture change waiting for a person stays where the person decides it.
 *
 * On production (2026-11-09) the engine proposed moving refund data out of
 * `orders`, recorded "waiting for your approval", and nothing could be
 * approved: "Waiting on you" was empty, `waitingOnYou` was 0, and every later
 * pass skipped the change as "a decision is already awaiting_approval".
 *
 * The request had been dismissed by another module. The life-stage arch_*
 * cleanup (lib/ai/architecture-evolution.ts), run after every observer pass,
 * selected `type: { startsWith: 'arch_' }`. Prisma hands that to LIKE
 * unescaped, `_` matches any one character, and so 'arch_%' matched
 * `architecture_evolution`. The engine's own record still said it was waiting,
 * so it never asked again.
 *
 * These run the real proposal pass over the real orders/refund fixture.
 */

import { prisma } from '@/lib/db'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { reapStaleFindings } from '@/lib/core/finding-reaper'
import { withdrawUnsupportedArchFindings } from '@/lib/ai/architecture-evolution'
import { approveRequest, architectureSummary } from '@/lib/evolution-engine/engine'
import { buildProject, dropProject, proposeWhereItRuns, requestsOf, stateOf, type Fixture } from '../helpers/evolution-engine-fixture'

jest.setTimeout(300_000)

const originalMutations = process.env.ENABLE_EVOLUTION_MUTATIONS
const originalScheduler = process.env.ENABLE_EVOLUTION_SCHEDULER

beforeAll(() => {
  process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
  delete process.env.ENABLE_EVOLUTION_MUTATIONS
})

afterAll(async () => {
  if (originalMutations === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalMutations
  if (originalScheduler === undefined) delete process.env.ENABLE_EVOLUTION_SCHEDULER
  else process.env.ENABLE_EVOLUTION_SCHEDULER = originalScheduler
  await closeMaintenanceLockPool()
})

describe("a request waiting for a person, and the platform's other cleanups", () => {
  let f: Fixture

  beforeAll(async () => {
    f = await buildProject('reaped')
    expect((await proposeWhereItRuns(f.projectId)).requested).toBe(1)
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it("stays in the person's queue through the observer's stale-finding pass", async () => {
    // What runs after every observer pass, a Re-scan, and 60 s after an agent's change.
    await reapStaleFindings(f.projectId)
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('pending_approval')
    expect(req.details.withdrawnBy).toBeUndefined()
    expect((await architectureSummary(f.projectId)).waitingOnYou).toBe(1)
  })

  it('is not matched by the arch_* cleanup even when nothing of its own is supported', async () => {
    const debt = await prisma.healthFinding.create({
      data: { projectId: f.projectId, type: 'arch_debt_missing_index_orders', severity: 'warning', status: 'open', details: { title: 'Tech debt' } as object },
    })
    expect(await withdrawUnsupportedArchFindings(f.projectId, new Set())).toBe(1)
    expect((await prisma.healthFinding.findUnique({ where: { id: debt.id } }))?.status).toBe('dismissed')
    expect((await requestsOf(f.projectId))[0].status).toBe('pending_approval')
  })

  it('is asked again, rather than skipped as "already awaiting approval", when its row was taken out', async () => {
    // The rows production already lost: dismissed by that cleanup, with no
    // decline from the person and the decision still awaiting approval.
    const [req] = await requestsOf(f.projectId)
    await prisma.healthFinding.update({
      where: { id: req.id },
      data: { status: 'dismissed', details: { ...req.details, withdrawnBy: 'evolution_reaper', withdrawnAt: new Date().toISOString() } as object },
    })
    expect((await architectureSummary(f.projectId)).waitingOnYou).toBe(0)

    const pass = await proposeWhereItRuns(f.projectId)
    expect(pass.refreshed).toBe(1)
    expect((await architectureSummary(f.projectId)).waitingOnYou).toBe(1)
    const waiting = (await requestsOf(f.projectId)).filter((r) => r.status === 'pending_approval')
    expect(waiting).toHaveLength(1)
    expect(waiting[0].ev.decisionId).toBe(req.ev.decisionId)
    expect((await stateOf(f.projectId, req.ev.decisionId)).state).toBe('awaiting_approval')
  })

  it('is approvable from the queue once it is back', async () => {
    const waiting = (await requestsOf(f.projectId)).find((r) => r.status === 'pending_approval')!
    const r = await approveRequest({ projectId: f.projectId, findingId: waiting.id, planVersion: waiting.ev.planVersion, userId: f.ownerId })
    expect(r.ok).toBe(true)
  })

  it('a request the person declined is not asked again', async () => {
    // The re-ask is for rows nobody decided on. A decline is recorded in the
    // engine's memory and closes the decision, so it never looks "unaskable".
    const g = await buildProject('declined')
    try {
      await proposeWhereItRuns(g.projectId)
      const [req] = await requestsOf(g.projectId)
      const { dismissRequest } = await import('@/lib/evolution-engine/engine')
      const d = await dismissRequest({ projectId: g.projectId, findingId: req.id, userId: g.ownerId })
      expect(d.ok).toBe(true)
      expect((await proposeWhereItRuns(g.projectId)).requested).toBe(0)
      expect((await architectureSummary(g.projectId)).waitingOnYou).toBe(0)
    } finally {
      await dropProject(g)
    }
  }, 180_000)
})
