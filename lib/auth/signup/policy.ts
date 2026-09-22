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
 *   Self-hosted,   Skipped. The first account is the operator claiming their
 *   first account  own install, and possession of the machine is the proof
 *                  (the setup token, or on older installs the empty user
 *                  table). Most installs have no SMTP yet, and demanding a
 *                  code there would leave the operator unable to sign into
 *                  their own deployment.
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

export type SignupVerification = 'skip' | 'require' | 'refuse'

export function signupVerificationPolicy(input: {
  edition: Edition
  /** No account exists yet on this deployment. */
  isFirstAccount: boolean
  mailConfigured: boolean
}): SignupVerification {
  if (input.edition === 'single-tenant' && input.isFirstAccount) return 'skip'
  return input.mailConfigured ? 'require' : 'refuse'
}
