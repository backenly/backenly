/**
 * VERIFY — the step that turns reconciliation into a rung of the ladder
 * =====================================================================
 *
 * Thin on purpose. All the judgement lives in `../reconcile.ts`, which was
 * built before anything that mutates precisely so the check would already exist
 * when the writers arrived. This adapts it to the executor's shape: a step with
 * preconditions, a verdict, and evidence the ledger can store.
 *
 * ── `inconclusive` is a halt, not a retry ───────────────────────────────────
 *
 * The one rule this module enforces beyond reconciliation's own is what the
 * caller does with each verdict:
 *
 *   consistent    the rung held; the ladder may continue
 *   inconsistent  the rung failed; roll back, do not continue
 *   inconclusive  nothing was demonstrated; HALT
 *
 * The third is the one that gets collapsed. An empty table, a dropped column, a
 * query that failed — each returns zero mismatches, and zero mismatches reads
 * like success to anything counting. Retrying an inconclusive check is how a
 * flaky gate gets retried until it passes.
 *
 * Which is also why `verify` is the only Tier 0 step in the ladder: it reads and
 * compares and changes nothing, so it can run at any autonomy level, on any
 * project, without an approval. A safety check nobody is allowed to run is not a
 * safety check.
 */

import { reconcileSourceTarget, type ReconciliationResult } from '../reconcile'
import type { Transform } from '../transform'

export interface VerifySpec {
  projectId: string
  table: string
  sourceColumn: string
  targetColumn: string
  transform: Transform
  /** The plan version. Salts the sample so a retry inspects the same slice. */
  planIdentity: string
  fullCompareMaxRows?: number
  sampleRows?: number
}

export type VerifyOutcome = 'passed' | 'failed' | 'halt'

export interface VerifyResult {
  outcome: VerifyOutcome
  /** May the ladder proceed past this rung? True only for `passed`. */
  mayProceed: boolean
  reconciliation: ReconciliationResult
  /** One line, suitable for an approval queue or a halt reason. */
  summary: string
}

/**
 * Run the comparison and map its verdict onto what the executor may do next.
 *
 * `mayProceed` is derived from the verdict in one place rather than left to each
 * caller, because "consistent" and "not inconsistent" are different conditions
 * and only the first one is evidence.
 */
export async function runVerify(spec: VerifySpec): Promise<VerifyResult> {
  const reconciliation = await reconcileSourceTarget(spec)
  const { verdict, comparedRows, mismatchedRows, coverage } = reconciliation

  if (verdict === 'consistent') {
    return {
      outcome: 'passed',
      mayProceed: true,
      reconciliation,
      summary:
        `${comparedRows} row(s) compared, none disagreed` +
        // Stated every time. A sampled pass is a weaker claim than a complete
        // one, and the ladder's next rung is where that difference is decided.
        (coverage.complete ? ' (every row)' : ` (sample of ${coverage.totalRows})`),
    }
  }

  if (verdict === 'inconsistent') {
    return {
      outcome: 'failed',
      mayProceed: false,
      reconciliation,
      summary: `${mismatchedRows} of ${comparedRows} compared row(s) disagree: ${reconciliation.evidence.reason}`,
    }
  }

  return {
    outcome: 'halt',
    mayProceed: false,
    reconciliation,
    summary: `nothing was demonstrated: ${reconciliation.evidence.reason}`,
  }
}
