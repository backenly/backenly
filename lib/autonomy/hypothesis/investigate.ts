/**
 * PHASE 4 — run an investigation end to end.
 *
 * Ties the pure reasoning core to real observations, and records the trail. The
 * trail is not decoration: an autonomous system that changes production must be
 * able to answer "why did you conclude that" long after the fact, and the answer
 * has to be the actual evidence rather than a story reconstructed later.
 *
 * A test that FAILS is not a test that answered. It is removed from the
 * available set and noted as unavailable, so it neither eliminates hypotheses
 * nor silently supports them. That distinction is why this loop can honestly
 * reach "I could not tell" instead of always producing a culprit.
 */

import {
  applyObservation,
  concludeInvestigation,
  initialState,
  liveHypotheses,
  selectNextTest,
} from './reasoning'
import { findSymptom } from './catalog'
import { PROBE_REGISTRY, type ProbeContext } from './probes'
import type { DiagnosticTest, InvestigationState, InvestigationVerdict, Observation } from './types'

export interface InvestigationReport {
  symptomId: string
  verdict: InvestigationVerdict
  observations: Observation[]
  /** Tests that could not be run, with the reason. */
  unavailable: Array<{ testId: string; reason: string }>
  /** Human-readable reasoning trail, in order. */
  trail: string[]
}

/** Hard cap so a malformed catalog cannot loop indefinitely. */
const MAX_ROUNDS = 12

export async function investigate(
  symptomId: string,
  ctx: ProbeContext,
): Promise<InvestigationReport> {
  const symptom = findSymptom(symptomId)
  if (!symptom) {
    return {
      symptomId,
      verdict: { kind: 'no_symptom' },
      observations: [],
      unavailable: [],
      trail: [`No catalog entry for symptom "${symptomId}".`],
    }
  }

  let state: InvestigationState = initialState(symptomId, symptom.hypotheses)
  let available: DiagnosticTest[] = [...symptom.tests]
  const unavailable: Array<{ testId: string; reason: string }> = []
  const trail: string[] = [
    `Investigating: ${symptom.description}`,
    `Candidate explanations: ${symptom.hypotheses.length}`,
  ]

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const verdict = concludeInvestigation(state, available)
    // Only 'ambiguous' continues, and only while a test remains that would
    // actually separate the survivors.
    if (verdict.kind !== 'ambiguous') break

    const next = selectNextTest(state, available)
    if (!next) break

    const probe = PROBE_REGISTRY[next.id]
    if (!probe) {
      available = available.filter(t => t.id !== next.id)
      unavailable.push({ testId: next.id, reason: 'no probe implemented' })
      trail.push(`Skipped "${next.description}" — no probe implemented.`)
      continue
    }

    try {
      const result = await probe(ctx)
      const observation: Observation = {
        testId: next.id,
        outcome: result.outcome,
        detail: result.detail,
      }
      const before = liveHypotheses(state).length
      state = applyObservation(state, observation)
      const after = liveHypotheses(state).length

      trail.push(
        `${next.description} → ${result.outcome}` +
        (result.detail ? ` (${result.detail})` : '') +
        (after < before ? ` — ruled out ${before - after}` : ''),
      )
    } catch (err) {
      // Unavailable, NOT answered. Recording a failed probe as an outcome would
      // let an infrastructure problem masquerade as evidence about the symptom.
      const reason = err instanceof Error ? err.message : String(err)
      available = available.filter(t => t.id !== next.id)
      unavailable.push({ testId: next.id, reason })
      trail.push(`Could not run "${next.description}": ${reason}`)
    }
  }

  const verdict = concludeInvestigation(state, available)

  switch (verdict.kind) {
    case 'conclusive':
      trail.push(
        `Conclusion: ${verdict.hypothesis.statement} ` +
        `(confidence ${(verdict.confidence * 100).toFixed(0)}%)`,
      )
      trail.push(`Remedy: ${verdict.hypothesis.remedy.summary}`)
      if (!verdict.hypothesis.remedy.autoApplicable) {
        trail.push('Not applied automatically — this repair needs a human decision.')
      }
      break
    case 'ambiguous':
      trail.push(`Inconclusive: ${verdict.reason}`)
      for (const c of verdict.candidates.slice(0, 3)) {
        trail.push(`  still possible (${(c.confidence * 100).toFixed(0)}%): ${c.statement}`)
      }
      break
    case 'unexplained':
      trail.push(`Unexplained: ${verdict.reason}`)
      break
    case 'no_symptom':
      break
  }

  return { symptomId, verdict, observations: state.observations, unavailable, trail }
}

/**
 * Persist the trail against the project.
 *
 * Stored even when the verdict is inconclusive — arguably especially then. A
 * record of what was ruled out is what stops the next investigation repeating
 * the same dead end, and it is the evidence a human needs when the loop hands
 * a decision back to them.
 */
export async function recordInvestigation(
  projectId: string,
  report: InvestigationReport,
): Promise<void> {
  const { prisma } = await import('@/lib/db/prisma')
  const summary =
    report.verdict.kind === 'conclusive'
      ? report.verdict.hypothesis.statement
      : report.verdict.kind === 'unexplained'
        ? 'No candidate explanation survived the evidence'
        : 'Inconclusive'

  await prisma.projectPreference.upsert({
    where: {
      projectId_type_key: {
        projectId,
        type: 'investigation',
        key: report.symptomId,
      },
    },
    create: {
      projectId,
      type: 'investigation',
      key: report.symptomId,
      value: summary.slice(0, 500),
      confidence: report.verdict.kind === 'conclusive' ? report.verdict.confidence : 0,
      examples: report.trail as unknown as object,
    },
    update: {
      value: summary.slice(0, 500),
      confidence: report.verdict.kind === 'conclusive' ? report.verdict.confidence : 0,
      examples: report.trail as unknown as object,
      lastSeen: new Date(),
    },
  })
}
