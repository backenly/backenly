/**
 * The production lineage gate.
 *
 * Deliberately NOT called baseline eligibility. Whether production can be
 * baselined depends on a mechanism that has not been built or proven yet, so the
 * most this can say is that production's state is explained:
 *
 *   PRODUCTION_LINEAGE_EXPLAINED   P plus known causes account for production
 *   RECONCILIATION_REQUIRED        something is missing, different, or unexplained
 *   INCONCLUSIVE                   the comparison could not be trusted
 *
 * Staging's answer carries no weight here. The staging provisioning manifests
 * are offered to the attribution, but nothing requires production to match them:
 * an entry that finds nothing is reported as unobserved, not as agreement.
 */

import { countByBucket, type Attribution } from '../migration-lineage/attribute'
import type { Difference } from '../migration-lineage/diff'

export type ProductionVerdict = 'PRODUCTION_LINEAGE_EXPLAINED' | 'RECONCILIATION_REQUIRED' | 'INCONCLUSIVE'

export interface ProductionEvidence {
  /** The capture task's own verdict. */
  captureVerdict: string | null
  /** Whether a schema.prisma projection snapshot was available to compare against. */
  projectionPresent: boolean
  /** Server versions, so an engine mismatch cannot be mistaken for divergence. */
  projectionEngine: string | null
  productionEngine: string | null
  /** RLS reads agreed with each other on production. */
  rlsConsistent: boolean | null
}

export interface ProductionGateResult {
  verdict: ProductionVerdict
  reasons: string[]
  notes: string[]
  counts: {
    missingFromProduction: number
    definedDifferently: number
    extraInProduction: number
    buckets: ReturnType<typeof countByBucket>
  }
}

const major = (version: string | null): string | null => version?.split('.')[0] ?? null

export function gateProduction(
  pToProd: Difference[],
  attributions: Attribution[],
  evidence: ProductionEvidence,
): ProductionGateResult {
  const missingFromProduction = pToProd.filter(d => d.status === 'missing_in_right').length
  const definedDifferently = pToProd.filter(d => d.status === 'differs').length
  const extraInProduction = pToProd.filter(d => d.status === 'extra_in_right').length
  const buckets = countByBucket(attributions)
  const counts = { missingFromProduction, definedDifferently, extraInProduction, buckets }

  const blocking: string[] = []
  const notes: string[] = []

  if (evidence.captureVerdict !== 'PASS') blocking.push(`the production capture is ${evidence.captureVerdict ?? 'absent'}, not PASS`)
  if (!evidence.projectionPresent) blocking.push('no schema.prisma projection snapshot to compare against')
  if (evidence.rlsConsistent === false) blocking.push('RLS reads disagreed with each other on production')
  if (evidence.rlsConsistent === null) blocking.push('RLS visibility was not measured on production')

  // A different major engine deparses differently, so textual definitions would
  // diverge for reasons that have nothing to do with lineage.
  const pMajor = major(evidence.projectionEngine)
  const prodMajor = major(evidence.productionEngine)
  if (pMajor && prodMajor && pMajor !== prodMajor) {
    blocking.push(`the projection was captured on PostgreSQL ${evidence.projectionEngine} and production runs ${evidence.productionEngine}`)
  } else if (evidence.projectionEngine && evidence.productionEngine && evidence.projectionEngine !== evidence.productionEngine) {
    notes.push(`projection captured on ${evidence.projectionEngine}, production runs ${evidence.productionEngine} (same major)`)
  }

  if (blocking.length > 0) return { verdict: 'INCONCLUSIVE', reasons: blocking, notes, counts }

  const reasons: string[] = []
  if (missingFromProduction > 0) reasons.push(`${missingFromProduction} object(s) the current model requires are missing from production`)
  if (definedDifferently > 0) reasons.push(`${definedDifferently} object(s) are defined differently in production`)
  if (buckets.unexplained_divergence > 0) reasons.push(`${buckets.unexplained_divergence} production object(s) are unexplained`)

  return {
    verdict: reasons.length === 0 ? 'PRODUCTION_LINEAGE_EXPLAINED' : 'RECONCILIATION_REQUIRED',
    reasons,
    notes,
    counts,
  }
}
