/**
 * WAS THIS FIX VERIFIED? — one vocabulary, one predicate
 * =======================================================
 *
 * A repair has three possible states after it runs, and the system kept
 * collapsing them into two.
 *
 *   confirmed           An acceptance probe ran and positively established the
 *                       postcondition. The only state that may be called a
 *                       verified fix.
 *   unverified          No probe covers this finding type. A KNOWN gap, known
 *                       in advance, and honest: the fix ran and nothing in the
 *                       platform can independently confirm it.
 *   verification_error  The probe could not produce evidence — it threw, timed
 *                       out, or the database was briefly unreachable. We do not
 *                       know whether the fix worked.
 *
 * ── Why the third state has to exist ──────────────────────────────────────
 *
 * `evaluateFixOutcome` was called as `.catch(() => null)`, and every guard
 * after it was written `if (outcome && ...)`. So when the verifier threw, all
 * three guards were skipped and the fix was recorded as applied. The sequence
 * was literally:
 *
 *     detect -> mutate -> verifier throws -> record success
 *
 * That is the same failure as a probe reporting an empty table it could not
 * read, moved one step later in the loop and made worse: there, the system
 * manufactured certainty about the world; here it manufactures certainty about
 * its own work, after having already changed a customer's backend.
 *
 * A database timeout does not prove the repair failed. It also does not prove
 * it succeeded. Unable to verify is not verified, and it is not failed either.
 *
 * ── Why this is a module and not a union in two files ─────────────────────
 *
 * Because the rule is about how the value is READ, not how it is written. Any
 * predicate of the shape `verification !== 'failed'` re-opens the hole the
 * moment a fourth state appears, since an unrecognised value passes a deny
 * list and fails an allow list. `isVerifiedFix` is the only sanctioned way to
 * ask, and it is positive: exactly one string means verified, everything else
 * — including `undefined`, a legacy row, and a value from a future version —
 * does not.
 */

export type FixVerification = 'confirmed' | 'unverified' | 'verification_error'

/**
 * The ONE success predicate. Positive by construction.
 *
 * Takes `unknown` on purpose: it is read off `finding.details.rollbackData`,
 * which is JSON and carries no type at runtime. Rows written before this
 * vocabulary existed hold `'confirmed'` or `'unverified'` and keep working;
 * anything unrecognised is not verified, which is the safe direction.
 */
export function isVerifiedFix(verification: unknown): boolean {
  return verification === 'confirmed'
}

/**
 * Did the loop change the backend without being able to confirm the result?
 *
 * Distinct from `!isVerifiedFix(...)`, which is also true for the honest
 * `unverified` case where no probe exists. This one means something went wrong
 * with the observing, and it is the state that must stop dependent work.
 */
export function isVerificationError(verification: unknown): boolean {
  return verification === 'verification_error'
}

/**
 * What a human should be told about a fix in this state.
 *
 * Kept next to the vocabulary so a new state cannot be added without deciding
 * what it says to the person reading the queue.
 */
export function describeVerification(verification: unknown): string {
  switch (verification) {
    case 'confirmed':
      return 're-checked and confirmed'
    case 'verification_error':
      return 'applied, but the check that would confirm it could not run'
    default:
      return 'not independently re-checked'
  }
}
