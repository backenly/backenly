/**
 * PHASE 4 — entry point, and where this sits relative to the existing loop.
 *
 * The autonomy stack already had two tiers:
 *
 *   Tier A  deterministic probes + mapped fixes — handles the routine cases
 *   Tier B  a model writes a diagnosis for whatever Tier A could not fix
 *
 * The gap between them is the whole reason this phase exists. Tier A can only
 * act where symptom and cause are one-to-one. Tier B produces prose: plausible,
 * often right, and unfalsifiable — it never actually looked at the system, so
 * its confidence is a property of the writing rather than of the evidence.
 *
 * This tier goes BETWEEN them. It makes real observations, eliminates
 * explanations that predicted something that did not happen, and returns a
 * conclusion with the trail that produced it. Where it succeeds, the answer is
 * grounded rather than argued, so it runs FIRST and the model pass is left for
 * what genuinely has no deterministic route.
 *
 * The important consequence: this tier can return "I could not tell", and mean
 * it. A model asked for a root cause will always produce one — that is what it
 * is for — and an autonomous system acting on an answer that was never
 * uncertain is the failure mode worth engineering against.
 */

export * from './types'
export { SYMPTOM_CATALOG, findSymptom, type SymptomDefinition } from './catalog'
export {
  discriminationPower,
  selectNextTest,
  applyObservation,
  concludeInvestigation,
  initialState,
  liveHypotheses,
  mayAutoApply,
} from './reasoning'
export { investigate, recordInvestigation, type InvestigationReport } from './investigate'
export { applyRemedy, type RemedyOutcome } from './remedy'
export { PROBE_REGISTRY, type ProbeContext } from './probes'

import { investigate, recordInvestigation, type InvestigationReport } from './investigate'
import { applyRemedy, type RemedyOutcome } from './remedy'
import { mayAutoApply } from './reasoning'
import type { ProbeContext } from './probes'

/**
 * Which catalog symptom a finding type presents as.
 *
 * Only findings whose symptom is genuinely ambiguous appear here. A finding
 * with exactly one possible cause does not need an investigation, and routing
 * it through one would add latency and a reasoning trail that says nothing.
 */
const FINDING_TO_SYMPTOM: Record<string, string> = {
  runtime_engine_mismatch: 'empty_reads',
  missing_api_definition: 'endpoint_404',
  dead_api_endpoint: 'endpoint_404',
  missing_api_crud: 'endpoint_404',
  contract_surface_broken: 'endpoint_404',
}

export function symptomForFinding(findingType: string): string | undefined {
  return FINDING_TO_SYMPTOM[findingType]
}

export interface DiagnosisResult {
  report: InvestigationReport
  remedy?: RemedyOutcome
}

/**
 * Investigate a finding and, where the evidence justifies it, repair.
 *
 * `autoApply` defaults to false. A caller that wants production changed must
 * say so explicitly — the safe behaviour should not be the one you get by
 * forgetting an argument.
 */
export async function diagnoseFinding(
  projectId: string,
  findingType: string,
  ctx: Omit<ProbeContext, 'projectId'> = {},
  opts: { autoApply?: boolean } = {},
): Promise<DiagnosisResult | null> {
  const symptomId = symptomForFinding(findingType)
  if (!symptomId) return null

  const report = await investigate(symptomId, { projectId, ...ctx })

  // Recorded regardless of outcome — arguably most valuable when inconclusive,
  // since a record of what was ruled out is what stops the next investigation
  // repeating the same dead end.
  await recordInvestigation(projectId, report).catch(err => {
    console.error('[hypothesis] could not record investigation:', err)
  })

  if (!opts.autoApply || !mayAutoApply(report.verdict)) {
    return { report }
  }

  const remedy = await applyRemedy(projectId, report.verdict)
  return { report, remedy }
}

/**
 * Render a report as the diagnosis text the Review Queue already displays.
 *
 * Deliberately reports the reasoning trail rather than only the conclusion. A
 * human inheriting this decision needs to see what was checked and what was
 * eliminated — a bare verdict asks them to trust it, and the point of doing
 * this deterministically is that they do not have to.
 */
export function renderDiagnosis(report: InvestigationReport): {
  rootCause: string
  recommendation: string
  riskNote: string
  confidence: 'high' | 'medium' | 'low'
} | null {
  switch (report.verdict.kind) {
    case 'conclusive':
      return {
        rootCause: report.verdict.hypothesis.statement,
        recommendation: report.verdict.hypothesis.remedy.summary,
        riskNote: report.verdict.hypothesis.remedy.autoApplicable
          ? 'This repair is additive and reversible, so autonomy may apply it.'
          : 'Held for review: this repair is not safe to apply without a human decision.',
        confidence: report.verdict.confidence >= 0.95 ? 'high' : 'medium',
      }

    case 'ambiguous':
      return {
        rootCause:
          `Could not be narrowed to a single cause. Still consistent with the evidence: ` +
          report.verdict.candidates
            .slice(0, 3)
            .map(c => c.statement)
            .join('; ') + '.',
        recommendation: report.verdict.reason,
        // Naming what was checked is the useful part — it tells the reader
        // exactly which ground they do not need to cover again.
        riskNote:
          `Checked: ${report.observations.map(o => `${o.testId}=${o.outcome}`).join(', ') || 'nothing'}.` +
          (report.unavailable.length > 0
            ? ` Could not check: ${report.unavailable.map(u => u.testId).join(', ')}.`
            : ''),
        confidence: 'low',
      }

    case 'unexplained':
      return {
        rootCause:
          'Every known explanation for this symptom was contradicted by the evidence.',
        recommendation:
          'This is a cause the catalog does not yet contain. The observations below ' +
          'are the starting point for adding it.',
        riskNote: report.observations.map(o => `${o.testId}=${o.outcome}`).join(', '),
        confidence: 'low',
      }

    case 'no_symptom':
      return null
  }
}
