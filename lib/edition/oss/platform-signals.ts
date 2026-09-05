/**
 * PlatformSignals, as resolved WITHOUT the private overlay.
 *
 * `@cloud/platform-signals` resolves here only when `lib/cloud/platform-signals.ts`
 * is absent, which means no Cloud overlay has been applied. Today that is every
 * public checkout, so this file still delegates to the real implementation and
 * Cloud behaviour is unchanged by the seam in front of it.
 *
 * Phase 6 moves that implementation into the private overlay. When it does,
 * this file becomes the honest answer for a public checkout with no business
 * machinery: nothing to react with, so nothing happens. Only the delegation
 * below disappears, because the product already calls the seam.
 *
 * Imports are dynamic for the same reason they are in the entitlements
 * fallback: these modules are leaving, and a static edge from the public seam
 * into them would have to be unpicked rather than deleted.
 */
import type { SignupCompleted } from '@/lib/platform-signals/types'

/**
 * Backenly's reaction to a new account.
 *
 * Referral attribution is the whole of it today. The credit grant it awards is
 * a commercial mutation, and it stays inside the referral implementation rather
 * than being re-decided here: this file's job is to route the signal, not to
 * reimplement what the signal means.
 */
export async function onSignupCompleted(event: SignupCompleted): Promise<void> {
  if (!event.referralCode) return

  const { applyReferralOnSignup } = await import('@/lib/billing/referral')
  await applyReferralOnSignup(event.userId, event.email, event.referralCode)
}

/**
 * Backenly's scheduled commercial maintenance.
 *
 * Dunning: expired payment-grace subscriptions are downgraded to free. The
 * failure mode this guards is silent and costs money in the direction nobody
 * checks, because a lapsed payer simply keeps their paid plan.
 */
export async function runScheduledBackOfficeMaintenance(): Promise<void> {
  const { runDailyGraceCheck } = await import('@/lib/billing/grace')
  const res = await runDailyGraceCheck()
  if (res && res.processed > 0) {
    console.log(`[GraceCheck] Downgraded ${res.processed} expired grace period(s) to FREE`)
  }
}