/**
 * THE ARCHITECTURE EVOLUTION ENGINE, END TO END — against a real PostgreSQL
 * =========================================================================
 *
 * The loop a real project goes through, with nothing mocked:
 *
 *   propose     the engine assesses, rehearses on a copy, and asks — once —
 *               through the existing approval queue (an `architecture_evolution`
 *               finding that no generic approve path will accept)
 *   approve     a stale version and a second click are refused; consent binds
 *               to the version shown; with mutations off nothing runs
 *   advance     expand, backfill, verify, cut over, each a remembered state
 *   pause       mid-backfill, the chain stops at its cursor; resume continues it
 *   observe     the change is watched; a divergence planted behind the
 *               triggers' back stops it and puts it back in front of the owner
 *   stable      only after the window, enough passes and measured agreement,
 *               with an outcome that never claims more than was measured
 *   undo        lossless; afterwards memory keeps the same change from being
 *               proposed again on the same evidence
 *   look again  a month and three months on: an outcome that can no longer be
 *               shown is said where the person reads it, the data is reconciled
 *               again, and a problem found then stops the change for a person
 *               (the measurement step is replaced only to choose a verdict)
 *   decline     a decline is remembered the same way, and said where the
 *               person reads it; "not now" on a stopped change moves it to
 *               the card without touching it
 *   asking      Backenly asks only where an approved change then finishes on
 *               its own, and says plainly why a change waits where it does not
 *   stopping    a step that does not finish is told by what it was doing,
 *               never by a job id or the database's words
 *   scheduler   resumes only what a person approved, and holds it where it is
 *               while the project is mid-incident (lib/autonomy/change-freeze.ts)
 *
 * Every assertion about state reads it from architecture memory, the store the
 * engine itself reads, so the test sees what the next pass will see.
 */

import { prisma } from '@/lib/db'
import { closeMaintenanceLockPool, projectToLockKey, withMaintenanceSingleFlight } from '@/lib/autonomy/maintenance/single-flight'
import { applyApproval } from '@/lib/ai/approval-manager'
import { buildTrustReport } from '@/lib/autonomy/trust-report'
import { REPAIR_HELD } from '@/lib/autonomy/change-freeze'
import { explainHeldBack } from '@/lib/autonomy/because-copy'
import {
  advance,
  approveRequest,
  architectureSummary,
  dismissRequest,
  isActionRefusal,
  isApprovalRefusal,
  listChanges,
  lookAgain,
  observe,
  pause,
  proposeChanges,
  resume,
  sweepArchitecture,
  undo,
} from '@/lib/evolution-engine/engine'
import { decisionTrail, readMemory, remember, summarizeDecisions, priorsFor } from '@/lib/evolution-engine/memory'
import { DEFAULT_POLICY } from '@/lib/evolution-engine/policy'
import { basisFingerprint, readTableFacts } from '@/lib/structural-evolution/facts'
import { structuralExtraction } from '@/lib/structural-evolution/primitive'
import type { Measurement } from '@/lib/evolution-engine/primitive'
import { workspaceOn } from '@/lib/structural-evolution/workspace'
import { architectureHold, HOLD_LAPSES_AFTER_MS, repairedTable, repairHold } from '@/lib/evolution-engine/holds'
import { Client } from 'pg'
import { runAutoFix } from '@/lib/core/auto-fix-engine'
import { runReconcilerLive } from '@/lib/autonomy/reconciler'
import { asService, buildProject, drain, dropProject, proposeWhereItRuns, q, requestsOf, stateOf, type Fixture } from '../helpers/evolution-engine-fixture'

jest.setTimeout(300_000)

const originalMutations = process.env.ENABLE_EVOLUTION_MUTATIONS
const originalScheduler = process.env.ENABLE_EVOLUTION_SCHEDULER
const originalAllowlist = process.env.EVOLUTION_PROJECT_ALLOWLIST
const HOUR = 3_600_000

// A deployment that carries approved changes on by itself, as one that asks
// for them does; the scheduler suite below turns it off where it says so.
beforeAll(() => {
  process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
})

afterAll(async () => {
  if (originalMutations === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalMutations
  if (originalScheduler === undefined) delete process.env.ENABLE_EVOLUTION_SCHEDULER
  else process.env.ENABLE_EVOLUTION_SCHEDULER = originalScheduler
  if (originalAllowlist === undefined) delete process.env.EVOLUTION_PROJECT_ALLOWLIST
  else process.env.EVOLUTION_PROJECT_ALLOWLIST = originalAllowlist
  await closeMaintenanceLockPool()
})

// ── The whole life of one change ─────────────────────────────────────────────

describe('one architecture change, from proposal to undo', () => {
  let f: Fixture
  let findingId = ''
  let decisionId = ''
  let planVersion = ''
  let cutoverAt = new Date()

  beforeAll(async () => {
    delete process.env.ENABLE_EVOLUTION_MUTATIONS
    f = await buildProject('life')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('proposes once: rehearsed first, then asked through the approval queue', async () => {
    const pass = await proposeWhereItRuns(f.projectId)
    expect(pass.requested).toBe(1)
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('pending_approval')
    // The three doors that must stay shut.
    expect(req.details).not.toHaveProperty('fix')
    expect(req.details).not.toHaveProperty('tableName')
    expect(req.details).not.toHaveProperty('location')
    expect(req.ev).toMatchObject({ ask: 'approve', subject: 'orders', level: 'executable_proposal' })
    expect(req.ev.rehearsal).toMatchObject({ passed: true })
    expect(req.ev.rehearsal.planVersion).toBe(req.ev.planVersion)
    expect(req.ev.summary.headline).toMatch(/refund/)
    expect(req.ev.summary.compatibility).toMatch(/keep working unchanged/)
    expect(req.ev.technical.steps.some(s => s.humanOnly)).toBe(true)
    findingId = req.id
    decisionId = req.ev.decisionId
    planVersion = req.ev.planVersion

    const trail = await decisionTrail(f.projectId, decisionId)
    expect(trail.filter(e => e.record.event === 'transition').map(e => e.record.state)).toEqual([
      'proposed',
      'rehearsing',
      'rehearsed',
      'awaiting_approval',
    ])
    expect(trail.some(e => e.record.event === 'measured')).toBe(true) // the R snapshot

    // Asking again changes nothing: one request per decision.
    expect((await proposeWhereItRuns(f.projectId)).requested).toBe(0)
    expect(await requestsOf(f.projectId)).toHaveLength(1)
  })

  it('is refused by every generic approve path', async () => {
    const r = await applyApproval(f.projectId, findingId)
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/Autonomy page/)
  })

  it('refuses a version the person was not shown', async () => {
    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion: 'stale', userId: f.ownerId })
    expect(isApprovalRefusal(r) && r.status).toBe(409)
    expect(isApprovalRefusal(r) && r.currentPlanVersion).toBe(planVersion)
    expect((await requestsOf(f.projectId))[0].status).toBe('pending_approval')
  })

  it('with mutations off, records consent and runs nothing', async () => {
    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion, userId: f.ownerId })
    expect(r.ok).toBe(true)
    // Said as it is, in words for a person: never the operator's flag.
    expect(!isApprovalRefusal(r) && r.message).toMatch(/^Approved\. Backenly isn't running architecture changes in this deployment right now\. It starts when it can/)
    expect(!isApprovalRefusal(r) && r.message).not.toMatch(/ENABLE_/)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('approved')
    expect((await requestsOf(f.projectId))[0].status).toBe('approved')
    expect(await readTableFacts(workspaceOn(prisma, f.schema), 'order_refunds')).toBeNull()
  })

  it('cannot be approved twice', async () => {
    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion, userId: f.ownerId })
    expect(isApprovalRefusal(r) && r.status).toBe(409)
  })

  it('with mutations on, expands and hands the backfill to the queue', async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    const r = await advance({ projectId: f.projectId, decisionId })
    expect(r.state).toBe('backfilling')
    const trail = await decisionTrail(f.projectId, decisionId)
    expect(trail.filter(e => e.record.event === 'transition').map(e => e.record.state).slice(-3)).toEqual([
      'approved',
      'expanding',
      'backfilling',
    ])
    expect(trail.some(e => e.record.event === 'measured' && (e.record.payload as any)?.snapshot?.phase === 'S0')).toBe(true)
  })

  it('pausing stops the backfill at its cursor; resuming continues from it', async () => {
    const p = await pause({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(p.ok).toBe(true)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('blocked')
    const stopped = await drain(f.projectId)
    expect(stopped[0]?.refusal).toMatch(/^paused:/)

    const r = await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(isActionRefusal(r) ? r.error : r.state).toBe('backfilling')
    expect((await drain(f.projectId)).every(x => !x.refusal)).toBe(true)
  })

  it('verifies, cuts over and starts watching', async () => {
    const r = await advance({ projectId: f.projectId, decisionId })
    expect(r.state).toBe('observing')
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('observing')
    cutoverAt = s.cutoverAt!
    const milestones = (await decisionTrail(f.projectId, decisionId)).filter(e => e.milestone).map(e => e.sentence)
    expect(milestones.join('\n')).toMatch(/being watched for 24 hours/)
    // Plain sentences only: no internal state names reach a person.
    expect(milestones.join('\n')).not.toMatch(/backfilling|expanding|cutover|awaiting_approval/)
  })

  it('does not call it done before the window, however clean the passes', async () => {
    const r = await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + HOUR) })
    expect(r.verdict).toBe('continue')
    expect(r.reason).toMatch(/watching for 24h/)
  })

  it('becomes stable after the window with enough passes, and never claims more than it measured', async () => {
    await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + 12 * HOUR) })
    const r = await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + 25 * HOUR) })
    expect(r.verdict).toBe('stable')
    expect(r.benefit).toBeDefined()
    // A day of synthetic traffic proves nothing either way; the honest verdict
    // is that it worked and the benefit is not yet measurable.
    expect(['insufficient_evidence', 'neutral']).toContain(r.benefit!.verdict)
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('stable')
    // No request followed the change in this fixture, so nobody's traffic was
    // compared: it says what it saw, and not that existing apps kept working.
    expect(s.headline).toMatch(/Nothing failed while it was watched, the data matches, and it can be undone/)
    expect(s.headline).not.toMatch(/Existing apps kept working/)
    expect(s.headline).not.toMatch(/improved/)
    // Said once, and with when it will be judged again.
    expect(s.headline).not.toMatch(/It works correctly/)
    expect(s.headline).toMatch(/Backenly will look again a month after the change\.$/)
    expect((await requestsOf(f.projectId))[0].status).toBe('resolved')

    const [view] = await listChanges(f.projectId)
    expect(view).toMatchObject({ decisionId, status: { label: 'Done' }, actions: { undo: true, pause: false } })
  })

  it('reaches the Autonomy page as plain sentences, and the engine\'s notebook does not', async () => {
    const report = await buildTrustReport(f.projectId, 30)
    const arch = report.recentActivity.filter(a => a.kind === 'architecture')
    expect(arch.map(a => a.summary).join('\n')).toMatch(/Nothing failed while it was watched/)
    expect(arch.map(a => a.summary).join('\n')).toMatch(/You approved/)
    // Traces (rehearsing, snapshots, observation passes) are memory, not news.
    expect(report.recentActivity.some(a => /snapshot|consistency: ok|Rehearsing/.test(a.summary))).toBe(false)
    expect(report.architectureChanges.map(c => c.decisionId)).toContain(decisionId)
  })

  it('undoes losslessly, and does not propose the same change again on the same evidence', async () => {
    const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect(await readTableFacts(workspaceOn(prisma, f.schema), 'order_refunds')).toBeNull()
    expect((await stateOf(f.projectId, decisionId)).state).toBe('rolled_back')

    const priors = priorsFor(summarizeDecisions(await readMemory(f.projectId)))
    expect(priors['orders:refund']).toMatchObject({ kind: 'reversed', regressed: false })
    expect((await proposeWhereItRuns(f.projectId)).requested).toBe(0)
    const assessed = (await readMemory(f.projectId)).filter(e => e.record.event === 'assessed' && e.record.concernKey === 'orders:refund')
    expect(assessed[assessed.length - 1].sentence).toMatch(/you undid it/)
  })
})

// ── Stopping on a regression ─────────────────────────────────────────────────

describe('a change that misbehaves under observation', () => {
  let f: Fixture
  let decisionId = ''
  let cutoverAt = new Date()

  beforeAll(async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    f = await buildProject('regress')
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    decisionId = req.ev.decisionId
    const a = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    if (isApprovalRefusal(a)) throw new Error(a.error)
    await drain(f.projectId)
    await advance({ projectId: f.projectId, decisionId })
    cutoverAt = (await stateOf(f.projectId, decisionId)).cutoverAt!
  }, 180_000)
  afterAll(async () => dropProject(f), 60_000)

  it('stops on the first divergence and asks the owner to keep or undo it', async () => {
    expect((await stateOf(f.projectId, decisionId)).state).toBe('observing')
    // A write that bypasses the triggers — the one way the two shapes can part.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`DELETE FROM "${f.schema}"."order_refunds" WHERE ctid IN (SELECT ctid FROM "${f.schema}"."order_refunds" LIMIT 1)`)
    })
    const r = await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt.getTime() + HOUR) })
    expect(r.verdict).toBe('regressed')
    expect((await stateOf(f.projectId, decisionId)).state).toBe('blocked')
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('pending_approval')
    // It was already in place: there is nothing left to resume.
    expect(req.ev.ask).toBe('keep_or_undo')
    expect(req.ev.stoppedBecause).toMatch(/consistency|disagrees/)
    // Policy: no automatic undo unless the owner turned it on.
    expect(DEFAULT_POLICY.autoRollbackOnRegression).toBe(false)
    expect(await readTableFacts(workspaceOn(prisma, f.schema), 'order_refunds')).not.toBeNull()
  })

  it('undoes losslessly when the divergence lost nothing: the host still holds every value', async () => {
    // The planted divergence is a MISSING satellite row: the host still has
    // the data, so undo is lossless and proceeds.
    const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('rolled_back')
    expect(priorsFor(summarizeDecisions(await readMemory(f.projectId)))['orders:refund']).toMatchObject({ kind: 'reversed' })
    const rows = await asService<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM "${f.schema}"."orders" WHERE refund_amount IS NOT NULL`)
    expect(Number(rows[0].n)).toBe(60)
  })
})

// ── After it is done ─────────────────────────────────────────────────────────

describe('after a change is done, its outcome is looked at again, and a later problem is not hidden', () => {
  let f: Fixture
  let decisionId = ''
  let cutoverAt = new Date()
  const at = (hours: number) => new Date(cutoverAt.getTime() + hours * HOUR)
  /** A busy table's numbers: its API clients compared and unaffected, and host locks before and after. */
  const measured = (locksAfter: number): Measurement[] => [
    {
      name: 'orders write p95', role: 'guardrail', unit: 'ms', before: 40, after: 40, better: 'lower',
      samplesBefore: 5_000, samplesAfter: 5_000, minSamples: 200, population: 'api', scope: 'requests to orders',
    },
    {
      name: 'refund changes that locked all of orders', role: 'benefit', unit: 'changes', before: 5, after: locksAfter, better: 'lower',
      samplesBefore: 5, samplesAfter: locksAfter, minSamples: 0, scope: 'in the 30 days before the change and the 30 days after',
    },
  ]

  beforeAll(async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    f = await buildProject('horizon')
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    decisionId = req.ev.decisionId
    const a = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    if (isApprovalRefusal(a)) throw new Error(a.error)
    await drain(f.projectId)
    await advance({ projectId: f.projectId, decisionId })
    cutoverAt = (await stateOf(f.projectId, decisionId)).cutoverAt!
  }, 180_000)
  afterAll(async () => {
    jest.restoreAllMocks()
    await dropProject(f)
  }, 60_000)

  it('keeps watching, instead of calling it done, while its outcome cannot be measured', async () => {
    await observe({ projectId: f.projectId, decisionId, now: at(1) })
    await observe({ projectId: f.projectId, decisionId, now: at(12) })
    const spy = jest.spyOn(structuralExtraction, 'measure').mockRejectedValueOnce(new Error('the request log is unavailable'))
    try {
      const r = await observe({ projectId: f.projectId, decisionId, now: at(25) })
      expect(r).toMatchObject({ state: 'observing', verdict: 'continue' })
    } finally {
      spy.mockRestore()
    }
    expect((await stateOf(f.projectId, decisionId)).state).toBe('observing')
    const noted = (await decisionTrail(f.projectId, decisionId)).filter(e => e.record.event === 'noted')
    expect(noted.map(e => e.sentence)).toEqual(['the outcome could not be measured: the request log is unavailable'])
  })

  it('says existing apps kept working, and that it improved things, when the numbers show both', async () => {
    const spy = jest.spyOn(structuralExtraction, 'measure').mockResolvedValueOnce(measured(0))
    try {
      const r = await observe({ projectId: f.projectId, decisionId, now: at(26) })
      expect(r).toMatchObject({ verdict: 'stable', benefit: { verdict: 'beneficial', safety: 'held' } })
    } finally {
      spy.mockRestore()
    }
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('stable')
    expect(s.headline).toMatch(/^Backenly improved your Orders architecture: .*Existing apps kept working, the data matches, and it can be undone\./)
  })

  it('a month on, takes "improved" back where the person reads it when the numbers no longer show it', async () => {
    const spy = jest.spyOn(structuralExtraction, 'measure').mockResolvedValueOnce(measured(4))
    try {
      await lookAgain({ projectId: f.projectId, decisionId, now: at(31 * 24) })
    } finally {
      spy.mockRestore()
    }
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('stable')
    expect(s.outcome?.verdict).toBe('neutral')
    expect(s.headline).toBe('A month on, Backenly can no longer show that the change to orders helped. Existing apps were unaffected, but it has not paid off yet.')
    expect(s.headline).not.toMatch(/improved/)
  })

  it('three months on, reconciles the data again, and stops the change for a person when it no longer matches', async () => {
    // A write behind the triggers' back, long after the change was called done.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`DELETE FROM "${f.schema}"."order_refunds" WHERE ctid IN (SELECT ctid FROM "${f.schema}"."order_refunds" LIMIT 1)`)
    })
    const spy = jest.spyOn(structuralExtraction, 'measure').mockResolvedValueOnce(measured(4))
    try {
      await lookAgain({ projectId: f.projectId, decisionId, now: at(91 * 24) })
    } finally {
      spy.mockRestore()
    }
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('blocked')
    expect(s.headline).toBe('Backenly stopped the change to orders because it saw a problem: its data stopped matching.')
    // Back in front of the person: the request settled when it was done, so a new one is raised.
    const waiting = (await requestsOf(f.projectId)).filter(r => r.ev.decisionId === decisionId && r.status === 'pending_approval')
    expect(waiting.map(r => [r.ev.ask, r.ev.stoppedBecause])).toEqual([['keep_or_undo', 'its data stopped matching']])
  })

  it('kept on purpose, it is watched again from now', async () => {
    const r = await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(isActionRefusal(r) ? r.error : r.message).toBe('Kept. Backenly watches it again from now.')
    expect((await stateOf(f.projectId, decisionId)).state).toBe('observing')
  })
})

// ── "Not now" ────────────────────────────────────────────────────────────────

describe('declining a request', () => {
  let f: Fixture

  beforeAll(async () => {
    f = await buildProject('decline')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is remembered, said where the person reads it, and the same change is not asked for again on the same evidence', async () => {
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    const r = await dismissRequest({ projectId: f.projectId, findingId: req.id, userId: f.ownerId })
    expect(r).toMatchObject({ ok: true, message: "Declined. Backenly won't ask again unless something new is measured." })
    expect((await requestsOf(f.projectId))[0].status).toBe('dismissed')
    // A second click, or a stale tab, declines nothing twice.
    expect(await dismissRequest({ projectId: f.projectId, findingId: req.id, userId: f.ownerId })).toMatchObject({ ok: false, status: 409 })

    // Shown, as an architecture event, not a failure.
    const report = await buildTrustReport(f.projectId)
    const said = report.recentActivity.find(a => a.summary.startsWith('You declined:'))
    expect(said).toMatchObject({ kind: 'architecture' })
    expect(said!.summary).toMatch(/Backenly won't ask again unless something new is measured\.$/)

    const priors = priorsFor(summarizeDecisions(await readMemory(f.projectId)))
    expect(priors['orders:refund']).toMatchObject({ kind: 'declined' })
    expect((await proposeWhereItRuns(f.projectId)).requested).toBe(0)
    expect((await requestsOf(f.projectId)).filter(r => r.status === 'pending_approval')).toHaveLength(0)
    const assessed = (await readMemory(f.projectId)).filter(e => e.record.event === 'assessed' && e.record.concernKey === 'orders:refund')
    expect(assessed[assessed.length - 1].sentence).toMatch(/you declined this change/)
  })
})

// ── A waiting request follows the table ──────────────────────────────────────

describe('a request waiting while the table changes', () => {
  let f: Fixture
  let findingId = ''
  let firstVersion = ''

  beforeAll(async () => {
    delete process.env.ENABLE_EVOLUTION_MUTATIONS
    f = await buildProject('drift')
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    findingId = req.id
    firstVersion = req.ev.planVersion
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is re-rehearsed for the table as it is now, in the same row, and the old version can no longer be approved', async () => {
    await q(`ALTER TABLE "${f.schema}"."orders" ADD COLUMN note text`)
    const pass = await proposeWhereItRuns(f.projectId)
    expect(pass.refreshed).toBe(1)
    const reqs = await requestsOf(f.projectId)
    expect(reqs).toHaveLength(1)
    expect(reqs[0].id).toBe(findingId)
    expect(reqs[0].ev.planVersion).not.toBe(firstVersion)
    expect(reqs[0].ev.rehearsal.planVersion).toBe(reqs[0].ev.planVersion)

    const r = await approveRequest({ projectId: f.projectId, findingId, planVersion: firstVersion, userId: f.ownerId })
    expect(isApprovalRefusal(r) && r.currentPlanVersion).toBe(reqs[0].ev.planVersion)
  })

  it('is withdrawn — not left in the queue — when the concern it was about is gone', async () => {
    const decisionId = (await requestsOf(f.projectId))[0].ev.decisionId
    await q(`ALTER TABLE "${f.schema}"."orders" DROP COLUMN refund_amount, DROP COLUMN refund_reason, DROP COLUMN refunded_at`)
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    expect(req.status).toBe('resolved')
    const s = await stateOf(f.projectId, decisionId)
    expect(s.state).toBe('blocked')
    expect(s.headline).toMatch(/withdrew its request/)
    // Never approved, so it is nobody's change to list.
    expect((await listChanges(f.projectId)).map(c => c.decisionId)).not.toContain(decisionId)
  })
})

// ── The scheduler ────────────────────────────────────────────────────────────

describe('the scheduler', () => {
  let f: Fixture
  let decisionId = ''

  /**
   * A normal day of end-user traffic, then an hour in which every request
   * fails: an incident, as the autonomy health signal reads request logs
   * (lib/autonomy/telemetry.ts).
   */
  async function incident() {
    const now = Date.now()
    const at = (ms: number, statusCode: number) => ({
      projectId: f.projectId,
      userId: f.ownerId,
      method: 'GET',
      path: '/db/orders',
      statusCode,
      duration: 4,
      timestamp: new Date(now - ms),
    })
    await prisma.apiRequestLog.createMany({
      data: [
        ...Array.from({ length: 22 }, (_, h) => at((h + 2) * HOUR, 200)),
        ...Array.from({ length: 10 }, (_, m) => at((m + 1) * 60_000, 503)),
      ],
    })
  }

  beforeAll(async () => {
    delete process.env.ENABLE_EVOLUTION_MUTATIONS
    delete process.env.ENABLE_EVOLUTION_SCHEDULER
    f = await buildProject('scheduler')
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    decisionId = req.ev.decisionId
    const r = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    expect(r.ok).toBe(true)
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('runs nothing while it is off', async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    expect(await sweepArchitecture({ projectId: f.projectId })).toMatchObject({ disposition: 'disabled', advanced: 0 })
    expect((await stateOf(f.projectId, decisionId)).state).toBe('approved')
  })

  it('carries nothing on, and looks for nothing new, for a project that is not on the rollout list', async () => {
    process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
    process.env.EVOLUTION_PROJECT_ALLOWLIST = 'another-project'
    try {
      const r = await sweepArchitecture({ projectId: f.projectId })
      expect(r).toMatchObject({ disposition: 'swept', observed: 0, advanced: 0 })
      expect(r).not.toHaveProperty('proposals')
      expect((await stateOf(f.projectId, decisionId)).state).toBe('approved')
      expect(await readTableFacts(workspaceOn(prisma, f.schema), 'order_refunds')).toBeNull()
    } finally {
      delete process.env.EVOLUTION_PROJECT_ALLOWLIST
    }
  })

  it('holds an approved change where it is while the project is mid-incident, and says so', async () => {
    process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
    await incident()
    expect(await sweepArchitecture({ projectId: f.projectId })).toMatchObject({ disposition: 'swept', advanced: 0, frozen: true })
    expect((await stateOf(f.projectId, decisionId)).state).toBe('approved')
    expect(await readTableFacts(workspaceOn(prisma, f.schema), 'order_refunds')).toBeNull()

    const held = await prisma.auditLog.findMany({ where: { projectId: f.projectId, action: REPAIR_HELD }, select: { details: true } })
    const details = held.map(h => JSON.parse(String(h.details)))
    expect(details).toEqual([expect.objectContaining({ loop: 'maintenance', via: 'architecture_evolution', wouldHaveApplied: 1 })])
    expect(explainHeldBack(details[0]).full).toMatch(
      /^Backenly held back the next step of an architecture change you approved because the project is mid-incident/,
    )
  })

  it('carries the change on at the first pass after the incident', async () => {
    await prisma.apiRequestLog.deleteMany({ where: { projectId: f.projectId, statusCode: 503 } })
    const r = await sweepArchitecture({ projectId: f.projectId })
    expect(r).toMatchObject({ disposition: 'swept', advanced: 1 })
    expect(r).not.toHaveProperty('frozen')
    expect((await stateOf(f.projectId, decisionId)).state).toBe('backfilling')
    expect((await drain(f.projectId)).every(x => !x.refusal)).toBe(true)
  })
})


// ── Asking only for what then finishes on its own ────────────────────────────

describe('asking only for a change that then finishes on its own', () => {
  let f: Fixture
  const setup = async (o: { mutations: boolean; scheduler: boolean; autonomy?: 'OFF' | 'BALANCED'; allowlist?: string }) => {
    if (o.mutations) process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    else delete process.env.ENABLE_EVOLUTION_MUTATIONS
    if (o.scheduler) process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
    else delete process.env.ENABLE_EVOLUTION_SCHEDULER
    if (o.allowlist !== undefined) process.env.EVOLUTION_PROJECT_ALLOWLIST = o.allowlist
    else delete process.env.EVOLUTION_PROJECT_ALLOWLIST
    await prisma.project.update({ where: { id: f.projectId }, data: { autonomyLevel: o.autonomy ?? 'BALANCED' } as any })
  }

  beforeAll(async () => {
    f = await buildProject('ask-only')
  }, 120_000)
  afterAll(async () => {
    process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
    await dropProject(f)
  }, 60_000)

  it.each([
    ['changes are not run here', { mutations: false, scheduler: true }, "Backenly isn't running architecture changes in this deployment right now."],
    ['nothing carries changes on here', { mutations: true, scheduler: false }, "this deployment doesn't carry architecture changes on by itself."],
    ['autonomy is off for the project', { mutations: true, scheduler: true, autonomy: 'OFF' as const }, 'autonomy is off for this project, so Backenly does not carry changes on by itself.'],
    ['the project is not on the rollout list', { mutations: true, scheduler: true, allowlist: 'another-project' }, "Backenly isn't running architecture changes for this project right now."],
  ])('asks for nothing when %s, and says why', async (_label, o, why) => {
    await setup(o)
    const pass = await proposeChanges(f.projectId)
    expect(pass.requested).toBe(0)
    expect(await requestsOf(f.projectId)).toHaveLength(0)
    const summary = await architectureSummary(f.projectId)
    expect(summary.recommendations.map(r => r.sentence)).toContain(`A change to orders is ready, but Backenly is not asking for it: ${why}`)
  })

  it('withdraws a request that was waiting when changes stopped carrying on here, as news rather than a failure', async () => {
    await setup({ mutations: true, scheduler: true })
    expect((await proposeChanges(f.projectId)).requested).toBe(1)
    const [req] = await requestsOf(f.projectId)
    await setup({ mutations: false, scheduler: true })
    await proposeChanges(f.projectId)
    expect((await requestsOf(f.projectId))[0].status).toBe('resolved')
    const s = await stateOf(f.projectId, req.ev.decisionId)
    expect(s.state).toBe('blocked')
    expect(s.headline).toBe('Backenly withdrew its request to change orders: approved changes cannot carry on by themselves here right now.')
    const said = (await buildTrustReport(f.projectId)).recentActivity.find(a => a.summary === s.headline)
    expect(said).toMatchObject({ kind: 'architecture' })

    // A day later, where it carries on again, it is asked for again.
    await setup({ mutations: true, scheduler: true })
    expect((await proposeChanges(f.projectId, { now: new Date(Date.now() + 25 * HOUR) })).refreshed).toBe(1)
    expect((await requestsOf(f.projectId)).filter(r => r.status === 'pending_approval')).toHaveLength(1)
  })

  it('says plainly why an approved change waits, and never offers pause and resume together', async () => {
    await setup({ mutations: true, scheduler: true })
    const [req] = (await requestsOf(f.projectId)).filter(r => r.status === 'pending_approval')
    // The deployment stopped running changes between the request and the click.
    await setup({ mutations: false, scheduler: true })
    const r = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    expect(!isApprovalRefusal(r) && r.message).toBe(
      "Approved. Backenly isn't running architecture changes in this deployment right now. It starts when it can; your app works as before.",
    )
    const view = async () => (await listChanges(f.projectId)).find(c => c.decisionId === req.ev.decisionId)!
    let c = await view()
    expect(c).toMatchObject({
      status: { label: 'Waiting to start', tone: 'attention' },
      waiting: "Backenly isn't running architecture changes in this deployment right now.",
      actions: { pause: false, resume: false },
    })
    expect(c).not.toHaveProperty('state')
    expect((await listChanges(f.projectId, { detail: true })).find(x => x.decisionId === req.ev.decisionId)?.state).toBe('approved')
    // Nothing resumes where nothing can run, and it says so instead of "Resumed.".
    const refused = await resume({ projectId: f.projectId, decisionId: req.ev.decisionId, userId: f.ownerId })
    expect(isActionRefusal(refused) && refused.error).toMatch(/^Backenly isn't running architecture changes in this deployment right now, so this one can't carry on yet\./)

    // On, but not for this project yet: the same wait, said for the project.
    await setup({ mutations: true, scheduler: true, allowlist: 'another-project' })
    c = await view()
    expect(c).toMatchObject({ waiting: "Backenly isn't running architecture changes for this project right now.", actions: { pause: false, resume: false } })
    const refusedHere = await resume({ projectId: f.projectId, decisionId: req.ev.decisionId, userId: f.ownerId })
    expect(isActionRefusal(refusedHere) && refusedHere.error).toMatch(/^Backenly isn't running architecture changes for this project right now, so this one can't carry on yet\./)
    // Listed, it runs like any other project.
    await setup({ mutations: true, scheduler: true, allowlist: `another-project,${f.projectId}` })
    expect((await view()).status).toMatchObject({ label: 'In progress' })

    // Runs here, but nothing carries it on: a person may push it on, and only that.
    await setup({ mutations: true, scheduler: false })
    c = await view()
    expect(c).toMatchObject({ status: { label: 'Waiting to start' }, waiting: "This deployment doesn't carry architecture changes on by itself.", actions: { pause: false, resume: true } })
    // Carried on by itself: it can be paused, and there is nothing to resume.
    await setup({ mutations: true, scheduler: true })
    c = await view()
    expect(c).toMatchObject({ status: { label: 'In progress' }, actions: { pause: true, resume: false } })
    expect(c).not.toHaveProperty('waiting')
    expect(c.headline).toBe('Backenly is changing your Orders architecture.')
  })
})

// ── A step that does not finish ──────────────────────────────────────────────

describe('a step that does not finish', () => {
  let f: Fixture
  let decisionId = ''

  beforeAll(async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
    f = await buildProject('step-fails')
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    decisionId = req.ev.decisionId
    const r = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    expect(r).toMatchObject({ ok: true, state: 'backfilling' })
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is told by what it was doing, never by a job id or the database\'s words, and a vanished job is not the table changing', async () => {
    // The copy's background job disappears before it ran: not drift, a step that did not finish.
    await prisma.backgroundJob.deleteMany({ where: { projectId: f.projectId, type: 'evolution_backfill' } })
    const r = await advance({ projectId: f.projectId, decisionId })
    expect(r.state).toBe('failed')
    const s = await stateOf(f.projectId, decisionId)
    expect(s.stoppedBecause).toBe('copying the existing refund data into order_refunds did not finish')
    expect(s.headline).toBe(
      'The change to orders stopped: copying the existing refund data into order_refunds did not finish. Your app works as before; you can resume or undo it.',
    )
    expect(s.headline).not.toMatch(/job|step \d|backfill|no longer exists|table changed/)
    // The executor's own account stays in the history.
    const stopped = (await decisionTrail(f.projectId, decisionId)).filter(e => e.record.state === 'failed').at(-1)!
    expect((stopped.record.payload as any).haltReason).toMatch(/background job .* no longer exists/)
    // A failure, where the feed says what happened.
    const said = (await buildTrustReport(f.projectId)).recentActivity.find(a => a.summary === s.headline)
    expect(said).toMatchObject({ kind: 'failed' })
    // In the queue, the same plain reason, asking resume or undo.
    const waiting = (await requestsOf(f.projectId)).filter(x => x.status === 'pending_approval')
    expect(waiting.map(x => [x.ev.ask, x.ev.stoppedBecause])).toEqual([['resume_or_undo', s.stoppedBecause]])
  })

  it('"not now" leaves the change as it is and hands the decision to the card', async () => {
    const [req] = (await requestsOf(f.projectId)).filter(x => x.status === 'pending_approval')
    const r = await dismissRequest({ projectId: f.projectId, findingId: req.id, userId: f.ownerId })
    expect(r).toMatchObject({ ok: true, state: 'failed' })
    expect((await stateOf(f.projectId, decisionId)).state).toBe('failed')
    expect((await requestsOf(f.projectId)).filter(x => x.status === 'pending_approval')).toHaveLength(0)
    const c = (await listChanges(f.projectId)).find(x => x.decisionId === decisionId)!
    expect(c).not.toHaveProperty('findingId')
    expect(c.actions).toMatchObject({ resume: true, undo: true, pause: false })
    expect(c.headline).toBe('The change to your Orders architecture stopped.')
    expect(c.detail).toBe('It stopped because copying the existing refund data into order_refunds did not finish. Your app works as before.')
  })
})

// ── Self-healing while a change works on its table ───────────────────────────

describe("Backenly's own repairs wait while an architecture change carries itself out", () => {
  let f: Fixture
  let decisionId = ''
  let version = ''
  let approved = ''
  const saved = { reconciler: process.env.ENABLE_AUTONOMY_RECONCILER, live: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION }
  /** A background job of the project, last updated at `at`. */
  const jobAt = async (type: string, payload: Record<string, unknown>, at: Date) => {
    const job = await prisma.backgroundJob.create({ data: { projectId: f.projectId, type, status: 'completed', payload: payload as object } })
    await prisma.$executeRawUnsafe(`UPDATE background_jobs SET "updatedAt" = $1 WHERE id = $2`, at, job.id)
    return job
  }
  const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value))
  /** A finding as its detector raises it. */
  const planted = (type: string, details: Record<string, unknown>) =>
    prisma.healthFinding.create({ data: { projectId: f.projectId, type, severity: 'critical', category: 'security', source: 'test', details: details as object } })
  const autonomously = (findingId: string) => runAutoFix(findingId, f.projectId, { actor: { kind: 'autonomous', loop: 'reconciler' } })
  const fingerprint = async () => basisFingerprint((await readTableFacts(workspaceOn(prisma, f.schema), 'orders'))!)

  beforeAll(async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    // Repairs applied on their own, as on staging.
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'
    f = await buildProject('holds')
    await proposeWhereItRuns(f.projectId)
    const [req] = await requestsOf(f.projectId)
    decisionId = req.ev.decisionId
    version = req.ev.planVersion
    const a = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    if (isApprovalRefusal(a)) throw new Error(a.error)
    expect(a.state).toBe('backfilling')
    approved = await fingerprint()
  }, 180_000)
  afterAll(async () => {
    restore('ENABLE_AUTONOMY_RECONCILER', saved.reconciler)
    restore('ENABLE_AUTONOMY_LIVE_EXECUTION', saved.live)
    await dropProject(f)
  }, 60_000)

  it('holds the repair that stopped the change on staging, leaving the finding open and the table as approved', async () => {
    // unprotected_user_data on orders: Backenly's own-rows policies, added twenty seconds after the approval.
    const host = await planted('unprotected_user_data', { tableName: 'orders' })
    const r = await autonomously(host.id)
    expect(r.outcome).toBe('held')
    expect(r.message).toMatch(/architecture change to orders is working on orders/)
    expect((await prisma.healthFinding.findUniqueOrThrow({ where: { id: host.id } })).status).toBe('open')
    expect(await fingerprint()).toBe(approved)
  })

  it('holds the repair of the new table too, and a whole self-healing pass leaves both tables as approved', async () => {
    // orphan_table on order_refunds: the half-built table, registered before the ladder's own step.
    const satellite = await planted('orphan_table', { tableName: 'order_refunds' })
    expect((await autonomously(satellite.id)).outcome).toBe('held')
    expect(await architectureHold(f.projectId, `"${f.schema}"."order_refunds"`)).toMatch(/working on order_refunds/)
    await runReconcilerLive(f.projectId)
    expect(await fingerprint()).toBe(approved)
    expect((await prisma.table.findMany({ where: { projectId: f.projectId, name: 'order_refunds' } })).length).toBe(0)
  })

  it('finds the table the way the repair does, and holds a repair naming none that may act on every table', async () => {
    expect(repairedTable('unprotected_user_data', { tableName: 'orders' })).toBe('orders')
    expect(repairedTable('unprotected_user_data', { location: 'orders' })).toBe('orders')
    expect(repairedTable('missing_fk_index', { table: 'orders', column: 'user_id' })).toBe('orders')
    expect(repairedTable('missing_rls_orders', {})).toBe('orders')
    expect(repairedTable('infra_hot_table_order_refunds', {})).toBe('order_refunds')
    expect(repairedTable('unprotected_user_data', {})).toBeNull()
    // FIX_REALTIME with no table installs its trigger on every table, orders included.
    expect(await repairHold(f.projectId, { table: null, action: 'FIX_REALTIME' })).toMatch(/working on this project's tables, and this repair names none/)
    expect(await repairHold(f.projectId, { table: null, action: 'CREATE_INDEX' })).toBeNull()
    expect(await repairHold(f.projectId, { table: null, action: null, tablelessWaits: true })).toMatch(/names none/)
    expect(await repairHold(f.projectId, { table: 'customers', action: 'FIX_REALTIME' })).toBeNull()
  })

  it("keeps holding while the project's changes move: a ladder holding its lock, here or elsewhere, or another of their jobs", async () => {
    const later = new Date(Date.now() + HOLD_LAPSES_AFTER_MS + 60_000)
    expect(await architectureHold(f.projectId, 'orders', later)).toBeNull()
    // A ladder running in this process...
    const gate: { release?: () => void } = {}
    const ladder = withMaintenanceSingleFlight(f.projectId, () => new Promise<void>(resolve => { gate.release = resolve }))
    for (let i = 0; i < 100 && !gate.release; i++) await new Promise(resolve => setTimeout(resolve, 20))
    try {
      expect(await architectureHold(f.projectId, 'orders', later)).toMatch(/working on orders/)
    } finally {
      gate.release!()
      await ladder
    }
    // ...or in another, seen in pg_locks: the lock is its session's ('main', lib/autonomy/maintenance/single-flight.ts).
    const elsewhere = new Client({ connectionString: process.env.DATABASE_URL })
    await elsewhere.connect()
    try {
      await elsewhere.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [0x6d61696e, projectToLockKey(f.projectId)])
      expect(await architectureHold(f.projectId, 'orders', later)).toMatch(/working on orders/)
    } finally {
      await elsewhere.end()
    }
    expect(await architectureHold(f.projectId, 'orders', later)).toBeNull()
    // A batch of its backfill moved since.
    const batch = await jobAt('evolution_backfill', { planVersion: version }, new Date(later.getTime() - 60_000))
    try {
      expect(await architectureHold(f.projectId, 'orders', later)).toMatch(/working on orders/)
    } finally {
      await prisma.backgroundJob.delete({ where: { id: batch.id } })
    }
    // A person's look for changes, or a job of no change at work, moves nothing.
    const look = await jobAt('evolution_assess', {}, new Date(later.getTime() - 60_000))
    const stranger = await jobAt('evolution_backfill', { planVersion: 'not-a-change-at-work' }, new Date(later.getTime() - 60_000))
    try {
      expect(await architectureHold(f.projectId, 'orders', later)).toBeNull()
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { id: { in: [look.id, stranger.id] } } })
    }
  })

  it('holds nothing for a change that waits on a person or stopped moving, and nothing else', async () => {
    expect(await architectureHold(f.projectId, 'orders')).toMatch(/working on orders/)
    // A deployment that does not carry changes on by itself: the change waits for a person to resume it.
    process.env.ENABLE_EVOLUTION_SCHEDULER = 'false'
    try {
      expect(await architectureHold(f.projectId, 'orders')).toBeNull()
    } finally {
      process.env.ENABLE_EVOLUTION_SCHEDULER = 'true'
    }
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'false'
    try {
      expect(await architectureHold(f.projectId, 'orders')).toBeNull()
    } finally {
      process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    }
    // Three hours with no transition, no job of its own and no ladder running.
    expect(await architectureHold(f.projectId, 'orders', new Date(Date.now() + HOLD_LAPSES_AFTER_MS + 60_000))).toBeNull()
    expect(await architectureHold(f.projectId, 'customers')).toBeNull()
    expect(await architectureHold(f.projectId, null)).toBeNull()
  })

  it('lets the backfill finish on the table exactly as approved; then the held repair runs and does change it', async () => {
    // The copy ran against the same table the owner approved: no "changed shape".
    expect((await drain(f.projectId)).every(x => !x.refusal)).toBe(true)
    expect((await advance({ projectId: f.projectId, decisionId })).state).toBe('observing')
    expect(await architectureHold(f.projectId, 'orders')).toBeNull()
    expect(await architectureHold(f.projectId, 'order_refunds')).toBeNull()
    // What the hold kept off the table was real: let through, the same repair changes it.
    const before = await fingerprint()
    const r = await autonomously((await planted('unprotected_user_data', { tableName: 'orders' })).id)
    expect(['auto_fixed', 'applied_unverified']).toContain(r.outcome)
    expect(await fingerprint()).not.toBe(before)
  })

  it('lets go of an undo that stopped, whatever else the project does', async () => {
    // An undo that crashed after claiming the change: nothing but its own undo carries it on.
    const d = summarizeDecisions(await readMemory(f.projectId)).find(x => x.decisionId === decisionId)!
    await remember({
      projectId: f.projectId,
      record: {
        v: 1, decisionId, concernKey: d.concernKey, proposalKey: d.proposalKey, planId: d.planId, planVersion: d.planVersion,
        primitive: d.primitive, subject: d.subject, event: 'transition', state: 'rolling_back', from: 'observing',
      },
      milestone: false,
      sentence: 'Undoing the change (a crash, in this test).',
    })
    expect(await architectureHold(f.projectId, 'orders')).toMatch(/working on orders/)
    const later = new Date(Date.now() + HOLD_LAPSES_AFTER_MS + 60_000)
    expect(await architectureHold(f.projectId, 'orders', later)).toBeNull()
    // Another change's backfill moving, or a ladder holding the project's lock, does not carry it.
    const other = await jobAt('evolution_backfill', { planVersion: 'another-change' }, new Date(later.getTime() - 60_000))
    const gate: { release?: () => void } = {}
    const ladder = withMaintenanceSingleFlight(f.projectId, () => new Promise<void>(resolve => { gate.release = resolve }))
    for (let i = 0; i < 100 && !gate.release; i++) await new Promise(resolve => setTimeout(resolve, 20))
    try {
      expect(await architectureHold(f.projectId, 'orders', later)).toBeNull()
    } finally {
      gate.release!()
      await ladder
      await prisma.backgroundJob.delete({ where: { id: other.id } })
    }
    // Its own undo moving does.
    const undoing = await jobAt('evolution_undo', { decisionId }, new Date(later.getTime() - 60_000))
    try {
      expect(await architectureHold(f.projectId, 'orders', later)).toMatch(/working on orders/)
    } finally {
      await prisma.backgroundJob.delete({ where: { id: undoing.id } })
    }
  })
})
