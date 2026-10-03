/**
 * PHASES 7 AND 8 — the reader switch, the observation, and the learning bound
 * ===========================================================================
 *
 * Phase 7 moves readers and watches what happens. Phase 8 asks whether the
 * repair helped. Both are mostly judgement over measured numbers, so both are
 * tested as pure functions here; the parts that touch a database are exercised
 * in tests/integration/maintenance-phase6b.spec.ts.
 *
 * The properties, and why each is the one that matters:
 *
 *   zero traffic is UNKNOWN          a quiet project has a perfect error rate
 *   both windows must have traffic   a comparison needs two sides
 *   errors and latency are separate  halving one while tripling the other is a
 *                                    regression, and one score would hide it
 *   the unobservable list is fixed   "no readers found" and "cannot see any
 *                                    readers" are different facts
 *   learning cannot reach detection  a system that learns a detector is noisy
 *                                    stops detecting, and the symptom is silence
 */

import {
  ERROR_RATE_TOLERANCE,
  judge,
  LATENCY_TOLERANCE,
  MIN_SAMPLE,
  type TrafficWindow,
} from '@/lib/autonomy/maintenance/observe'
import {
  applyAdjustment,
  judgeOutcome,
  MAX_PRIOR_STEP,
  MIN_INCIDENTS,
  PRIOR_CEILING,
  PRIOR_FLOOR,
  remedyAdjustment,
  type SubsystemWindow,
} from '@/lib/autonomy/maintenance/outcome'
import { columnReferenceCount, UNOBSERVABLE_READERS } from '@/lib/autonomy/maintenance/readers'

const traffic = (over: Partial<TrafficWindow> = {}): TrafficWindow => ({
  requests: 200,
  errors: 2,
  errorRate: 0.01,
  p95DurationMs: 100,
  functionRuns: 10,
  functionFailures: 0,
  ...over,
})

// ── Phase 7: the observation window ──────────────────────────────────────────

describe('zero traffic is never "stable"', () => {
  it('reports insufficient_sample when nothing happened after the switch', () => {
    const r = judge(traffic(), traffic({ requests: 0, errors: 0, errorRate: 0, p95DurationMs: null }))
    expect(r.outcome).toBe('insufficient_sample')
    expect(r.shouldRevert).toBe(false)
    expect(r.reason).toMatch(/Nothing was demonstrated/)
  })

  it('reports insufficient_sample when nothing happened BEFORE it either', () => {
    // A comparison needs two sides. Plenty of traffic after a switch proves
    // nothing if there was none before it to compare against.
    const r = judge(traffic({ requests: 0, errors: 0, errorRate: 0, p95DurationMs: null }), traffic())
    expect(r.outcome).toBe('insufficient_sample')
  })

  it('does not call a perfect-but-empty window an improvement', () => {
    // The failure this guards: a quiet project has a 0% error rate, and reading
    // that as success retains a switch that was never exercised — most
    // confidently for the projects where the evidence is weakest.
    const empty = traffic({ requests: 0, errors: 0, errorRate: 0, p95DurationMs: null })
    expect(judge(empty, empty).outcome).toBe('insufficient_sample')
  })

  it('needs the sample on BOTH sides, exactly at the threshold', () => {
    const below = traffic({ requests: MIN_SAMPLE - 1 })
    const at = traffic({ requests: MIN_SAMPLE })
    expect(judge(below, at).outcome).toBe('insufficient_sample')
    expect(judge(at, at).outcome).not.toBe('insufficient_sample')
  })
})

describe('regression is the revert trigger', () => {
  it('reverts when the error rate rises beyond tolerance', () => {
    const r = judge(traffic({ errorRate: 0.01 }), traffic({ errorRate: 0.01 + ERROR_RATE_TOLERANCE + 0.01 }))
    expect(r).toMatchObject({ outcome: 'regressed', shouldRevert: true })
    expect(r.reason).toMatch(/error rate rose/)
  })

  it('reverts when p95 rises beyond tolerance, even with errors unchanged', () => {
    // A switch that moved reads onto an unindexed column shows up here and
    // nowhere else. Averaging the two signals into one score would hide it.
    const r = judge(
      traffic({ p95DurationMs: 100 }),
      traffic({ p95DurationMs: Math.ceil(100 * (1 + LATENCY_TOLERANCE)) + 10 }),
    )
    expect(r).toMatchObject({ outcome: 'regressed', shouldRevert: true })
    expect(r.reason).toMatch(/p95 rose/)
  })

  it('reverts when functions start failing', () => {
    // The most direct symptom of a reader reading the wrong column.
    const r = judge(
      traffic({ functionRuns: 10, functionFailures: 0 }),
      traffic({ functionRuns: 10, functionFailures: 3 }),
    )
    expect(r).toMatchObject({ outcome: 'regressed', shouldRevert: true })
    expect(r.reason).toMatch(/function failures rose/)
  })

  it('does not revert on an improvement or on no change', () => {
    expect(judge(traffic(), traffic()).outcome).toBe('neutral')
    expect(judge(traffic(), traffic()).shouldRevert).toBe(false)

    const better = judge(traffic({ errorRate: 0.10 }), traffic({ errorRate: 0.01 }))
    expect(better).toMatchObject({ outcome: 'improved', shouldRevert: false })
  })

  it('only "regressed" ever sets shouldRevert', () => {
    const cases: Array<[TrafficWindow, TrafficWindow]> = [
      [traffic(), traffic()],
      [traffic({ errorRate: 0.1 }), traffic({ errorRate: 0.01 })],
      [traffic({ requests: 0 }), traffic()],
      [traffic(), traffic({ errorRate: 0.5 })],
    ]
    for (const [b, a] of cases) {
      const r = judge(b, a)
      expect(r.shouldRevert).toBe(r.outcome === 'regressed')
    }
  })
})

// ── Phase 7: the reader inventory's honesty ─────────────────────────────────

describe('the reader inventory does not overstate coverage', () => {
  it('always names consumer classes it cannot enumerate', () => {
    // Returning [] when a query finds nothing would conflate "none" with
    // "cannot see any". On a platform that hands out connection strings and
    // serves PostgREST clients that pick their own columns, the second is the
    // truth and it never becomes the first.
    expect(UNOBSERVABLE_READERS.length).toBeGreaterThan(0)
    expect(UNOBSERVABLE_READERS.map(u => u.kind)).toEqual(
      expect.arrayContaining(['postgrest_client', 'direct_database_access', 'hand_written_sql']),
    )
    for (const u of UNOBSERVABLE_READERS) expect(u.why.length).toBeGreaterThan(20)
  })

  it('counts whole-word column references only', () => {
    // `status` must not match `status_code`, or a switch would rewrite an
    // unrelated identifier inside a customer's function.
    expect(columnReferenceCount('row.status_code + row.status', 'status')).toBe(1)
    expect(columnReferenceCount('const s = r.status; log(r.status)', 'status')).toBe(2)
    expect(columnReferenceCount('nothing here', 'status')).toBe(0)
  })

  it('escapes a column name rather than treating it as a pattern', () => {
    expect(columnReferenceCount('a.b and axb', 'a.b')).toBe(1)
  })
})

// ── Phase 8: measurement, and the boundary on what it may change ────────────

const sub = (over: Partial<SubsystemWindow> = {}): SubsystemWindow => ({
  incidents: 10,
  repairs: 1,
  traffic: traffic(),
  ...over,
})

describe('outcome measurement', () => {
  it('refuses to conclude from too few incidents', () => {
    const r = judgeOutcome(sub({ incidents: MIN_INCIDENTS - 1 }), sub({ incidents: 0 }))
    expect(r.outcome).toBe('insufficient_sample')
    expect(r.reason).toMatch(/quiet week/)
  })

  it('reports improved when incidents fall materially', () => {
    expect(judgeOutcome(sub({ incidents: 10 }), sub({ incidents: 2 })).outcome).toBe('improved')
  })

  it('reports regressed when incidents rise materially', () => {
    expect(judgeOutcome(sub({ incidents: 10 }), sub({ incidents: 20 })).outcome).toBe('regressed')
  })

  it('does not call it improved when repairs rose', () => {
    // A remedy being re-applied is maintenance masking a problem, not fixing
    // it. "Failed treatment must never hide disease."
    const r = judgeOutcome(sub({ incidents: 10, repairs: 1 }), sub({ incidents: 2, repairs: 6 }))
    expect(r.outcome).not.toBe('improved')
  })

  it('reports regressed when repairs rise without incidents falling', () => {
    const r = judgeOutcome(sub({ incidents: 10, repairs: 1 }), sub({ incidents: 10, repairs: 5 }))
    expect(r).toMatchObject({ outcome: 'regressed' })
    expect(r.reason).toMatch(/re-applied rather than working/)
  })
})

describe('learning may only move a prior', () => {
  it('produces no adjustment for neutral or insufficient evidence', () => {
    // Most measurements should change nothing. A learner that always moves
    // something is fitting noise.
    expect(remedyAdjustment('h', judgeOutcome(sub(), sub()))).toBeNull()
    expect(remedyAdjustment('h', judgeOutcome(sub({ incidents: 1 }), sub()))).toBeNull()
  })

  it('carries a hypothesis id, a bounded delta and a reason, and nothing else', () => {
    const adj = remedyAdjustment('duplicated_lifecycle_state', judgeOutcome(sub({ incidents: 10 }), sub({ incidents: 1 })))!
    expect(Object.keys(adj).sort()).toEqual(['hypothesisId', 'priorDelta', 'reason'])
    // There is nowhere in this type to put a detector threshold, an approval
    // requirement or a tier. That is the boundary, enforced by the type rather
    // than by a comment asking callers to be careful.
    expect(Math.abs(adj.priorDelta)).toBeLessThanOrEqual(MAX_PRIOR_STEP)
  })

  it('clamps a prior however many measurements agree', () => {
    // A prior driven to 0 is a remedy never proposed again — a detection
    // decision reached by the back door.
    let prior = 0.5
    const improved = judgeOutcome(sub({ incidents: 10 }), sub({ incidents: 1 }))
    for (let i = 0; i < 100; i++) prior = applyAdjustment(prior, remedyAdjustment('h', improved))
    expect(prior).toBeLessThanOrEqual(PRIOR_CEILING)

    let low = 0.5
    const regressed = judgeOutcome(sub({ incidents: 10 }), sub({ incidents: 30 }))
    for (let i = 0; i < 100; i++) low = applyAdjustment(low, remedyAdjustment('h', regressed))
    expect(low).toBeGreaterThanOrEqual(PRIOR_FLOOR)
    // Non-vacuity: the clamp is what stopped it, not an adjustment of zero.
    expect(low).toBeLessThan(0.5)
  })

  it('leaves the prior untouched when there is no adjustment', () => {
    expect(applyAdjustment(0.42, null)).toBe(0.42)
  })
})
