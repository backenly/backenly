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
import type {
  ChallengeResult,
  ProductEvent,
  SignupAdmission,
  SignupAttempt,
  SignupChallenge,
  SignupCompleted,
  UsageMetricsDelta,
} from '@/lib/platform-signals/types'

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
/**
 * Backenly's judgement on a signup it has never seen.
 *
 * The email-trust assessment: MX and domain checks, disposable-provider
 * detection, a score and the signals behind it. Reached only in cloud, and only
 * after the deployment's own gates have already passed.
 *
 * A `challenge` verdict is not a refusal. The account is admitted and marked
 * untrusted, so it exists but consumes nothing until its mailbox is verified.
 * Recording that is what lets an operator see how an account arrived.
 */
export async function assessSignupAdmission(
  attempt: SignupAttempt,
): Promise<SignupAdmission> {
  const { assessEmailTrust } = await import('@/lib/trust/email-trust')
  const { recordSecurityEvent } = await import('@/lib/platform-controls/security-events')

  const trust = await assessEmailTrust(attempt.email)

  if (trust.verdict === 'deny') {
    await recordSecurityEvent({
      kind: 'signup_denied',
      severity: 'warn',
      userEmail: attempt.email,
      ip: attempt.ip,
      summary: `Blocked signup — email trust ${trust.score}/100 (${trust.signals.join(', ')})`,
      detail: { email: attempt.email, ip: attempt.ip, score: trust.score, signals: trust.signals },
    }).catch(() => {})
    return {
      ok: false,
      reason: trust.reason ?? 'Sign-up is not allowed for this email address.',
      status: trust.signals.includes('invalid_email') ? 400 : 403,
      score: trust.score,
      signals: trust.signals,
    }
  }

  if (trust.verdict === 'challenge') {
    // Not refused — recorded. These are the accounts worth watching, and the
    // caller marks them untrusted so they stay inert until verified.
    await recordSecurityEvent({
      kind: 'signup_untrusted',
      severity: 'info',
      userEmail: attempt.email,
      ip: attempt.ip,
      summary: `Untrusted signup allowed — email trust ${trust.score}/100 (${trust.signals.join(', ')})`,
      detail: { email: attempt.email, ip: attempt.ip, score: trust.score, signals: trust.signals },
    }).catch(() => {})
  }

  return {
    ok: true,
    reason: '',
    status: 200,
    untrusted: trust.verdict === 'challenge',
    score: trust.score,
    signals: trust.signals,
  }
}

/** Backenly's product funnel event log. Read only by the founder console. */
export function recordProductEvent(event: ProductEvent): void {
  void import('@/lib/analytics/logger').then(({ logEvent }) =>
    logEvent(event.type, event.userId, event.projectId ?? undefined, event.metadata),
  )
}

/** Backenly's daily usage buckets. Read only by the founder analytics pages. */
export function recordUsageMetrics(
  userId: string,
  projectId: string | undefined,
  delta: UsageMetricsDelta,
): void {
  void import('@/lib/analytics/logger').then(({ trackUsage }) => trackUsage(userId, projectId, delta))
}

/** Turnstile. Reached only in cloud; OSS never loads the implementation. */
export async function verifySignupChallenge(challenge: SignupChallenge): Promise<ChallengeResult> {
  const { verifyBotChallenge } = await import('@/lib/trust/bot-defense')
  return verifyBotChallenge(challenge.token, challenge.ip)
}
