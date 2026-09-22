/**
 * WHETHER A NEW PLATFORM ACCOUNT MUST PROVE ITS EMAIL FIRST
 * =========================================================
 * The two editions answer differently because they really are different.
 *
 *   Cloud          Always. Anyone on the internet can reach the signup page,
 *                  so an account exists only once its address is proven. With
 *                  no mail transport the signup is refused, never waved
 *                  through unverified.
 *
 *   Self-hosted,   Skipped, but ONLY when the claim is gated by the setup
 *   first account  token `npm run selfhost` printed. Possession of the machine
 *                  is then the proof, which is the one thing a fresh install
 *                  can offer before it has mail. An empty users table is NOT
 *                  that proof: a deployment is often reachable before its
 *                  operator gets to it, so "nobody has signed up yet" would
 *                  hand the single administrator slot to whichever stranger
 *                  loaded the page first.
 *
 *                  With no token configured there is nothing tying the claim
 *                  to the machine, so the address is proven by mail instead;
 *                  and with neither, the install has no safe way to admit its
 *                  first account and says so.
 *
 *   Self-hosted,   Required, and refused when the server has no mail. Only
 *   later accounts possible when the operator opened registration with
 *                  BACKENLY_ALLOW_PUBLIC_SIGNUP=true, and then these are
 *                  strangers exactly as on Cloud.
 *
 * Pure, so every branch is pinned by a unit test rather than by a route test
 * that happens to reach it.
 */
import type { Edition } from '@/lib/edition/types'

export type SignupVerification =
  | 'skip'
  | 'require'
  /** No transport, so the code cannot be delivered. */
  | 'refuse_no_mail'
  /** A first account with neither a setup token nor mail to prove anything with. */
  | 'refuse_unprotected_claim'

export function signupVerificationPolicy(input: {
  edition: Edition
  /** No account exists yet on this deployment. */
  isFirstAccount: boolean
  /**
   * This deployment gates its first signup on BACKENLY_SETUP_TOKEN, and the
   * caller has already been admitted by `assertSetupTokenAdmits`.
   */
  claimGatedBySetupToken: boolean
  mailConfigured: boolean
}): SignupVerification {
  if (input.edition === 'single-tenant' && input.isFirstAccount) {
    if (input.claimGatedBySetupToken) return 'skip'
    if (!input.mailConfigured) return 'refuse_unprotected_claim'
  }
  return input.mailConfigured ? 'require' : 'refuse_no_mail'
}
