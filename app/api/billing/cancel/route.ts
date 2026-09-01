export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { Paddle, Environment } from '@paddle/paddle-node-sdk'
import { getUserSubscription } from '@/lib/billing'
import { recordScheduledCancellation } from '@/lib/billing/grace'
import { notifySubscriptionCanceled } from '@/lib/notifications/platform'

/**
 * POST /api/billing/cancel
 * Schedule cancellation of the user's Paddle subscription at the end of the
 * period they have already paid for.
 *
 * This used to open a seven-day failed-payment grace window, which had nothing
 * to do with the paid period: cancelling on day 1 of a 30-day period ended
 * access on day 8. Paddle is authoritative for how long the customer has paid,
 * so the subscription stays ACTIVE and fully entitled and we only record the
 * date Paddle gives us. The downgrade happens when Paddle sends its terminal
 * subscription.canceled event.
 *
 * 🔒 Protected: Requires authentication
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const subscription = await getUserSubscription(user.userId)

    if (!subscription) {
      return NextResponse.json(
        { error: 'No active subscription found' },
        { status: 404 }
      )
    }

    if (subscription.status === 'FREE') {
      return NextResponse.json(
        { error: 'Cannot cancel a free subscription' },
        { status: 400 }
      )
    }

    if (!subscription.paddleSubscriptionId) {
      return NextResponse.json(
        { error: 'No Paddle subscription ID found' },
        { status: 400 }
      )
    }

    if (!process.env.PADDLE_API_KEY) {
      return NextResponse.json(
        { error: 'Paddle not configured' },
        { status: 500 }
      )
    }

    const paddle = new Paddle(process.env.PADDLE_API_KEY, {
      environment: (process.env.PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox') as Environment
    })

    // Cancel at end of billing period. Nothing is written locally before this
    // resolves — if the provider refuses, the customer is still subscribed and
    // local state must say so.
    const updated = await paddle.subscriptions.cancel(subscription.paddleSubscriptionId, {
      effectiveFrom: 'next_billing_period'
    })

    // cancelScheduledAt is persisted ONLY from an explicit provider
    // scheduledChange.action='cancel' with an effectiveAt. Not from
    // currentBillingPeriod.endsAt, not from the stored currentPeriodEnd: a
    // renewal date is not a cancellation date. If Paddle accepted the
    // cancellation without telling us when it lands, the cancellation is still
    // successfully scheduled — the subscription.updated webhook carries the
    // authoritative date, and until then the field stays as it is rather than
    // holding a number we made up.
    const scheduledChange = (updated as any)?.scheduledChange
    const explicitEffectiveAt =
      scheduledChange?.action === 'cancel' && scheduledChange?.effectiveAt
        ? new Date(scheduledChange.effectiveAt)
        : null

    const persisted =
      explicitEffectiveAt && !Number.isNaN(explicitEffectiveAt.getTime())
        ? explicitEffectiveAt
        : null

    if (persisted) {
      await recordScheduledCancellation(subscription.paddleSubscriptionId, persisted)
    } else {
      console.warn(
        `[Billing Cancel] Provider accepted the cancellation for subscription ${subscription.id} without an explicit effective date; awaiting webhook`
      )
    }

    notifySubscriptionCanceled(user.userId, persisted ?? undefined).catch(() => {})

    // The confirmation may name a date the provider gave us in THIS response
    // even when it is not a cancellation effective date, but it must not
    // overstate it. The stored currentPeriodEnd is deliberately not used here:
    // handleSubscriptionCreated still falls back to a locally computed 30 days
    // when Paddle omits the billing period, so that value cannot be presented
    // as something the provider said.
    const periodEndFromResponse = (updated as any)?.currentBillingPeriod?.endsAt
      ? new Date((updated as any).currentBillingPeriod.endsAt)
      : null
    const periodEndIsUsable = periodEndFromResponse && !Number.isNaN(periodEndFromResponse.getTime())

    const message = persisted
      ? `Subscription cancelled. Your ${subscription.plan.name} plan stays active until ${persisted.toISOString().slice(0, 10)}, then moves to the free plan.`
      : periodEndIsUsable
        ? `Subscription cancelled. Your ${subscription.plan.name} plan stays active to the end of your current billing period (${periodEndFromResponse!.toISOString().slice(0, 10)}), then moves to the free plan.`
        : `Subscription cancelled. Your ${subscription.plan.name} plan stays active until the end of the period you have paid for, then moves to the free plan.`

    return NextResponse.json({
      success: true,
      // Reflects what was actually stored — null until the provider states a date.
      cancelScheduledAt: persisted?.toISOString() ?? null,
      message,
    })

  } catch (error: any) {
    console.error('[Billing Cancel] Error:', error?.message)
    return NextResponse.json(
      { error: error.message || 'Failed to cancel subscription' },
      { status: 500 }
    )
  }
})
