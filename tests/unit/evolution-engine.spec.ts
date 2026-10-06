/**
 * THE ARCHITECTURE EVOLUTION ENGINE'S RULES, WITHOUT A DATABASE
 * =============================================================
 *
 * The engine's judgement — what level an opportunity reaches, which lifecycle
 * transitions exist, what needs a person, when a change is stable, whether it
 * helped — is pure, and is held here input by input. Most of what this pins is
 * what must NOT happen:
 *
 *   - churn, size or traffic never raising a level
 *   - "do nothing" being an answer the engine gives and explains
 *   - a change being called a success before it was observed
 *   - an improvement being claimed without the numbers for it
 *   - a semantic redesign or an irreversible step ever being runnable
 */

import {
  assertTransition,
  canTransition,
  canUndoFrom,
  InvalidTransition,
  LIFECYCLE_STATES,
  userFacingStatus,
  type LifecycleState,
} from '@/lib/evolution-engine/lifecycle'
import { classifyOpportunity, explainNoChange, type OpportunitySignals } from '@/lib/evolution-engine/levels'
import {
  approvalRequirement,
  DEFAULT_POLICY,
  mayResumeUnattended,
  riskOf,
  shouldAutoRollback,
  type PlanTraits,
} from '@/lib/evolution-engine/policy'
import { observationVerdict, CONSISTENCY_SIGNAL } from '@/lib/evolution-engine/observe'

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('the lifecycle', () => {
  const HAPPY: LifecycleState[] = [
    'proposed', 'rehearsing', 'rehearsed', 'awaiting_approval', 'approved',
    'expanding', 'backfilling', 'verifying', 'cutover', 'observing', 'stable',
  ]

  it('walks the whole happy path one valid step at a time', () => {
    for (let i = 1; i < HAPPY.length; i++) expect(canTransition(HAPPY[i - 1], HAPPY[i])).toBe(true)
  })

  it.each([
    ['proposed', 'expanding'],      // never skip rehearsal and consent
    ['rehearsed', 'expanding'],     // never skip consent
    ['awaiting_approval', 'expanding'],
    ['cutover', 'stable'],          // never skip observation
    ['expanding', 'stable'],
    ['stable', 'expanding'],
    ['rolled_back', 'expanding'],   // a reversed change starts over, as a proposal
    ['rolling_back', 'approved'],   // an undo never turns back into consent
    ['rolling_back', 'awaiting_approval'],
  ] as Array<[LifecycleState, LifecycleState]>)('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false)
    expect(() => assertTransition(from, to)).toThrow(InvalidTransition)
  })

  it('lets every applied or stopped change be undone, and nothing that never touched the schema', () => {
    for (const s of ['expanding', 'backfilling', 'verifying', 'cutover', 'observing', 'stable', 'blocked', 'failed'] as LifecycleState[]) {
      expect(canUndoFrom(s)).toBe(true)
      expect(canTransition(s, 'rolling_back')).toBe(true)
    }
    for (const s of ['proposed', 'rehearsing', 'rehearsed', 'awaiting_approval', 'approved', 'rolled_back'] as LifecycleState[]) {
      expect(canUndoFrom(s)).toBe(false)
    }
  })

  it('hands an undo refused before it touched anything back to exactly where it was', () => {
    for (const s of ['expanding', 'backfilling', 'verifying', 'cutover', 'observing', 'stable', 'blocked', 'failed'] as LifecycleState[]) {
      expect(canTransition('rolling_back', s)).toBe(true)
    }
  })

  it('lets a blocked change resume only after a person acted, at the stage that stopped', () => {
    for (const s of ['expanding', 'backfilling', 'verifying', 'cutover', 'observing'] as LifecycleState[]) {
      expect(canTransition(s, 'blocked')).toBe(true)
      expect(canTransition('blocked', s)).toBe(true)
    }
    expect(canTransition('blocked', 'stable')).toBe(false)
  })

  it('shows people outcomes, never internal stages', () => {
    const labels = LIFECYCLE_STATES.map(s => userFacingStatus(s).label.toLowerCase())
    for (const internal of ['rehears', 'expand', 'backfill', 'cutover']) {
      expect(labels.some(l => l.includes(internal))).toBe(false)
    }
    expect(userFacingStatus('awaiting_approval').tone).toBe('attention')
    expect(userFacingStatus('observing').label).toMatch(/watching the result/)
    expect(userFacingStatus('stable').label).toBe('Done')
  })
})

// ── Levels ───────────────────────────────────────────────────────────────────

describe('opportunity levels', () => {
  const base: OpportunitySignals = {
    cohesive: true,
    contradicted: false,
    partialEvidence: false,
    separable: true,
    counterproductive: null,
    measuredCost: 0,
    emergingPressure: 0,
    executable: true,
    prior: { kind: 'none' },
    newEvidenceSincePrior: false,
  }

  it('cannot see churn, size or traffic', () => {
    // The signals type has no field for them; a refactor adding one has to
    // change this assertion.
    expect(Object.keys(base).sort()).toEqual([
      'cohesive', 'contradicted', 'counterproductive', 'emergingPressure', 'executable', 'measuredCost',
      'newEvidenceSincePrior', 'partialEvidence', 'prior', 'separable',
    ])
  })

  it('watches a cohesive group that costs nothing', () => {
    expect(classifyOpportunity(base).level).toBe('watching')
  })

  it('recommends before damage, from emerging pressure alone, without proposing to run anything', () => {
    expect(classifyOpportunity({ ...base, emergingPressure: 1 })).toMatchObject({ level: 'recommendation_only' })
  })

  it('proposes an executable change only on a measured cost and an executable plan', () => {
    expect(classifyOpportunity({ ...base, measuredCost: 1 }).level).toBe('executable_proposal')
    expect(classifyOpportunity({ ...base, measuredCost: 1, executable: false, notExecutableBecause: 'needs an unpivot' }))
      .toMatchObject({ level: 'recommendation_only', reason: expect.stringMatching(/needs an unpivot/) })
  })

  it('says "no change" when measured evidence contradicts, or the change would cost more than it saves', () => {
    expect(classifyOpportunity({ ...base, measuredCost: 3, contradicted: true }).level).toBe('no_change_recommended')
    expect(classifyOpportunity({ ...base, measuredCost: 3, counterproductive: 'nearly every row carries it' }))
      .toEqual({ level: 'no_change_recommended', reason: 'nearly every row carries it' })
  })

  it('watches, rather than proposes, when the evidence is only partial', () => {
    expect(classifyOpportunity({ ...base, cohesive: false, partialEvidence: true, measuredCost: 5 }).level).toBe('watching')
    expect(classifyOpportunity({ ...base, cohesive: false, measuredCost: 5 }).level).toBe('no_change_recommended')
  })

  it('does not re-propose a change that was undone, until something new is measured', () => {
    const prior = { kind: 'reversed' as const, regressed: true, at: '2026-09-01T00:00:00Z' }
    expect(classifyOpportunity({ ...base, measuredCost: 1, prior }).level).toBe('no_change_recommended')
    expect(classifyOpportunity({ ...base, measuredCost: 1, prior, newEvidenceSincePrior: true }).level).toBe('executable_proposal')
    // An owner pressing undo is a "no" as well: held until something new is measured.
    expect(classifyOpportunity({ ...base, measuredCost: 1, prior: { ...prior, regressed: false } })).toMatchObject({
      level: 'no_change_recommended',
      reason: expect.stringMatching(/you undid it/),
    })
    expect(
      classifyOpportunity({ ...base, measuredCost: 1, prior: { ...prior, regressed: false }, newEvidenceSincePrior: true }).level,
    ).toBe('executable_proposal')
    expect(classifyOpportunity({ ...base, measuredCost: 1, prior: { kind: 'in_effect', at: 'x' } }).level).toBe('no_change_recommended')
  })

  it('respects an owner\'s "no" until something new is measured', () => {
    const prior = { kind: 'declined' as const, at: '2026-09-01T00:00:00Z' }
    expect(classifyOpportunity({ ...base, measuredCost: 1, prior })).toMatchObject({
      level: 'no_change_recommended',
      reason: expect.stringMatching(/you declined this change/),
    })
    expect(classifyOpportunity({ ...base, measuredCost: 1, prior, newEvidenceSincePrior: true }).level).toBe('executable_proposal')
  })

  it('explains leaving a busy, big, frequently changed table alone', () => {
    const text = explainNoChange({ subject: 'orders', changesInWindow: 9, windowDays: 90, rows: 2_000_000, requests: 80_000, notes: [] })!
    expect(text).toMatch(/orders changed 9 times in the last 90 days; frequent change is what active development looks like/)
    expect(text).toMatch(/size alone is not a reason to split a table/)
    expect(text).toMatch(/traffic alone is not a reason to restructure/)
    expect(text).toMatch(/No structural change recommended\.$/)
  })

  it('says nothing about a quiet table', () => {
    expect(explainNoChange({ subject: 'tags', changesInWindow: 1, windowDays: 90, rows: 40, requests: 10, notes: [] })).toBeNull()
  })
})

// ── Policy ───────────────────────────────────────────────────────────────────

describe('policy', () => {
  const traits = (over: Partial<PlanTraits> = {}): PlanTraits => ({
    changeClass: 'structural',
    reversible: true,
    authorizationRehearsed: true,
    rungs: [
      { tier: 0, humanOnly: false, mutates: false },
      { tier: 1, humanOnly: false, mutates: true },
      { tier: 2, humanOnly: false, mutates: true },
      { tier: 3, humanOnly: true, mutates: true },
    ],
    ...over,
  })

  it('always needs a person for anything that changes the live schema', () => {
    expect(approvalRequirement(traits())).toMatchObject({ required: true, humanOnly: false })
  })

  it('never lets software run a semantic redesign or an irreversible change, approved or not', () => {
    expect(approvalRequirement(traits({ changeClass: 'semantic' }))).toMatchObject({ required: true, humanOnly: true })
    expect(approvalRequirement(traits({ reversible: false }))).toMatchObject({ required: true, humanOnly: true })
  })

  it('rates risk honestly — unrehearsed access lifts it', () => {
    expect(riskOf(traits())).toBe('medium')
    expect(riskOf(traits({ authorizationRehearsed: false }))).toBe('high')
    expect(riskOf(traits({ changeClass: 'semantic' }))).toBe('high')
  })

  it('resumes unattended only with consent, both deployment switches, and autonomy on', () => {
    const ok = { consented: true, mutationsEnabled: true, schedulerEnabled: true, autonomyOff: false }
    expect(mayResumeUnattended(ok)).toBe(true)
    for (const k of ['consented', 'mutationsEnabled', 'schedulerEnabled'] as const) {
      expect(mayResumeUnattended({ ...ok, [k]: false })).toBe(false)
    }
    expect(mayResumeUnattended({ ...ok, autonomyOff: true })).toBe(false)
  })

  it('does not undo on regression by default, and never when undo could lose a write', () => {
    expect(DEFAULT_POLICY.autoRollbackOnRegression).toBe(false)
    expect(shouldAutoRollback(DEFAULT_POLICY, true)).toBe(false)
    expect(shouldAutoRollback({ ...DEFAULT_POLICY, autoRollbackOnRegression: true }, false)).toBe(false)
    expect(shouldAutoRollback({ ...DEFAULT_POLICY, autoRollbackOnRegression: true }, true)).toBe(true)
  })
})

// ── Observation ──────────────────────────────────────────────────────────────

describe('observation', () => {
  const cutoverAt = new Date('2026-10-01T00:00:00Z')
  const at = (h: number) => new Date(cutoverAt.getTime() + h * 3_600_000)
  const ok = (h: number) => ({
    at: at(h).toISOString(),
    signals: [{ name: CONSISTENCY_SIGNAL, status: 'ok' as const, detail: 'agree' }],
  })

  it('does not call a change stable before the window has elapsed', () => {
    const v = observationVerdict({ passes: [ok(1), ok(2), ok(3)], cutoverAt, now: at(5), policy: DEFAULT_POLICY })
    expect(v.status).toBe('continue')
  })

  it('needs enough passes, not just enough time', () => {
    const v = observationVerdict({ passes: [ok(25)], cutoverAt, now: at(25), policy: DEFAULT_POLICY })
    expect(v).toMatchObject({ status: 'continue', reason: '1 of 3 observation passes taken' })
  })

  it('becomes stable after the window, enough passes and a measured agreement', () => {
    const v = observationVerdict({ passes: [ok(1), ok(12), ok(25)], cutoverAt, now: at(25), policy: DEFAULT_POLICY })
    expect(v.status).toBe('stable')
  })

  it('will not let a pass that could not check consistency declare stability', () => {
    const blind = { at: at(25).toISOString(), signals: [{ name: CONSISTENCY_SIGNAL, status: 'unavailable' as const, detail: 'timeout' }] }
    expect(observationVerdict({ passes: [ok(1), ok(12), blind], cutoverAt, now: at(25), policy: DEFAULT_POLICY }).status).toBe('continue')
  })

  it('stops on any regression, at any point in the window', () => {
    const bad = { at: at(2).toISOString(), signals: [{ name: 'authorization failures', status: 'regressed' as const, detail: '403s tripled' }] }
    const v = observationVerdict({ passes: [ok(1), bad, ok(25), ok(26)], cutoverAt, now: at(27), policy: DEFAULT_POLICY })
    expect(v).toMatchObject({ status: 'regressed', reason: expect.stringMatching(/403s tripled/) })
  })
})
