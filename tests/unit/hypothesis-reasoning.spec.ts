/**
 * The reasoning core decides whether an autonomous system changes production.
 * The tests that matter most are not "does it find the right answer" — they are
 * "does it REFUSE when it should", because that is the behaviour that makes the
 * rest safe to trust.
 */

import {
  applyObservation,
  concludeInvestigation,
  discriminationPower,
  initialState,
  liveHypotheses,
  mayAutoApply,
  selectNextTest,
  falsificationValue,
} from '@/lib/autonomy/hypothesis/reasoning'
import { SYMPTOM_CATALOG, findSymptom } from '@/lib/autonomy/hypothesis/catalog'
import { PROBE_REGISTRY } from '@/lib/autonomy/hypothesis/probes'
import type { DiagnosticTest, Hypothesis } from '@/lib/autonomy/hypothesis/types'

const H = (id: string, prior: number, predicts: Record<string, string | undefined>): Hypothesis => ({
  id,
  statement: `hypothesis ${id}`,
  prior,
  predicts,
  remedy: { summary: 'fix', autoApplicable: false },
})

const T = (id: string, cost: DiagnosticTest['cost'] = 'cheap'): DiagnosticTest => ({
  id,
  description: `test ${id}`,
  cost,
})

describe('discriminationPower', () => {
  it('scores a test that splits the field', () => {
    const hs = [
      { ...H('a', 0.5, { t: 'x' }), confidence: 0.5 },
      { ...H('b', 0.5, { t: 'y' }), confidence: 0.5 },
    ]
    expect(discriminationPower(T('t'), hs)).toBeGreaterThan(0.9)
  })

  it('scores ZERO when every hypothesis predicts the same outcome', () => {
    // The central idea. A test everyone agrees about cannot change what you
    // believe, however thorough it looks — running it is how a system produces
    // pages of diagnostics and concludes nothing.
    const hs = [
      { ...H('a', 0.5, { t: 'same' }), confidence: 0.5 },
      { ...H('b', 0.5, { t: 'same' }), confidence: 0.5 },
    ]
    expect(discriminationPower(T('t'), hs)).toBe(0)
  })

  it('scores ZERO when no hypothesis predicts on the test', () => {
    // Silence is not a distinguishing answer. applyObservation leaves a silent
    // hypothesis untouched whatever the outcome, so scoring silence as
    // discrimination would make the selector choose tests that provably cannot
    // change what is believed.
    const hs = [
      { ...H('a', 0.5, {}), confidence: 0.5 },
      { ...H('b', 0.5, {}), confidence: 0.5 },
    ]
    expect(discriminationPower(T('t'), hs)).toBe(0)
  })

  it('scores zero for a lone predictor, leaving refutation to falsificationValue', () => {
    // Kept separate on purpose: if discrimination quietly absorbed the
    // single-predictor case, a genuine failure of the falsification path would
    // be masked rather than surfaced.
    const hs = [
      { ...H('a', 0.5, { t: 'x' }), confidence: 0.5 },
      { ...H('b', 0.5, {}), confidence: 0.5 },
    ]
    expect(discriminationPower(T('t'), hs)).toBe(0)
    expect(falsificationValue(T('t'), hs)).toBeGreaterThan(0)
  })

  it('scores zero with fewer than two hypotheses', () => {
    expect(discriminationPower(T('t'), [{ ...H('a', 1, { t: 'x' }), confidence: 1 }])).toBe(0)
  })
})

describe('selectNextTest', () => {
  it('never selects a test with no discriminating power, however cheap', () => {
    const state = initialState('s', [H('a', 0.5, { useless: 'same', useful: 'x' }), H('b', 0.5, { useless: 'same', useful: 'y' })])
    const chosen = selectNextTest(state, [T('useless', 'trivial'), T('useful', 'expensive')])
    // Cost must never override decisiveness: a cheap indecisive test is worse
    // than an expensive decisive one.
    expect(chosen?.id).toBe('useful')
  })

  it('breaks ties by cost', () => {
    const state = initialState('s', [H('a', 0.5, { p: 'x', q: 'x' }), H('b', 0.5, { p: 'y', q: 'y' })])
    const chosen = selectNextTest(state, [T('p', 'expensive'), T('q', 'trivial')])
    expect(chosen?.id).toBe('q')
  })

  it('does not re-run a spent test', () => {
    let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('b', 0.5, { t: 'y' })])
    state = applyObservation(state, { testId: 't', outcome: 'x' })
    expect(selectNextTest(state, [T('t')])).toBeNull()
  })

  it('still runs a test they all agree on, because it can refute them all', () => {
    // No discriminating power — but if the outcome is not the one every
    // hypothesis expected, every hypothesis is refuted and the symptom is
    // correctly unexplained. Skipping it would leave an untested consensus
    // standing.
    const state = initialState('s', [H('a', 0.5, { t: 'same' }), H('b', 0.5, { t: 'same' })])
    expect(selectNextTest(state, [T('t')])?.id).toBe('t')
  })

  it('returns null when no hypothesis makes any prediction about the test', () => {
    // Nothing to separate and nothing to refute: the outcome cannot change any
    // belief, so running it is pure cost.
    const state = initialState('s', [H('a', 0.5, { other: 'x' }), H('b', 0.5, { other: 'y' })])
    expect(selectNextTest(state, [T('irrelevant')])).toBeNull()
  })
})

describe('applyObservation', () => {
  it('eliminates a hypothesis whose prediction was contradicted', () => {
    // It made a falsifiable claim and the claim was false. Demoting rather than
    // eliminating would let refuted explanations linger and win on priors.
    let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('b', 0.5, { t: 'y' })])
    state = applyObservation(state, { testId: 't', outcome: 'x' })
    const live = liveHypotheses(state)
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe('a')
  })

  it('leaves a hypothesis that made no prediction untouched', () => {
    // Rewarding silence would let vague hypotheses win by never committing.
    let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('silent', 0.5, {})])
    state = applyObservation(state, { testId: 't', outcome: 'x' })
    const live = liveHypotheses(state)
    expect(live.map(h => h.id).sort()).toEqual(['a', 'silent'])
  })

  it('can eliminate every hypothesis', () => {
    let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('b', 0.5, { t: 'y' })])
    state = applyObservation(state, { testId: 't', outcome: 'something_nobody_predicted' })
    expect(liveHypotheses(state)).toHaveLength(0)
  })
})

describe('concludeInvestigation', () => {
  it('concludes when one hypothesis survives with a clear lead', () => {
    let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('b', 0.5, { t: 'y' })])
    state = applyObservation(state, { testId: 't', outcome: 'x' })
    const v = concludeInvestigation(state, [T('t')])
    expect(v.kind).toBe('conclusive')
  })

  it('reports UNEXPLAINED when the evidence refutes everything', () => {
    // The catalog is incomplete, and saying so is far more useful than
    // promoting whichever survivor made the fewest predictions.
    let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('b', 0.5, { t: 'y' })])
    state = applyObservation(state, { testId: 't', outcome: 'neither' })
    const v = concludeInvestigation(state, [T('t')])
    expect(v.kind).toBe('unexplained')
  })

  it('refuses to conclude when nothing left distinguishes the survivors', () => {
    // The honest dead end. Acting on a diagnosis the evidence never settled is
    // how an autonomous system does damage while appearing decisive. Both
    // hypotheses have already been tested as far as the evidence allows, so
    // nothing remains to run.
    let state = initialState('s', [H('a', 0.5, { t: 'same' }), H('b', 0.5, { t: 'same' })])
    state = applyObservation(state, { testId: 't', outcome: 'same' })
    const v = concludeInvestigation(state, [T('t')])
    expect(v.kind).toBe('ambiguous')
    if (v.kind === 'ambiguous') {
      expect(v.reason).toMatch(/distinguish|consistent/i)
    }
  })

  describe('a hypothesis nothing can settle', () => {
    // `split_brain_writers` is the real case: confirming it needs analysis of
    // function source and this platform has no AST tooling. It may be raised —
    // it is a genuine possibility — but no evidence will ever separate it from
    // anything, so as a blocking runner-up it is a permanent veto rather than
    // uncertainty awaiting a test.
    //
    // Measured in production: the maintenance diagnosis for a project whose
    // covariation probe had CONFIRMED duplicated_lifecycle_state still returned
    // inconclusive, because split_brain_writers survived beside it. Its
    // deciding observation is true of any table with more than two write
    // shapes, so that veto applied to nearly every live project and no plan
    // could be built anywhere.
    const U = (id: string, prior: number, predicts: Record<string, string | undefined>): Hypothesis => ({
      ...H(id, prior, predicts),
      confirmable: false,
    })

    // The unsettlable one makes no prediction about `t`, so the evidence
    // neither credits nor refutes it and it survives untouched beside the
    // leader — which is exactly the production shape: `write_statement_shapes`
    // raised it, and no probe that ran afterwards spoke to it at all.
    it('does not hold a confirmed leader at ambiguous', () => {
      let state = initialState('s', [H('a', 0.7, { t: 'x' }), U('unsettlable', 0.3, {})])
      state = applyObservation(state, { testId: 't', outcome: 'x' })
      const v = concludeInvestigation(state, [T('t')])

      expect(v.kind).toBe('conclusive')
      if (v.kind === 'conclusive') expect(v.hypothesis.id).toBe('a')
    })

    it('is still reported among the candidates rather than hidden', () => {
      // Not vetoing is not the same as not existing. The caveat has to reach
      // the person who can actually settle it.
      let state = initialState('s', [H('a', 0.7, { t: 'x' }), U('unsettlable', 0.3, {})])
      state = applyObservation(state, { testId: 't', outcome: 'x' })
      expect(liveHypotheses(state).map(h => h.id)).toContain('unsettlable')
    })

    it('is never concluded ON, even with the field to itself', () => {
      // The other half of the rule, and the one that keeps this from being a
      // loophole: it may not win by elimination either.
      let state = initialState('s', [U('unsettlable', 0.7, { t: 'x' }), H('a', 0.3, {})])
      state = applyObservation(state, { testId: 't', outcome: 'x' })
      const v = concludeInvestigation(state, [T('t')])
      expect(v.kind).toBe('ambiguous')
    })

    it('does not cap a confirmed leader below the bar with mass nothing can take', () => {
      // The production numbers. duplicated_lifecycle_state was CONFIRMED by its
      // deciding probe and still sat at 0.714 against a bar of 0.85, because
      // split_brain_writers held the other 0.286 and no evidence could ever
      // move it. The bar was unreachable rather than demanding.
      let state = initialState('s', [H('a', 0.25, { t: 'x' }), U('unsettlable', 0.1, { u: 'seen' })])
      state = applyObservation(state, { testId: 'u', outcome: 'seen' })
      state = applyObservation(state, { testId: 't', outcome: 'x' })

      const live = liveHypotheses(state).sort((x, y) => y.confidence - x.confidence)
      expect(live[0].id).toBe('a')
      expect(live[0].confidence).toBeLessThan(0.85)

      const v = concludeInvestigation(state, [T('t'), T('u')])
      expect(v.kind).toBe('conclusive')
      // The reported confidence is the TRUE posterior, not the renormalised
      // one. Nothing downstream is told the system is more certain than it is.
      if (v.kind === 'conclusive') expect(v.confidence).toBeLessThan(0.85)
    })

    it('still refuses when most of the belief is somewhere it cannot look', () => {
      // The guard that keeps the rule above from being plain renormalisation.
      // A leader holding a minority of the posterior would read 1.0 among the
      // settleable hypotheses, which is exactly the case where the evidence is
      // weakest and confidence should not be manufactured.
      let state = initialState('s', [H('a', 0.1, { t: 'x' }), U('unsettlable', 0.9, { u: 'seen' })])
      state = applyObservation(state, { testId: 'u', outcome: 'seen' })
      state = applyObservation(state, { testId: 't', outcome: 'x' })

      const live = liveHypotheses(state).sort((x, y) => y.confidence - x.confidence)
      expect(live[0].id).toBe('unsettlable')

      const v = concludeInvestigation(state, [T('t'), T('u')])
      expect(v.kind).toBe('ambiguous')
    })

    it('leaves an ordinary field completely unaffected', () => {
      // No unconfirmable hypothesis means settleable mass is the whole mass, so
      // the bar is ACT_THRESHOLD exactly as before. The majority requirement is
      // implied by it, since 0.85 > 0.5.
      let state = initialState('s', [H('a', 0.5, { t: 'x' }), H('b', 0.5, { t: 'y' })])
      state = applyObservation(state, { testId: 't', outcome: 'x' })
      expect(concludeInvestigation(state, [T('t')]).kind).toBe('conclusive')

      let weak = initialState('s', [H('c', 0.51, {}), H('d', 0.49, {})])
      expect(concludeInvestigation(weak, []).kind).toBe('ambiguous')
    })

    it('still loses outright when the evidence refutes it', () => {
      let state = initialState('s', [H('a', 0.5, { t: 'x' }), U('unsettlable', 0.5, { t: 'y' })])
      state = applyObservation(state, { testId: 't', outcome: 'x' })
      expect(liveHypotheses(state).map(h => h.id)).not.toContain('unsettlable')
    })
  })

  it('refuses on a bare lead without margin', () => {
    // Two hypotheses a hair apart mean the evidence barely separated them, even
    // if the leader clears the absolute bar.
    const state = initialState('s', [H('a', 0.51, {}), H('b', 0.49, {})])
    const v = concludeInvestigation(state, [])
    expect(v.kind).toBe('ambiguous')
  })
})

describe('falsification before conclusion', () => {
  // Regression. Against the live system this concluded "the schema cache is
  // failing for some other reason" at 87% while PostgREST was HEALTHY — it
  // stopped as soon as confidence cleared the bar, without running the one
  // remaining test that would have refuted the leader and left the symptom
  // correctly unexplained.
  it('does not conclude while a remaining test could refute the leader', () => {
    const hs = [
      H('leader', 0.9, { cheap_check: 'expected' }),
      H('other', 0.1, { unrelated: 'x' }),
    ]
    const state = initialState('s', hs)
    const v = concludeInvestigation(state, [T('cheap_check', 'trivial'), T('unrelated')])
    expect(v.kind).toBe('ambiguous')
    if (v.kind === 'ambiguous') expect(v.reason).toMatch(/refute/i)
  })

  it('concludes once the leader has survived the evidence that could refute it', () => {
    let state = initialState('s', [
      H('leader', 0.9, { cheap_check: 'expected' }),
      H('other', 0.1, { cheap_check: 'different' }),
    ])
    state = applyObservation(state, { testId: 'cheap_check', outcome: 'expected' })
    const v = concludeInvestigation(state, [T('cheap_check')])
    expect(v.kind).toBe('conclusive')
  })

  it('reaches unexplained when the surviving leader is actually refuted', () => {
    // The correct outcome for the live case: the symptom was not occurring.
    let state = initialState('s', [
      H('leader', 0.9, { cheap_check: 'failed' }),
      H('other', 0.1, { cheap_check: 'failed' }),
    ])
    state = applyObservation(state, { testId: 'cheap_check', outcome: 'ok' })
    const v = concludeInvestigation(state, [T('cheap_check')])
    expect(v.kind).toBe('unexplained')
  })

  it('still runs a falsifying test when only one hypothesis survives', () => {
    // With one survivor every test scores zero DISCRIMINATION — there is nobody
    // left to separate it from — so discrimination alone would stop here and
    // conclude on an untested leader.
    let state = initialState('s', [
      H('a', 0.5, { split: 'x', verify: 'expected' }),
      H('b', 0.5, { split: 'y' }),
    ])
    state = applyObservation(state, { testId: 'split', outcome: 'x' })
    expect(liveHypotheses(state)).toHaveLength(1)
    expect(selectNextTest(state, [T('split'), T('verify')])?.id).toBe('verify')
  })
})

describe('mayAutoApply', () => {
  it('permits only a conclusive verdict whose remedy is auto-applicable', () => {
    const auto: Hypothesis = { ...H('a', 1, {}), remedy: { summary: 'r', autoApplicable: true } }
    expect(mayAutoApply({ kind: 'conclusive', hypothesis: auto, confidence: 0.95 })).toBe(true)
    expect(mayAutoApply({ kind: 'conclusive', hypothesis: H('b', 1, {}), confidence: 0.95 })).toBe(false)
    expect(mayAutoApply({ kind: 'ambiguous', candidates: [], reason: '' })).toBe(false)
    expect(mayAutoApply({ kind: 'unexplained', reason: '', observations: [] })).toBe(false)
  })
})

describe('catalog integrity', () => {
  it('implements a probe for every test the catalog references', () => {
    // A referenced-but-unimplemented test silently narrows what can ever be
    // decided, and the loop would look like it is reasoning while starved of
    // the observation that mattered.
    for (const symptom of SYMPTOM_CATALOG) {
      for (const test of symptom.tests) {
        expect(PROBE_REGISTRY[test.id]).toBeDefined()
      }
    }
  })

  it('only predicts tests that its own symptom defines', () => {
    for (const symptom of SYMPTOM_CATALOG) {
      const testIds = new Set(symptom.tests.map(t => t.id))
      for (const h of symptom.hypotheses) {
        for (const predicted of Object.keys(h.predicts)) {
          expect(testIds.has(predicted)).toBe(true)
        }
      }
    }
  })

  it('gives every symptom at least one test that actually discriminates', () => {
    for (const symptom of SYMPTOM_CATALOG) {
      const state = initialState(symptom.id, symptom.hypotheses)
      expect(selectNextTest(state, symptom.tests)).not.toBeNull()
    }
  })

  it('never marks a security-widening remedy auto-applicable', () => {
    // Granting public read on credential tables, or loosening an RLS predicate,
    // must never be something the loop does on its own — those turn a
    // visibility bug into a breach.
    const forbidden = /widen|loosen|grant public|disable rls|relax/i
    for (const symptom of SYMPTOM_CATALOG) {
      for (const h of symptom.hypotheses) {
        if (h.remedy.autoApplicable) {
          expect(h.remedy.summary).not.toMatch(forbidden)
        }
      }
    }
  })

  it('keeps the internal-table denial non-auto-fixable', () => {
    // "Repairing" this one means granting read access to password hashes.
    const s = findSymptom('endpoint_403')!
    const h = s.hypotheses.find(x => x.id === 'internal_table_denied')!
    expect(h.remedy.autoApplicable).toBe(false)
  })

  it('keeps the engine/policy mismatch non-auto-fixable', () => {
    // Forward-migrate and roll-back are opposite, and guessing wrong reproduces
    // the same silent empty tables from the other side.
    const s = findSymptom('empty_reads')!
    const h = s.hypotheses.find(x => x.id === 'engine_policy_mismatch')!
    expect(h.remedy.autoApplicable).toBe(false)
  })
})

describe('end-to-end reasoning on real symptoms', () => {
  it('diagnoses the cross-tenant outage from a dangling registration', () => {
    // The real incident: one unrelated project's schema was dropped while still
    // registered, and every tenant got 503. No rule connects those.
    const s = findSymptom('all_tenants_failing')!
    let state = initialState(s.id, s.hypotheses)
    state = applyObservation(state, { testId: 'database_reachable', outcome: 'reachable' })
    state = applyObservation(state, { testId: 'postgrest_reachable', outcome: 'reachable' })
    state = applyObservation(state, { testId: 'schema_cache_state', outcome: 'failed' })
    state = applyObservation(state, { testId: 'dangling_registrations', outcome: 'present' })

    const v = concludeInvestigation(state, s.tests)
    expect(v.kind).toBe('conclusive')
    if (v.kind === 'conclusive') {
      expect(v.hypothesis.id).toBe('dangling_schema_registration')
      expect(v.hypothesis.remedy.autoApplicable).toBe(true)
    }
  })

  it('separates a stale cache from a genuinely missing table', () => {
    const s = findSymptom('endpoint_404')!
    let stale = initialState(s.id, s.hypotheses)
    stale = applyObservation(stale, { testId: 'table_exists', outcome: 'exists' })
    stale = applyObservation(stale, { testId: 'api_definition', outcome: 'present_enabled' })
    stale = applyObservation(stale, { testId: 'postgrest_visibility', outcome: 'not_in_cache' })
    const v1 = concludeInvestigation(stale, s.tests)
    expect(v1.kind).toBe('conclusive')
    if (v1.kind === 'conclusive') expect(v1.hypothesis.id).toBe('stale_schema_cache')

    let dropped = initialState(s.id, s.hypotheses)
    dropped = applyObservation(dropped, { testId: 'table_exists', outcome: 'missing' })
    const v2 = concludeInvestigation(dropped, s.tests)
    expect(v2.kind).toBe('conclusive')
    if (v2.kind === 'conclusive') {
      expect(v2.hypothesis.id).toBe('table_does_not_exist')
      // Recreating a dropped table changes production structure — never unattended.
      expect(v2.hypothesis.remedy.autoApplicable).toBe(false)
    }
  })

  it('does not blame the engine when the table is simply empty', () => {
    const s = findSymptom('empty_reads')!
    let state = initialState(s.id, s.hypotheses)
    state = applyObservation(state, { testId: 'service_rows', outcome: 'no_rows' })
    const v = concludeInvestigation(state, s.tests)
    expect(v.kind).toBe('conclusive')
    if (v.kind === 'conclusive') expect(v.hypothesis.id).toBe('table_genuinely_empty')
  })

  it('identifies the engine/policy mismatch but declines to act', () => {
    const s = findSymptom('empty_reads')!
    let state = initialState(s.id, s.hypotheses)
    state = applyObservation(state, { testId: 'service_rows', outcome: 'rows_exist' })
    state = applyObservation(state, { testId: 'contract_match', outcome: 'mismatch' })
    const v = concludeInvestigation(state, s.tests)
    expect(v.kind).toBe('conclusive')
    if (v.kind === 'conclusive') {
      expect(v.hypothesis.id).toBe('engine_policy_mismatch')
      expect(mayAutoApply(v)).toBe(false)
    }
  })
})
