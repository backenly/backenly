export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { Paddle, EventName, Environment } from '@paddle/paddle-node-sdk'
import { prisma } from '@/lib/db/prisma'
import { initiateGracePeriod } from '@/lib/billing/grace'
import { notifyPaymentSuccess, notifyPaymentFailed } from '@/lib/notifications/platform'

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
      currentPeriodEnd: new Date(data.currentBillingPeriod?.endsAt || Date.now() + 30 * 24 * 60 * 60 * 1000)
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

  // Map Paddle status to our status
  let newStatus: string = subscription.status
  if (status === 'active') newStatus = 'ACTIVE'
  else if (status === 'canceled') newStatus = 'CANCELED'
  else if (status === 'past_due') newStatus = 'PAST_DUE'

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

  console.log(`[Paddle Webhook] Subscription ${id} updated to ${newStatus}`)
}

/**
 * Handle subscription.canceled event
 *
 * Sets the subscription to GRACE (not CANCELED) so the user still has
 * 7 days of access. getUserSubscription() looks for ['ACTIVE','FREE','GRACE']
 * so GRACE is the correct status for the grace window.
 * The daily cron calls processExpiredGracePeriods() to flip to FREE once
 * graceUntil has passed.
 */
async function handleSubscriptionCanceled(data: any) {
  const { id } = data

  const subscription = await prisma.subscription.findUnique({
    where: { paddleSubscriptionId: id }
  })

  if (!subscription) {
    console.error(`[Paddle Webhook] Subscription ${id} not found`)
    return
  }

  // initiateGracePeriod sets status='GRACE' + graceUntil=now+7d
  await initiateGracePeriod(subscription.userId)

  const graceUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  notifyPaymentFailed(subscription.userId, graceUntil).catch(() => {})

  console.log(`[Paddle Webhook] Subscription ${id} canceled — grace period started for user ${subscription.userId}`)
}

/**
 * Handle subscription.past_due event
 *
 * Paddle fires this when payment fails. We start the 7-day grace period
 * immediately so the user keeps access while Paddle retries payment.
 * If Paddle succeeds, subscription.activated fires and clears the grace.
 * If Paddle ultimately cancels, subscription.canceled fires (also grace).
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

  // Mark as PAST_DUE in DB for UI display, then start grace so user keeps access
  await prisma.subscription.update({
    where: { paddleSubscriptionId: id },
    data: { status: 'PAST_DUE', updatedAt: new Date() }
  })

  // Start grace period — initiateGracePeriod will upgrade PAST_DUE → GRACE
  await initiateGracePeriod(subscription.userId)

  const graceUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  notifyPaymentFailed(subscription.userId, graceUntil).catch(() => {})

  console.log(`[Paddle Webhook] Subscription ${id} past due — grace period started for user ${subscription.userId}`)
}

/**
 * Handle subscription.activated event
 * Fires on both initial activation AND on each successful billing period renewal.
 * We reset the user's monthly usage counter here so limits refresh each cycle.
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
      graceUntil: null, // clear any grace period on successful payment
      updatedAt: new Date()
    }
  })

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
