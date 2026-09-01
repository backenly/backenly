export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { Paddle, EventName, Environment } from '@paddle/paddle-node-sdk'
import { prisma } from '@/lib/db/prisma'
import {
  startPaymentFailureGrace,
  recordScheduledCancellation,
  clearScheduledCancellation,
  downgradeToFreePlan,
} from '@/lib/billing/grace'
import {
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifySubscriptionCanceled,
} from '@/lib/notifications/platform'

// Initialize Paddle client for webhook verification
const paddle = new Paddle(process.env.PADDLE_API_KEY!, {
  environment: (process.env.PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox') as Environment
})


/**
 * POST /api/billing/webhook
 * Handle Paddle webhook events
 * 🔒 Verified by Paddle signature
 */
export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get('paddle-signature')
    const rawBody = await request.text()

    if (!signature) {
      return NextResponse.json(
        { error: 'Missing paddle-signature header' },
        { status: 401 }
      )
    }

    if (!process.env.PADDLE_WEBHOOK_SECRET) {
      console.error('[Paddle Webhook] PADDLE_WEBHOOK_SECRET not configured')
      return NextResponse.json(
        { error: 'Webhook secret not configured' },
        { status: 500 }
      )
    }

    // Verify webhook signature
    let event
    try {
      event = paddle.webhooks.unmarshal(
        rawBody,
        process.env.PADDLE_WEBHOOK_SECRET,
        signature
      )
    } catch (error) {
      console.error('[Paddle Webhook] Signature verification failed:', error)
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      )
    }

    if (!event) {
      return NextResponse.json(
        { error: 'Failed to parse webhook event' },
        { status: 400 }
      )
    }

    // Idempotency check — DB-backed so it works across Vercel instances
    const eventId = event.eventId
    const alreadyProcessed = await prisma.processedWebhookEvent.findUnique({
      where: { id: eventId },
    })
    if (alreadyProcessed) {
      console.log(`[Paddle Webhook] Event ${eventId} already processed, skipping`)
      return NextResponse.json({ received: true, idempotent: true })
    }

    console.log(`[Paddle Webhook] Processing event: ${event.eventType} (${eventId})`)

    // Handle different event types
    switch (event.eventType) {
      case EventName.SubscriptionCreated:
        await handleSubscriptionCreated(event.data)
        break

      case EventName.SubscriptionUpdated:
        await handleSubscriptionUpdated(event.data)
        break

      case EventName.SubscriptionCanceled:
        await handleSubscriptionCanceled(event.data)
        break

      case EventName.SubscriptionPastDue:
        await handleSubscriptionPastDue(event.data)
        break

      case EventName.SubscriptionActivated:
        await handleSubscriptionActivated(event.data)
        break

      default:
        console.log(`[Paddle Webhook] Unhandled event type: ${event.eventType}`)
    }

    // Mark event as processed in DB
    await prisma.processedWebhookEvent.create({ data: { id: eventId } })

    return NextResponse.json({ received: true })

  } catch (error: any) {
    console.error('[Paddle Webhook] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Webhook processing failed' },
      { status: 500 }
    )
  }
}

/**
 * Handle subscription.created event
 */
async function handleSubscriptionCreated(data: any) {
  const { id, customerId, items, customData } = data
  
  // Extract userId from custom data
  const userId = customData?.userId
  const planName = customData?.planName

  if (!userId || !planName) {
    console.error('[Paddle Webhook] Missing userId or planName in custom data')
    return
  }

  // Get plan from database
  const plan = await prisma.plan.findUnique({
    where: { name: planName }
  })

  if (!plan) {
    console.error(`[Paddle Webhook] Plan ${planName} not found`)
    return
  }

  // Deactivate any existing active/grace paid subscriptions for this user.
  // One active subscription per user — this prevents duplicate billing records
  // in the rare case a second checkout slips through before the guard fires.
  await prisma.subscription.updateMany({
    where: {
      userId,
      status: { in: ['ACTIVE', 'GRACE'] },
      paddleSubscriptionId: { not: id },   // don't touch the one we're about to create
    },
    data: { status: 'CANCELED', updatedAt: new Date() },
  })

  // Create or update subscription
  await prisma.subscription.upsert({
    where: { paddleSubscriptionId: id },
    update: {
      status: 'ACTIVE',
      currentPeriodEnd: new Date(data.currentBillingPeriod?.endsAt || Date.now() + 30 * 24 * 60 * 60 * 1000),
      // A newly created subscription cannot carry a pending cancellation from a
      // previous life of the same provider id.
      cancelScheduledAt: null,
    },
    create: {
      userId,
      planId: plan.id,
      paddleSubscriptionId: id,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(data.currentBillingPeriod?.endsAt || Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  })

  console.log(`[Paddle Webhook] Subscription created for user ${userId}, plan ${planName}`)

  // Billing attaches to the org (Phase 6): bind this subscription to the user's
  // organization so the team's plan resolves through the org. Non-fatal — the
  // subscription is already valid on userId alone.
  try {
    const { ensurePersonalOrg } = await import('@/lib/org')
    const orgId = await ensurePersonalOrg(userId)
    await prisma.subscription.updateMany({
      where: { paddleSubscriptionId: id },
      data: { organizationId: orgId },
    })
  } catch (e) {
    console.warn('[Paddle Webhook] org attach skipped:', (e as any)?.message)
  }

  // Notify developer
  const periodEnd = data.currentBillingPeriod?.endsAt ? new Date(data.currentBillingPeriod.endsAt) : undefined
  notifyPaymentSuccess(userId, planName, periodEnd).catch(() => {})

  // Referral: if this user was referred, reward the referrer on their FIRST
  // paid subscription. Idempotent — the grant only flips signup→paid once, so a
  // duplicated webhook never double-pays. Non-fatal.
  import('@/lib/billing/referral')
    .then((m) => m.applyReferralOnFirstPayment(userId))
    .catch(() => {})
}

/**
 * Handle subscription.updated event
 *
 * The convergence point for provider state we did not initiate. Paddle sends
 * this when a cancellation is scheduled — including one made in Paddle's own
 * customer portal, which our API never sees — and again when that scheduled
 * change is removed. Reading `scheduledChange` here is what makes the provider
 * authoritative rather than our own endpoint.
 *
 * A scheduled cancellation deliberately does NOT change status: the customer
 * has paid through the period and stays ACTIVE and entitled until Paddle sends
 * the terminal subscription.canceled event.
 */
async function handleSubscriptionUpdated(data: any) {
  const { id, status, currentBillingPeriod } = data

  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId: id }
  })

  if (!subscription) {
    console.error(`[Paddle Webhook] Subscription ${id} not found`)
    return
  }

  // A terminal state can arrive on this event as well as on subscription.canceled.
  // Route it to the same handler so the two orderings cannot diverge.
  if (status === 'canceled') {
    await applyTerminalCancellation(id)
    return
  }

  // Map Paddle status to our status. `canceled` is handled above.
  //
  // past_due needs care about ordering. Paddle sends subscription.updated
  // alongside the lifecycle events, so this can arrive AFTER
  // subscription.past_due has already opened the recovery window. Writing
  // PAST_DUE over GRACE there would revoke access instantly — PAST_DUE is not
  // in the entitlement filter — and strand a graceUntil that nothing reads.
  // The recovery window is ours to close, so once it is open the provider
  // repeating "past_due" changes nothing.
  let newStatus: string = subscription.status
  if (status === 'active') newStatus = 'ACTIVE'
  else if (status === 'past_due') newStatus = subscription.status === 'GRACE' ? 'GRACE' : 'PAST_DUE'

  await prisma.subscription.update({
    where: { paddleSubscriptionId: id },
    data: {
      status: newStatus as any,
      currentPeriodEnd: currentBillingPeriod?.endsAt
        ? new Date(currentBillingPeriod.endsAt)
        : subscription.currentPeriodEnd,
      updatedAt: new Date()
    }
  })

  await syncScheduledCancellation(id, data)

  console.log(`[Paddle Webhook] Subscription ${id} updated to ${newStatus}`)
}

/**
 * Mirror the provider's scheduled-change state onto cancelScheduledAt.
 *
 * cancelScheduledAt means one thing: a date Paddle told us a cancellation
 * takes effect. It is therefore written ONLY from
 * scheduledChange.action === 'cancel' together with an explicit
 * scheduledChange.effectiveAt. Never from currentBillingPeriod.endsAt, never
 * from the stored currentPeriodEnd, never from a local clock — a renewal date
 * is not a cancellation date, and storing one under this name would make the
 * field a second billing clock again.
 *
 * Absence and null are different statements. The SDK normalises a missing
 * scheduled_change to null (`subscription.scheduled_change ? new … : null`)
 * and always defines the property, so on any unmarshalled payload null is the
 * provider explicitly saying "nothing is scheduled" and is safe to act on. A
 * payload with no such key at all has said nothing about cancellation, so it
 * must leave the stored value alone rather than silently un-cancel someone.
 *
 * Only `cancel` is mirrored. `pause` and `resume` are separate lifecycle
 * concepts this platform does not offer, and treating them as cancellations
 * would schedule a downgrade the customer never asked for.
 */
async function syncScheduledCancellation(paddleSubscriptionId: string, data: any) {
  // The payload never mentioned scheduled changes — not a statement about them.
  if (!data || !('scheduledChange' in data)) return

  const scheduledChange = data.scheduledChange

  if (scheduledChange === null) {
    // Explicit: nothing is scheduled. Reversal, or never scheduled at all.
    // clearScheduledCancellation no-ops when nothing was recorded.
    await clearScheduledCancellation(paddleSubscriptionId)
    return
  }

  if (scheduledChange?.action !== 'cancel') {
    // pause / resume / anything else — says nothing about a cancellation.
    return
  }

  if (!scheduledChange.effectiveAt) {
    // A cancel is scheduled but the provider did not say when. Inventing a date
    // here is exactly the defect this field exists to avoid; a later update
    // carries the real one.
    console.warn(
      `[Paddle Webhook] Scheduled cancellation without an effectiveAt for ${paddleSubscriptionId} — not persisting a date`
    )
    return
  }

  const at = new Date(scheduledChange.effectiveAt)
  if (Number.isNaN(at.getTime())) {
    console.warn(`[Paddle Webhook] Unparseable scheduled cancellation date for ${paddleSubscriptionId}`)
    return
  }

  await recordScheduledCancellation(paddleSubscriptionId, at)
}

/**
 * Handle subscription.canceled event
 *
 * This is terminal: Paddle sends it when paid access has actually ended, not
 * when a cancellation is requested. A cancellation requested with
 * `next_billing_period` arrives here at the period end, after the customer has
 * used everything they paid for.
 *
 * It used to call initiateGracePeriod, which handed the customer a further
 * seven days of a paid plan they had stopped paying for — and, because that
 * function only matched ACTIVE or PAST_DUE rows, silently did nothing at all
 * when the cancel endpoint had already moved them to GRACE.
 */
async function handleSubscriptionCanceled(data: any) {
  await applyTerminalCancellation(data?.id)
}

/**
 * The single terminal downgrade. Idempotent: downgradeToFreePlan leaves a
 * subscription that is already on the free plan untouched, so a redelivered or
 * duplicated provider event cannot double-apply or corrupt state.
 */
async function applyTerminalCancellation(paddleSubscriptionId: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId },
    select: { id: true, userId: true },
  })

  if (!subscription) {
    console.error(`[Paddle Webhook] Subscription ${paddleSubscriptionId} not found`)
    return
  }

  const changed = await downgradeToFreePlan(subscription.id, 'PROVIDER_CANCELED')

  if (changed) {
    notifySubscriptionCanceled(subscription.userId).catch(() => {})
    console.log(
      `[Paddle Webhook] Subscription ${paddleSubscriptionId} ended — user ${subscription.userId} moved to the free plan`
    )
  } else {
    console.log(
      `[Paddle Webhook] Subscription ${paddleSubscriptionId} already on the free plan — terminal event ignored`
    )
  }
}

/**
 * Handle subscription.past_due event
 *
 * Payment failure is the only customer lifecycle that opens an automatic grace
 * window. Paddle retries the charge; if it succeeds subscription.activated
 * clears the window, and if it never does the daily cron downgrades once
 * graceUntil passes.
 *
 * One write, not two. The old handler set PAST_DUE and then immediately
 * overwrote it with GRACE, so PAST_DUE never survived a statement while the
 * admin UI still rendered a badge for it.
 */
async function handleSubscriptionPastDue(data: any) {
  const { id } = data

  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId: id }
  })

  if (!subscription) {
    console.error(`[Paddle Webhook] Subscription ${id} not found`)
    return
  }

  const graceUntil = await startPaymentFailureGrace(subscription.userId)

  notifyPaymentFailed(subscription.userId, graceUntil).catch(() => {})

  console.log(`[Paddle Webhook] Subscription ${id} past due — payment grace started for user ${subscription.userId}`)
}

/**
 * Handle subscription.activated event
 * Fires on both initial activation AND on each successful billing period renewal.
 * We reset the user's monthly usage counter here so limits refresh each cycle.
 *
 * This is payment recovery: it clears the failed-payment grace window and
 * nothing else. It must not assume anything about a scheduled cancellation —
 * a customer can cancel at period end and still have this month's payment
 * succeed, and erasing cancelScheduledAt here would silently un-cancel them.
 * The provider's own scheduledChange on this payload decides, via
 * syncScheduledCancellation.
 */
async function handleSubscriptionActivated(data: any) {
  const { id, currentBillingPeriod } = data

  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId: id }
  })

  if (!subscription) {
    console.error(`[Paddle Webhook] Subscription ${id} not found`)
    return
  }

  const newPeriodEnd = currentBillingPeriod?.endsAt
    ? new Date(currentBillingPeriod.endsAt)
    : undefined

  await prisma.subscription.update({
    where: { paddleSubscriptionId: id },
    data: {
      status: 'ACTIVE',
      currentPeriodEnd: newPeriodEnd,
      graceUntil: null, // clear the failed-payment window on successful payment
      updatedAt: new Date()
    }
  })

  await syncScheduledCancellation(id, data)

  // Reset usage for the new billing period
  await resetUserMonthlyUsage(subscription.userId)

  // Notify developer — get plan name for the notification
  try {
    const sub = await prisma.subscription.findUnique({
      where: { paddleSubscriptionId: id },
      include: { plan: { select: { name: true } } },
    })
    if (sub?.plan?.name) {
      notifyPaymentSuccess(subscription.userId, sub.plan.name, newPeriodEnd).catch(() => {})
    }
  } catch { /* non-fatal */ }

  console.log(`[Paddle Webhook] Subscription ${id} activated/renewed for user ${subscription.userId}`)
}

/**
 * Delete the current-month usage record so that plan limits reset
 * immediately when a billing period renews (fire-and-forget safe).
 */
async function resetUserMonthlyUsage(userId: string): Promise<void> {
  const currentMonth = new Date().toISOString().slice(0, 7)
  try {
    await prisma.userAiUsage.deleteMany({
      where: { userId, date: currentMonth },
    })
    console.log(`[Paddle Webhook] Reset monthly usage for user ${userId} (month: ${currentMonth})`)
  } catch (err) {
    console.error(`[Paddle Webhook] Failed to reset usage for user ${userId}:`, err)
  }
}
