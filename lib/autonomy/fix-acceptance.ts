/**
 * Fix acceptance — did the remediation actually fix anything?
 *
 * WHY THIS EXISTS
 * ---------------
 * The loop currently treats "the fix command succeeded" as "the problem is
 * solved". Those are different claims, and the gap between them is where
 * autonomous systems do damage confidently.
 *
 * The clearest example is in this project's own history: an agent could not
 * insert into a `timestamp` column, so it cast the column to `integer`. The
 * migration reported success. The tool call was green. The schema was now
 * wrong, and it stayed wrong for months. Every signal said the fix worked
 * because the only thing being checked was whether the command ran.
 *
 * A senior engineer does not accept a fix because the command exited zero —
 * they accept it because the specific thing that was failing now passes, and
 * nothing else started failing. That is the contract enforced here:
 *
 *   1. Name the failing check BEFORE fixing. A fix with no target is unprovable.
 *   2. Re-evaluate AFTER. The named check must flip to passing.
 *   3. No previously-passing check may have broken (no collateral damage).
 *
 * Failing any of these means the fix is REJECTED and should be rolled back —
 * "the command succeeded" is explicitly not sufficient evidence.
 */

/** A single evaluated check, before or after a remediation. */
export interface CheckState {
  id: string
  /** True when the check is satisfied. */
  passing: boolean
}

export type FixVerdict =
  /** The targeted check flipped to passing and nothing else broke. */
  | 'accepted'
  /** The targeted check still fails — the fix did not work. */
  | 'not_fixed'
  /** The targeted check passed, but something else broke. */
  | 'regression'
  /** The target was not failing beforehand, so there was nothing to prove. */
  | 'no_baseline'
  /** The target vanished from the after-state — unverifiable, never accepted. */
  | 'unverifiable'

export interface FixAcceptanceResult {
  verdict: FixVerdict
  accepted: boolean
  targetId: string
  /** Checks that were passing before and are failing now. */
  regressions: string[]
  /** Human-readable reason, suitable for an audit trail. */
  reason: string
}

/**
 * Decide whether a remediation may be accepted.
 *
 * Pure and total: takes the before/after check states and the id of the check
 * the fix claimed to address. Deliberately does NOT take the fix's own success
 * flag — a fix does not get to vouch for itself.
 */
export function evaluateFixAcceptance(
  targetId: string,
  before: CheckState[],
  after: CheckState[],
): FixAcceptanceResult {
  const beforeById = new Map(before.map((c) => [c.id, c.passing]))
  const afterById = new Map(after.map((c) => [c.id, c.passing]))

  const regressions = [...beforeById.entries()]
    .filter(([id, wasPassing]) => wasPassing && afterById.get(id) === false)
    .map(([id]) => id)

  const reject = (verdict: FixVerdict, reason: string): FixAcceptanceResult => ({
    verdict, accepted: false, targetId, regressions, reason,
  })

  if (!beforeById.has(targetId)) {
    return reject(
      'no_baseline',
      `No before-state was recorded for "${targetId}", so there is nothing to prove the fix ` +
      `worked against. Capture the failing check before remediating.`,
    )
  }

  if (beforeById.get(targetId) === true) {
    return reject(
      'no_baseline',
      `Check "${targetId}" was already passing before the fix ran, so this remediation ` +
      `cannot be shown to have achieved anything.`,
    )
  }

  if (!afterById.has(targetId)) {
    return reject(
      'unverifiable',
      `Check "${targetId}" could not be evaluated after the fix. An unevaluated check is ` +
      `not a passing check.`,
    )
  }

  if (afterById.get(targetId) === false) {
    return reject(
      'not_fixed',
      `Check "${targetId}" is still failing after the remediation. The command may have ` +
      `succeeded, but the problem it targeted did not go away.`,
    )
  }

  if (regressions.length > 0) {
    return reject(
      'regression',
      `Check "${targetId}" now passes, but the fix broke ${regressions.length} previously ` +
      `passing check(s): ${regressions.join(', ')}. Roll back.`,
    )
  }

  return {
    verdict: 'accepted',
    accepted: true,
    targetId,
    regressions: [],
    reason: `Check "${targetId}" flipped from failing to passing with no regressions.`,
  }
}

/**
 * Project a desired-state report onto the check states this gate consumes.
 * An invariant is "passing" when it is satisfied and has no gaps.
 */
export function checksFromDesiredState(
  report: { invariants: Array<{ id: string; satisfied: boolean; gaps: unknown[] }> },
): CheckState[] {
  return report.invariants.map((inv) => ({
    id: inv.id,
    passing: inv.satisfied && inv.gaps.length === 0,
  }))
}
