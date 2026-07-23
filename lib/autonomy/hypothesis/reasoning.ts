/**
 * PHASE 4 — the reasoning core.
 *
 * Deliberately pure: no database, no network, no clock. Every decision this
 * module makes can be reproduced from its inputs alone, which matters because
 * these decisions end in production changes and "why did it conclude that" has
 * to be answerable months later from a stored trail.
 *
 * The one idea worth stating plainly: a test is worth running only if the
 * hypotheses DISAGREE about its outcome. A test they all predict identically
 * cannot change what you believe, however thorough it looks. Systems that skip
 * this produce impressive diagnostic output and still conclude nothing, because
 * they gathered facts rather than differences.
 */

import {
  ACT_THRESHOLD,
  LEAD_MARGIN,
  type Confidence,
  type DiagnosticTest,
  type Hypothesis,
  type InvestigationState,
  type InvestigationVerdict,
  type Observation,
} from './types'

/**
 * How well a test separates the live hypotheses, 0..1.
 *
 * Partitions hypotheses by predicted outcome and scores the split. An even
 * split is best — it halves the field whatever happens. A test every hypothesis
 * answers the same way scores 0.
 *
 * Hypotheses that make NO prediction are counted as their own group: learning
 * that the outcome contradicts the ones which did predict is still progress.
 */
export function discriminationPower(
  test: DiagnosticTest,
  hypotheses: Array<Hypothesis & { confidence: Confidence }>,
): number {
  if (hypotheses.length < 2) return 0

  // Only hypotheses that PREDICT on this test are grouped. Silence must not be
  // treated as a distinguishing answer: applyObservation leaves a silent
  // hypothesis untouched whatever the outcome, so counting silence as
  // discrimination would make the selector choose tests that provably cannot
  // change the belief state — burning probes on questions nobody answered.
  //
  // A test with a single predicting hypothesis scores 0 here and is still
  // selected when it can refute that hypothesis; that is falsificationValue's
  // job, and keeping the two separate is what stops one from covering for the
  // other's mistakes.
  const groups = new Map<string, number>()
  for (const h of hypotheses) {
    const predicted = h.predicts[test.id]
    if (predicted === undefined) continue
    groups.set(predicted, (groups.get(predicted) ?? 0) + h.confidence)
  }

  if (groups.size < 2) return 0

  // Gini impurity of the confidence-weighted partition, normalised so a perfect
  // even split scores 1. Confidence-weighted rather than by count, because
  // separating two hypotheses nobody believes is not worth a round trip.
  const total = [...groups.values()].reduce((a, b) => a + b, 0)
  if (total <= 0) return 0
  let sumSq = 0
  for (const v of groups.values()) sumSq += (v / total) ** 2
  const impurity = 1 - sumSq
  const maxImpurity = 1 - 1 / groups.size
  return maxImpurity <= 0 ? 0 : impurity / maxImpurity
}

const COST_PENALTY: Record<DiagnosticTest['cost'], number> = {
  trivial: 1,
  cheap: 0.95,
  expensive: 0.8,
}

/**
 * Could this test REFUTE a hypothesis that is still standing?
 *
 * Discrimination alone is not sufficient, and assuming it was produced a wrong
 * answer against the live system: with one survivor left, every test scores
 * zero discrimination — there is nobody to separate it from — so the loop
 * concluded on an unfalsified leader that a cheap remaining test would have
 * eliminated outright.
 *
 * A leading hypothesis is only worth acting on once the evidence that COULD
 * have refuted it has actually been gathered. Confidence measures how the
 * field compares; it says nothing about whether the leader was ever tested.
 */
export function falsificationValue(
  test: DiagnosticTest,
  hypotheses: Array<Hypothesis & { confidence: Confidence }>,
): number {
  // Weighted by belief: refuting something nobody believes is not worth a round
  // trip, but refuting the leader always is.
  let value = 0
  for (const h of hypotheses) {
    if (h.predicts[test.id] !== undefined) value = Math.max(value, h.confidence)
  }
  return value
}

/** Overall worth of running a test: it either separates hypotheses or refutes one. */
export function testValue(
  test: DiagnosticTest,
  hypotheses: Array<Hypothesis & { confidence: Confidence }>,
): number {
  return Math.max(discriminationPower(test, hypotheses), falsificationValue(test, hypotheses))
}

/**
 * Pick the next test, or null when none is worth running.
 *
 * Cost only breaks ties between tests of similar power — it never suppresses a
 * decisive test in favour of a cheap useless one. A test with zero
 * discriminating power is never selected at any price.
 */
export function selectNextTest(
  state: InvestigationState,
  available: DiagnosticTest[],
): DiagnosticTest | null {
  const live = liveHypotheses(state)
  let best: { test: DiagnosticTest; score: number } | null = null

  for (const test of available) {
    if (state.spentTests.includes(test.id)) continue
    const value = testValue(test, live)
    if (value <= 0) continue
    const score = value * COST_PENALTY[test.cost]
    if (!best || score > best.score) best = { test, score }
  }

  return best?.test ?? null
}

/** Hypotheses still in play — those not driven to ~zero by contradiction. */
export function liveHypotheses(
  state: InvestigationState,
): Array<Hypothesis & { confidence: Confidence }> {
  return state.hypotheses.filter(h => h.confidence > 0.01)
}

/**
 * Fold one observation into the belief state.
 *
 * A hypothesis that predicted the observed outcome gains; one that predicted
 * something else is ELIMINATED, not merely demoted — it made a falsifiable claim
 * and the claim was false. That is the point of requiring predictions.
 *
 * A hypothesis that made no prediction is left untouched. It neither earned
 * credit nor was refuted, and quietly rewarding it would let vague hypotheses
 * win by never committing to anything.
 */
export function applyObservation(
  state: InvestigationState,
  observation: Observation,
): InvestigationState {
  const updated = state.hypotheses.map(h => {
    const predicted = h.predicts[observation.testId]
    if (predicted === undefined) return h
    if (predicted === observation.outcome) {
      return { ...h, confidence: h.confidence * 3 }
    }
    return { ...h, confidence: 0 }
  })

  return {
    ...state,
    hypotheses: normalise(updated),
    observations: [...state.observations, observation],
    spentTests: [...state.spentTests, observation.testId],
  }
}

/** Renormalise so confidences remain comparable across rounds. */
function normalise(
  hypotheses: Array<Hypothesis & { confidence: Confidence }>,
): Array<Hypothesis & { confidence: Confidence }> {
  const total = hypotheses.reduce((a, h) => a + h.confidence, 0)
  if (total <= 0) return hypotheses.map(h => ({ ...h, confidence: 0 }))
  return hypotheses.map(h => ({ ...h, confidence: h.confidence / total }))
}

export function initialState(symptomId: string, hypotheses: Hypothesis[]): InvestigationState {
  const total = hypotheses.reduce((a, h) => a + h.prior, 0)
  return {
    symptomId,
    hypotheses: hypotheses.map(h => ({
      ...h,
      confidence: total > 0 ? h.prior / total : 0,
    })),
    observations: [],
    spentTests: [],
  }
}

/**
 * Decide whether the investigation can conclude.
 *
 * Four outcomes, and the last two are the ones that make this trustworthy:
 * a system that can only ever produce an answer will produce a wrong one when
 * it has no basis for a right one.
 */
export function concludeInvestigation(
  state: InvestigationState,
  available: DiagnosticTest[],
): InvestigationVerdict {
  const live = liveHypotheses(state)

  // Every hypothesis contradicted. The catalog does not contain the real cause,
  // and saying so is far more useful than promoting whichever survivor happened
  // to make the fewest predictions.
  if (live.length === 0) {
    return {
      kind: 'unexplained',
      reason:
        'Every candidate explanation predicted something the evidence contradicted. ' +
        'The real cause is not in the catalog for this symptom.',
      observations: state.observations,
    }
  }

  const sorted = [...live].sort((a, b) => b.confidence - a.confidence)
  const leader = sorted[0]
  const runnerUp = sorted[1]
  const margin = runnerUp ? leader.confidence - runnerUp.confidence : 1

  // A leader may only be concluded on once the evidence that COULD refute it has
  // been gathered. Skipping this produced a real wrong answer: PostgREST was
  // healthy, but the loop concluded "the schema cache is failing for some other
  // reason" at 87% because it stopped before running the one test that would
  // have shown the cache was fine and left the symptom unexplained.
  const refutable = available.some(
    t => !state.spentTests.includes(t.id) && leader.predicts[t.id] !== undefined,
  )

  if (leader.confidence >= ACT_THRESHOLD && margin >= LEAD_MARGIN && !refutable) {
    return { kind: 'conclusive', hypothesis: leader, confidence: leader.confidence }
  }

  // Evidence remains that would either separate the survivors or test the
  // leader — keep going.
  if (selectNextTest(state, available)) {
    return {
      kind: 'ambiguous',
      candidates: sorted,
      reason: refutable
        ? 'Evidence remains that could refute the leading explanation.'
        : 'Further evidence is available and would distinguish these.',
    }
  }

  // Uncertain and nothing left to ask. This is the honest dead end, and it is
  // reported rather than resolved by picking the leader: acting on a diagnosis
  // the evidence never actually settled is how an autonomous system does damage
  // while appearing decisive.
  return {
    kind: 'ambiguous',
    candidates: sorted,
    reason:
      runnerUp
        ? `No remaining test distinguishes "${leader.statement}" from ` +
          `"${runnerUp.statement}". Both remain consistent with everything observed.`
        : `Evidence is consistent with "${leader.statement}" but never reached the ` +
          `confidence required to act on it unattended.`,
  }
}

/** May the loop apply this verdict without a human? */
export function mayAutoApply(verdict: InvestigationVerdict): boolean {
  return verdict.kind === 'conclusive' && verdict.hypothesis.remedy.autoApplicable
}
