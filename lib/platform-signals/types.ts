/**
 * PlatformSignals: Backenly's own business reactions to product events.
 *
 * The product tells this seam that something happened. What Backenly does about
 * it commercially is not the product's business, and in a self-hosted install
 * the answer is "nothing at all".
 *
 * ── How this differs from Entitlements ──────────────────────────────────────
 *
 * Entitlements answers "may this happen?" and owns the commercial mutations
 * that follow from a plan. PlatformSignals is the other half: the business
 * REACTION to something the product already did. Signup is the clearest case.
 * The product creates an account; whether that account earns a referral bonus,
 * counts toward a growth metric, or trips an abuse heuristic is Backenly's
 * concern, not the backend's.
 *
 * Where a reaction needs a commercial mutation, PlatformSignals decides and
 * Entitlements performs. Referral is exactly that shape: this seam decides an
 * attribution was earned, and the credit grant goes through the Cloud
 * entitlements provider.
 *
 * ── Deliberately not an event bus ───────────────────────────────────────────
 *
 * Each method here corresponds to a call family that already exists in the
 * tree. There is no publish(), no subscribe(), no string event names and no
 * registry. A generic bus would let anything be signalled from anywhere, which
 * is how a seam stops describing the system and starts hiding it. Adding a
 * method should require knowing what calls it.
 *
 * Every implementation must be safe to call in single-tenant, where all of this
 * is a no-op, and must never throw into the product path. A signal is something
 * that has already happened; failing to react to it cannot un-happen it.
 */

/** A brand-new account, just created by one of the signup flows. */
export interface SignupCompleted {
  userId: string
  email: string
  /** How the account was created. Matches the provider recorded on User. */
  provider: 'email' | 'google' | 'github' | 'microsoft'
  /**
   * The raw ?ref= code, from the form body or the backenly_ref cookie set when
   * the visitor landed on a referral link. Not normalised or validated here:
   * what counts as a valid code is Backenly's business rule, not the product's.
   */
  referralCode?: string | null
}

export interface PlatformSignalsProvider {
  /**
   * Run Backenly's own scheduled commercial maintenance.
   *
   * Dunning today: expired payment-grace subscriptions get downgraded. This
   * is not a self-host job and must not become one. A single-tenant install
   * has no subscriptions to dun, so there is nothing here for it to run.
   *
   * The public scheduler owns the CADENCE and the private half owns the
   * WORK, which is what lets the billing cron routes move private without
   * the public scheduler ever importing them.
   */
  runScheduledBackOfficeMaintenance(): Promise<void>

  /**
   * React to a completed signup.
   *
   * Called after the account exists and before the session is issued. Must
   * never throw: signup has already succeeded by this point, and a failed
   * business reaction is not a reason to fail the request.
   */
  onSignupCompleted(event: SignupCompleted): Promise<void>
}
