/**
 * PlatformSignals, as resolved WITHOUT the private overlay.
 *
 * `@cloud/platform-signals` resolves here only when `lib/cloud/platform-signals.ts`
 * is absent. This is what a public checkout gets, and Backenly's business
 * machinery is not in it: referral, the email scoring, Turnstile, dunning and
 * the founder funnel telemetry all left in Phase 6.
 *
 * Same reasoning as the entitlements fallback for why none of this throws: an
 * explicit BACKENLY_EDITION=cloud process without the overlay refuses to start,
 * so what reaches here is the unset default in CI and local development.
 *
 * A signal nobody is listening for is not an error. It is what a deployment
 * with no growth programme, no abuse funnel and no founder console looks like.
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

/** No referral programme to attribute anything to. */
export async function onSignupCompleted(_event: SignupCompleted): Promise<void> {
  // no-op
}

/** No subscriptions to dun. */
export async function runScheduledBackOfficeMaintenance(): Promise<void> {
  // no-op
}

/**
 * Admit.
 *
 * This is not a weakened check. Everything that belongs to a deployment has
 * already run in lib/platform-controls before this is called: the self-hosted
 * account slot, the kill switches and the operator blocklist. What is missing
 * here is only Backenly's scoring of a stranger, and a public checkout has no
 * reputation data to score with and no funnel to defend.
 */
export async function assessSignupAdmission(_attempt: SignupAttempt): Promise<SignupAdmission> {
  return { ok: true, reason: '', status: 200 }
}

/**
 * No proof-of-humanity provider.
 *
 * `unconfigured` is the same thing the old implementation reported when no
 * Turnstile secret was set, so callers that surface the gap keep working.
 */
export async function verifySignupChallenge(_challenge: SignupChallenge): Promise<ChallengeResult> {
  return { ok: true, unconfigured: true }
}

/** No founder console, so no funnel to record into. */
export function recordProductEvent(_event: ProductEvent): void {
  // no-op
}

/** No founder analytics pages, so no daily buckets to fill. */
export function recordUsageMetrics(
  _userId: string,
  _projectId: string | undefined,
  _delta: UsageMetricsDelta,
): void {
  // no-op
}
