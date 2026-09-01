/**
 * Failed-payment grace, and the one downgrade that ends a subscription.
 *
 * Two things used to live in here under one name. `initiateGracePeriod` was
 * called both when a payment failed and when a customer voluntarily cancelled,
 * so a cancellation invented its own seven-day entitlement window that had
 * nothing to do with the period the customer had paid for. Cancelling on day 1
 * of a 30-day period cost them the remaining 22 days, and the customer was
 * emailed a payment-failure notice for a payment that never failed.
 *
 * They are now separate concepts and they share no state:
 *
 *   payment failure   → status GRACE + graceUntil, a recovery window we choose
 *   voluntary cancel  → status stays ACTIVE, cancelScheduledAt mirrors the
 *                       provider's date, entitlement runs to the paid period end
 *
 * Only the provider ends a subscription. Both paths converge on
 * downgradeToFreePlan(), which is the single place that moves a subscription
 * onto the free tier.
 */

import { prisma } from '@/lib/db/prisma'
import type { Plan } from '@prisma/client'
import { resolveFreePlan } from '@/lib/billing'

// ============================================================================
// TYPES
// ============================================================================

export interface GraceCheckResult {
  frozen: boolean
  reason?: 'GRACE_EXPIRED' | 'OVER_LIMIT'
  graceEndsAt?: Date
  message?: string
}

/**
 * How long a customer keeps access after a payment fails, while the provider
 * retries the charge. This is OUR policy number and applies to payment failure
 * only — a voluntary cancellation is governed by the provider's period end and
 * must never be measured against this constant.
 */
export const PAYMENT_GRACE_DAYS = 7

// ============================================================================
// PAYMENT-FAILURE GRACE
// ============================================================================

/** The end of the recovery window for a payment that failed at `from`. */
export function paymentGraceDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * Open the recovery window after the provider reports a failed payment.
 *
 * Deliberately narrow: this is reachable from subscription.past_due and from
 * the founder's manual extend_grace override, and from nothing else. If you are
 * about to call this because a customer cancelled, you want
 * recordScheduledCancellation() instead.
 *
 * Returns the deadline so the caller can put a real date in the notification
 * rather than recomputing one that might disagree with what was stored.
 */
export async function startPaymentFailureGrace(userId: string): Promise<Date> {
  const graceUntil = paymentGraceDeadline()

  await prisma.subscription.updateMany({
    where: {
      userId,
      status: { in: ['ACTIVE', 'PAST_DUE'] },
    },
    data: {
      status: 'GRACE',
      graceUntil,
    },
  })

  await logBillingLifecycleEvent(userId, 'PAYMENT_GRACE_STARTED', {
    graceUntil: graceUntil.toISOString(),
    reason: 'Provider reported a failed payment',
  })

  return graceUntil
}

// ============================================================================
// SCHEDULED CANCELLATION
// ============================================================================

/**
 * Mirror a provider-scheduled cancellation onto the local subscription.
 *
 * `effectiveAt` must come from the provider (Paddle's
 * scheduledChange.effectiveAt). Never pass a locally computed date: the field
 * exists to reflect provider state, and a second independently calculated
 * billing clock is the bug this whole module was rewritten to remove.
 *
 * Status is untouched on purpose. The customer has paid through the period and
 * stays ACTIVE and fully entitled until the provider's terminal event arrives.
 */
export async function recordScheduledCancellation(
  paddleSubscriptionId: string,
  effectiveAt: Date,
): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId },
    select: { id: true, userId: true, cancelScheduledAt: true },
  })
  if (!subscription) return

  if (subscription.cancelScheduledAt?.getTime() === effectiveAt.getTime()) return

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelScheduledAt: effectiveAt, updatedAt: new Date() },
  })

  await logBillingLifecycleEvent(subscription.userId, 'CANCELLATION_SCHEDULED', {
    effectiveAt: effectiveAt.toISOString(),
    reason: 'Provider scheduled a cancellation at period end',
  })
}

/**
 * The provider reports no scheduled change any more — the cancellation was
 * reversed, in our UI or in the provider's customer portal. Access was never
 * interrupted, so this only clears the marker.
 */
export async function clearScheduledCancellation(
  paddleSubscriptionId: string,
): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId },
    select: { id: true, userId: true, cancelScheduledAt: true },
  })
  if (!subscription?.cancelScheduledAt) return

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelScheduledAt: null, updatedAt: new Date() },
  })

  await logBillingLifecycleEvent(subscription.userId, 'CANCELLATION_REVERSED', {
    reason: 'Provider no longer reports a scheduled cancellation',
  })
}

// ============================================================================
// DOWNGRADE
// ============================================================================

/**
 * Move one subscription onto the free plan. The only way a subscription stops
 * being paid, reached from the provider's terminal cancellation event and from
 * the expiry of a failed-payment recovery window.
 *
 * Idempotent by construction: a subscription already sitting on the free plan
 * with nothing outstanding is left completely alone and reports `false`, so a
 * duplicated provider event cannot write a second audit row or clobber state.
 *
 * `freePlan` is accepted so a batch caller resolves it once instead of per row.
 */
export async function downgradeToFreePlan(
  subscriptionId: string,
  reason: 'GRACE_EXPIRED' | 'PROVIDER_CANCELED',
  freePlan?: Plan,
): Promise<boolean> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true },
  })
  if (!subscription) return false

  const plan = freePlan ?? (await resolveFreePlan())

  const alreadyFree =
    subscription.planId === plan.id &&
    subscription.status === 'FREE' &&
    subscription.graceUntil === null &&
    subscription.cancelScheduledAt === null
  if (alreadyFree) return false

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      planId: plan.id,
      status: 'FREE',
      graceUntil: null,
      cancelScheduledAt: null,
      currentPeriodEnd: null,
      updatedAt: new Date(),
    },
  })

  await logBillingLifecycleEvent(subscription.userId, 'DOWNGRADED_TO_FREE', {
    previousPlan: subscription.plan.name,
    previousStatus: subscription.status,
    freePlan: plan.name,
    reason,
    at: new Date().toISOString(),
  })

  return true
}

/**
 * Downgrade every subscription whose failed-payment recovery window has run
 * out. Called by the daily cron.
 *
 * Scoped strictly to status GRACE, which after the cancellation split can only
 * mean "a payment failed and was never recovered". A scheduled cancellation is
 * ACTIVE and is never selected here; it ends on the provider's terminal event.
 *
 * The free plan is resolved once, before the loop, and a failure to resolve it
 * throws out of the whole run. It used to be looked up per row under the name
 * FREE — which the seed does not create — so every row hit `continue`, the
 * function returned 0, and the cron logged nothing. Expired subscriptions were
 * never downgraded and no signal was produced anywhere. An install that cannot
 * name its free plan is broken, and this must say so rather than quietly
 * reporting that it processed nothing.
 */
export async function processExpiredGracePeriods(): Promise<number> {
  const now = new Date()

  const expiredGraces = await prisma.subscription.findMany({
    where: {
      status: 'GRACE',
      graceUntil: { lt: now },
    },
    select: { id: true, userId: true },
  })

  if (expiredGraces.length === 0) return 0

  // Throws if the install has no free plan. Intentional: without a downgrade
  // target there is no correct outcome, and pretending to succeed is how this
  // failed silently for months.
  const freePlan = await resolveFreePlan()

  let processed = 0

  for (const subscription of expiredGraces) {
    try {
      if (await downgradeToFreePlan(subscription.id, 'GRACE_EXPIRED', freePlan)) {
        processed++
      }
    } catch (error) {
      // Per-row isolation only. One unexpectedly bad row must not strand the
      // rest of the batch; a missing free plan already threw above.
      console.error(
        `[Grace] Failed to downgrade subscription ${subscription.id}:`,
        (error as any)?.message,
      )
    }
  }

  return processed
}

// ============================================================================
// ACCOUNT FREEZE CHECK
// ============================================================================

/**
 * Check if user account is frozen
 * Returns freeze status and reason
 */
export async function isAccountFrozen(userId: string): Promise<GraceCheckResult> {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'FREE', 'GRACE', 'PAST_DUE'] }
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' }
  })

  if (!subscription) {
    return {
      frozen: true,
      reason: 'OVER_LIMIT',
      message: 'No active subscription'
    }
  }

  // Check if in grace period
  if (subscription.status === 'GRACE') {
    if (subscription.graceUntil && subscription.graceUntil < new Date()) {
      // Grace expired - account should be frozen
      return {
        frozen: true,
        reason: 'GRACE_EXPIRED',
        graceEndsAt: subscription.graceUntil,
        message: 'Grace period expired. Please renew your subscription.'
      }
    }
    // Still in grace period - not frozen
    return {
      frozen: false,
      graceEndsAt: subscription.graceUntil || undefined
    }
  }

  // FREE tier: Check if over limits
  if (subscription.status === 'FREE') {
    const overLimit = await checkFreeTierLimits(userId)
    if (overLimit) {
      return {
        frozen: true,
        reason: 'OVER_LIMIT',
        message: 'FREE tier limits exceeded. Upgrade to continue.'
      }
    }
  }

  return { frozen: false }
}

/**
 * Check if FREE tier user is over limits
 */
async function checkFreeTierLimits(userId: string): Promise<boolean> {
  const freePlan = await resolveFreePlan()

  if (freePlan.maxProjects === null) return false

  // Count projects
  const projectCount = await prisma.project.count({
    where: { userId }
  })

  if (projectCount > freePlan.maxProjects) {
    return true
  }

  // Check rows per project (skip for now - will be checked at insert time)
  // TODO: Implement row count check after Prisma client regeneration

  return false
}

// ============================================================================
// INSERT FREEZE ENFORCEMENT
// ============================================================================

/**
 * Enforce freeze on insert operations
 * Call this before any insert operation
 * Can accept either userId or projectId
 */
export async function enforceInsertFreeze(
  userIdOrProjectId: string
): Promise<true | { frozen: true; message: string }> {
  // Try to get userId from project if projectId is passed
  let userId = userIdOrProjectId

  // Check if it looks like a project ID (UUID format)
  if (userIdOrProjectId.includes('-')) {
    const project = await prisma.project.findUnique({
      where: { id: userIdOrProjectId },
      select: { userId: true }
    })
    if (project?.userId) {
      userId = project.userId
    }
  }

  const freezeCheck = await isAccountFrozen(userId)

  if (freezeCheck.frozen) {
    return {
      frozen: true,
      message: freezeCheck.message || 'Account frozen. Please upgrade your plan.'
    }
  }

  return true
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

export type BillingLifecycleEvent =
  | 'PAYMENT_GRACE_STARTED'
  | 'PAYMENT_GRACE_CLEARED'
  | 'CANCELLATION_SCHEDULED'
  | 'CANCELLATION_REVERSED'
  | 'DOWNGRADED_TO_FREE'
  | 'FREEZE_TRIGGERED'

/**
 * Record a billing state transition.
 *
 * Safe to log: internal ids, plan names, our own state names, provider-supplied
 * dates. Never a provider payload, an API key, a signing secret or any payment
 * detail — none of those reach this function and none should be added to it.
 *
 * Never throws. A subscription that was correctly downgraded must not be
 * reported as a failure because its audit row could not be written.
 */
export async function logBillingLifecycleEvent(
  userId: string,
  event: BillingLifecycleEvent,
  metadata: Record<string, any>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: event,
        type: 'BILLING_LIFECYCLE',
        userId,
        details: JSON.stringify(metadata),
        metadata: {
          event,
          timestamp: new Date().toISOString(),
          ...metadata
        }
      }
    })
  } catch (error) {
    console.error('[Billing] Failed to log lifecycle event:', (error as any)?.message)
  }
}

// ============================================================================
// CRON JOB HANDLER
// ============================================================================

/**
 * Daily cron job handler
 * Process expired failed-payment grace periods
 */
export async function runDailyGraceCheck(): Promise<{ processed: number; errors: number }> {
  console.log('[Cron] Running daily payment-grace check...')

  try {
    const processed = await processExpiredGracePeriods()
    console.log(`[Cron] Downgraded ${processed} expired payment-grace subscription(s)`)
    return { processed, errors: 0 }
  } catch (error) {
    // Loud on purpose. The common failure here is a missing free plan, and the
    // old code turned that into a silent "processed 0".
    console.error('[Cron] Payment-grace check FAILED:', (error as any)?.message)
    return { processed: 0, errors: 1 }
  }
}
