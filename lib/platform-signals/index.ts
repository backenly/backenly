/**
 * The one place the product signals Backenly's business machinery.
 *
 * Public product code imports this module. It must never import lib/billing,
 * lib/trust, lib/platform/controls or lib/analytics/logger, all of which are
 * Backenly's own implementation and move to the private Cloud overlay.
 *
 * The edition decides who answers:
 *
 *   single-tenant  ->  nothing happens, and that is the correct behaviour
 *   cloud          ->  @cloud/platform-signals
 *
 * `@cloud/*` resolves overlay-first, so the private implementation answers when
 * the Cloud overlay has been applied and the public fallback answers when it
 * has not. Same build-time mechanism the entitlements seam uses.
 *
 * Why single-tenant short-circuits HERE rather than in a no-op provider: a
 * self-hosted install should not need the Cloud module to exist at all, not
 * even to call a stub. Returning before the provider is consulted is what makes
 * that true.
 */
import {
  assessSignupAdmission as cloudAssessSignupAdmission,
  recordProductEvent as cloudRecordProductEvent,
  recordUsageMetrics as cloudRecordUsageMetrics,
  verifySignupChallenge as cloudVerifySignupChallenge,
  onSignupCompleted as cloudOnSignupCompleted,
  runScheduledBackOfficeMaintenance as cloudRunBackOfficeMaintenance,
} from '@cloud/platform-signals'
import { currentEdition } from '@/lib/edition'
import type {
  ChallengeResult,
  ProductEvent,
  SignupAdmission,
  SignupAttempt,
  SignupChallenge,
  SignupCompleted,
  UsageMetricsDelta,
} from './types'

export type {
  ChallengeResult,
  PlatformSignalsProvider,
  ProductEvent,
  ProductEventType,
  UsageMetricsDelta,
  SignupAdmission,
  SignupAttempt,
  SignupChallenge,
  SignupCompleted,
} from './types'

/**
 * Report a completed signup.
 *
 * Never throws and never rejects. Callers are in the signup path, the account
 * already exists, and no business reaction is worth failing a registration
 * that has already succeeded. Errors are swallowed here rather than at each of
 * the three call sites, so a new signup flow cannot forget to.
 */
export async function onSignupCompleted(event: SignupCompleted): Promise<void> {
  if (currentEdition() === 'single-tenant') return
  try {
    await cloudOnSignupCompleted(event)
  } catch {
    /* a business reaction cannot un-create the account */
  }
}

/**
 * Run Backenly's scheduled commercial maintenance, if there is any.
 *
 * The public scheduler in instrumentation.ts calls this on its daily tick. It
 * decides WHEN; what runs is the private half's business. In single-tenant
 * nothing runs, because a self-hosted install has no subscriptions to dun.
 *
 * Never throws. A failed maintenance pass must not take down the scheduler
 * that also runs autonomy, backups and workspace observation.
 */
export async function runScheduledBackOfficeMaintenance(): Promise<void> {
  if (currentEdition() === 'single-tenant') return
  try {
    await cloudRunBackOfficeMaintenance()
  } catch (err: any) {
    console.error('[BackOfficeMaintenance] Error:', err?.message)
  }
}

/**
 * Judge a signup attempt.
 *
 * Single-tenant admits, without consulting the Cloud provider and without a
 * verdict payload. That is not a weakened check: the gates that belong to a
 * deployment (the self-hosted slot, the kill switches, the operator blocklist)
 * have already run in lib/platform-controls before this is called. What does
 * not run is Backenly's scoring of a stranger, which a self-hosted install has
 * no funnel to need and no business performing.
 *
 * Unlike the other signals, this one does NOT swallow failures. It is an
 * admission decision on the request path, and an error here must not become an
 * implicit "allow" that opens Cloud signup to whatever just broke.
 */
export async function assessSignupAdmission(attempt: SignupAttempt): Promise<SignupAdmission> {
  if (currentEdition() === 'single-tenant') {
    return { ok: true, reason: '', status: 200 }
  }
  return cloudAssessSignupAdmission(attempt)
}

/**
 * Record a Backenly funnel event.
 *
 * A no-op in single-tenant. There is no founder console on a self-hosted box
 * and no funnel to measure, so writing ProductEvent rows there would only
 * accumulate data nobody can read.
 *
 * Void and fire-and-forget, because every caller is on a hot path.
 */
export function recordProductEvent(event: ProductEvent): void {
  if (currentEdition() === 'single-tenant') return
  try {
    cloudRecordProductEvent(event)
  } catch {
    /* telemetry must never break the path it is describing */
  }
}

/** Increment Backenly's daily usage bucket. No-op in single-tenant. */
export function recordUsageMetrics(
  userId: string,
  projectId: string | undefined,
  delta: UsageMetricsDelta,
): void {
  if (currentEdition() === 'single-tenant') return
  try {
    cloudRecordUsageMetrics(userId, projectId, delta)
  } catch {
    /* as above */
  }
}

/**
 * Verify a proof-of-humanity challenge at signup.
 *
 * Single-tenant admits without one. There is no Turnstile account on a
 * self-hosted box, and registration there is closed after the first account by
 * default, which is a stronger control than any challenge. This mirrors what
 * the old implementation already did when no secret was configured.
 *
 * Unlike the telemetry signals this does NOT swallow errors, because it is an
 * admission decision and a thrown error must not read as "human".
 */
export async function verifySignupChallenge(challenge: SignupChallenge): Promise<ChallengeResult> {
  if (currentEdition() === 'single-tenant') {
    return { ok: true, unconfigured: true }
  }
  return cloudVerifySignupChallenge(challenge)
}
