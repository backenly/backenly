/**
 * STRUCTURAL DIAGNOSIS — why an area's repairs stop holding
 * =========================================================
 *
 * Phase 3 raises `subsystem_repeat_failure`, which says THAT repairs across one
 * area are not holding. This says why, or honestly says it could not tell.
 *
 * It is a thin layer over the existing hypothesis engine — `investigate()` runs
 * the probes, `concludeInvestigation` weighs them, and neither is reimplemented
 * here. What this adds is the part the generic engine has no opinion about:
 *
 *   1. COVERAGE, reported separately from the verdict.
 *   2. A refusal to conclude when the probe that DECIDES a live hypothesis
 *      could not run.
 *
 * ── Why (2) is not already handled ──────────────────────────────────────────
 *
 * `investigate()` correctly removes a failed test from the available set and
 * records it as unavailable, so it neither eliminates nor supports anything.
 * But `concludeInvestigation` then asks "is there still a test that could refute
 * the leader?" — and a test that was REMOVED because it could not run answers
 * no. So a blind instrument looks exactly like an exhausted one.
 *
 * On this symptom that is not a subtle difference. `no_structural_cause`
 * predicts the negative outcome on every test, so if the deciding probes never
 * ran, it is left standing unrefuted and would be reported as a clean bill of
 * health for a subsystem nobody actually examined. The override below is what
 * turns that into `inconclusive`.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 *
 *     a probe that did not run  ≠  a probe that ran and found absence
 *
 * Read-only. Runs probes, weighs them, returns words. Changes nothing.
 */

import { investigate, type InvestigationReport } from './investigate'
import { findSymptom, type SymptomDefinition } from './catalog'
import { assessStructuralCoverage, type EvidenceCoverage } from './structural-probes'
import type { Hypothesis } from './types'

export const STRUCTURAL_SYMPTOM = 'subsystem_repeat_failure'

/**
 * Which test DECIDES each hypothesis.
 *
 * Derived from `docs/structural-probe-inventory.md`, and deliberately not from
 * the prediction matrix: a hypothesis can predict an outcome on a test that
 * merely RAISES it. `split_brain_writers` is the case that matters —
 * `write_statement_shapes` moves its confidence and cannot confirm it, because
 * several write shapes are equally consistent with one application having
 * several code paths.
 */
const DECIDED_BY: Readonly<Record<string, string>> = {
  policy_fragmentation: 'policy_overlap',
  missing_constraint_permits_invalid_state: 'constraint_coverage',
  duplicated_lifecycle_state: 'column_covariation',
}

/** Hypotheses this platform can raise but never confirm. */
const RAISED_ONLY: ReadonlySet<string> = new Set(['split_brain_writers'])

export type StructuralVerdictKind =
  | 'structural_cause_identified'
  | 'no_structural_cause'
  | 'inconclusive'

export interface StructuralDiagnosis {
  kind: StructuralVerdictKind
  /** Present only for `structural_cause_identified`. */
  hypothesis?: Hypothesis
  confidence?: number
  /** Always present, always separate from the verdict. */
  coverage: EvidenceCoverage
  /** Which deciding probes could not run, and why. */
  blockedBy: Array<{ hypothesis: string; test: string; reason: string }>
  /** Hypotheses raised by weak evidence and NOT confirmable. */
  raisedOnly: string[]
  reason: string
  /** The full reasoning trail, for a human inheriting the decision. */
  trail: string[]
  report: InvestigationReport
}

/**
 * Two hypotheses that predict identically on every test can be ranked by prior
 * and never separated by evidence.
 *
 * That is a defect in the catalog, not a property of the backend, and it is
 * invisible at runtime: the engine happily reports whichever had the higher
 * prior, with a reasoning trail that looks complete. So it is checked at module
 * load, where it fails loudly and immediately.
 */
export function indistinguishablePairs(symptom: SymptomDefinition): Array<[string, string]> {
  const testIds = symptom.tests.map(t => t.id).sort()
  const signature = (h: Hypothesis) =>
    testIds.map(id => `${id}=${h.predicts[id] ?? '∅'}`).join('|')

  const out: Array<[string, string]> = []
  for (let i = 0; i < symptom.hypotheses.length; i++) {
    for (let j = i + 1; j < symptom.hypotheses.length; j++) {
      const a = symptom.hypotheses[i]
      const b = symptom.hypotheses[j]
      if (signature(a) === signature(b)) out.push([a.id, b.id])
    }
  }
  return out
}

// Fails at import, not at diagnosis time.
{
  const symptom = findSymptom(STRUCTURAL_SYMPTOM)
  if (!symptom) {
    throw new Error(`hypothesis catalog is missing the "${STRUCTURAL_SYMPTOM}" symptom`)
  }
  const clashes = indistinguishablePairs(symptom)
  if (clashes.length > 0) {
    throw new Error(
      `Indistinguishable hypotheses in "${STRUCTURAL_SYMPTOM}": ` +
      clashes.map(([a, b]) => `${a} vs ${b}`).join(', ') +
      '. They predict identically on every test, so no evidence can separate them.',
    )
  }
  // Every hypothesis with a deciding test must actually predict on it,
  // otherwise DECIDED_BY names a test that can never settle the question.
  for (const [hyp, test] of Object.entries(DECIDED_BY)) {
    const h = symptom.hypotheses.find(x => x.id === hyp)
    if (!h) throw new Error(`DECIDED_BY names unknown hypothesis "${hyp}"`)
    if (h.predicts[test] === undefined) {
      throw new Error(`"${hyp}" is declared decided by "${test}" but makes no prediction about it`)
    }
  }
}

export async function diagnoseStructuralCause(
  projectId: string,
  membership: string[],
): Promise<StructuralDiagnosis> {
  const ctx = { projectId, membership } as { projectId: string; membership: string[] }

  const [report, coverage] = await Promise.all([
    investigate(STRUCTURAL_SYMPTOM, ctx as never),
    assessStructuralCoverage(ctx as never),
  ])

  const unavailableById = new Map(report.unavailable.map(u => [u.testId, u.reason]))

  // Which deciding probes failed to run. A hypothesis whose decider never ran
  // was neither supported nor refuted, whatever the engine concluded.
  const blockedBy: Array<{ hypothesis: string; test: string; reason: string }> = []
  for (const [hyp, test] of Object.entries(DECIDED_BY)) {
    const reason = unavailableById.get(test)
    if (reason) blockedBy.push({ hypothesis: hyp, test, reason })
  }

  const raisedOnly = report.observations
    .filter(o => o.testId === 'write_statement_shapes' && o.outcome === 'multiple_writers')
    .map(() => 'split_brain_writers')

  const base = {
    coverage,
    blockedBy,
    raisedOnly,
    trail: report.trail,
    report,
  }

  const verdict = report.verdict

  if (verdict.kind === 'conclusive') {
    const id = verdict.hypothesis.id

    // A hypothesis this platform can only RAISE must never be reported as the
    // identified cause, however the arithmetic came out.
    if (RAISED_ONLY.has(id)) {
      return {
        ...base,
        kind: 'inconclusive',
        reason:
          `"${id}" is the leading explanation but cannot be confirmed: the evidence that would ` +
          'settle it requires analysing function source, which this platform cannot do.',
      }
    }

    if (id === 'no_structural_cause') {
      // The anti-garbage-bucket rule. `no_structural_cause` predicts the
      // negative on every test, so it survives by default when the instruments
      // were blind. It may only win once the probes that could have refuted it
      // actually ran.
      if (blockedBy.length > 0) {
        return {
          ...base,
          kind: 'inconclusive',
          reason:
            'No structural cause was supported, but the evidence that could have shown one did ' +
            `not run: ${blockedBy.map(b => `${b.test} (${b.reason})`).join('; ')}.`,
        }
      }
      return {
        ...base,
        kind: 'no_structural_cause',
        confidence: verdict.confidence,
        reason: 'Every structural explanation was actively refuted by evidence that ran.',
      }
    }

    // A real cause — but only if its own decider ran.
    const blocked = blockedBy.find(b => b.hypothesis === id)
    if (blocked) {
      return {
        ...base,
        kind: 'inconclusive',
        reason: `"${id}" leads, but ${blocked.test} could not run (${blocked.reason}).`,
      }
    }

    return {
      ...base,
      kind: 'structural_cause_identified',
      hypothesis: verdict.hypothesis,
      confidence: verdict.confidence,
      reason: verdict.hypothesis.statement,
    }
  }

  if (verdict.kind === 'ambiguous') {
    // The same blind-instrument rule, on the path that also needs it.
    //
    // A tie can mean two things: every separating test ran and none of them
    // separated, or the one test that WOULD have separated them never ran.
    // `verdict.reason` cannot tell those apart, because a test removed as
    // unavailable leaves the engine's "nothing left to ask" set looking
    // identical to an exhausted one. Reporting the tie alone would describe a
    // blind instrument as an exhausted one -- the exact confusion this module
    // exists to prevent, arrived at by a different route than the conclusive
    // branch above.
    const surviving = new Set(verdict.candidates.map(c => c.id))
    const blindfolds = blockedBy.filter(b => surviving.has(b.hypothesis))
    if (blindfolds.length > 0) {
      return {
        ...base,
        kind: 'inconclusive',
        reason:
          `${verdict.reason} The evidence that would have separated them did not run: ` +
          `${blindfolds.map(b => `${b.test} (${b.reason})`).join('; ')}.`,
      }
    }

    return {
      ...base,
      kind: 'inconclusive',
      reason: verdict.reason,
    }
  }

  if (verdict.kind === 'unexplained') {
    return {
      ...base,
      kind: 'inconclusive',
      reason:
        'Every candidate explanation predicted something the evidence contradicted. The cause is ' +
        'not in the catalog for this symptom.',
    }
  }

  return {
    ...base,
    kind: 'inconclusive',
    reason: 'No catalog entry for this symptom.',
  }
}
