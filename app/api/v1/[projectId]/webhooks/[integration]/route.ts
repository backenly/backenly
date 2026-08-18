/**
 * WEBHOOK RECEIVER
 * ================
 * Receives inbound webhooks from Stripe, Resend, Twilio, etc.
 * Validates the signature, then fires matching AI functions.
 *
 * URL pattern: POST /api/v1/{projectId}/webhooks/{integration}
 *
 * Examples:
 *   POST /api/v1/proj_abc/webhooks/stripe   ← Stripe sends payment events here
 *   POST /api/v1/proj_abc/webhooks/resend   ← Email delivery events
 *   POST /api/v1/proj_abc/webhooks/custom   ← Any arbitrary source
 *
 * AI functions with triggerType='on_webhook' and triggerTable matching the
 * integration name (e.g. 'stripe') will be fired with the validated payload.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'
import { executeAiFunction, FunctionEvent } from '@/lib/services/ai-functions/executor'
import { ERROR_TAXONOMY } from '@/lib/errors/taxonomy'

// ── Stripe signature validation ────────────────────────────────────────────────

// Stripe recommends rejecting events older than 5 minutes (300 seconds)
const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300

async function validateStripeSignature(
  rawBody: string,
  sigHeader: string,
  webhookSecret: string
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const parts = sigHeader.split(',').reduce((acc: Record<string, string>, part) => {
      const [k, v] = part.split('=')
      if (k && v !== undefined) acc[k] = v
      return acc
    }, {})

    const timestamp = parts['t']
    const signatures = sigHeader
      .split(',')
      .filter(p => p.startsWith('v1='))
      .map(p => p.slice(3))

    if (!timestamp || signatures.length === 0) {
      return { valid: false, reason: 'Missing timestamp or signature in header' }
    }

    // ── Replay protection: reject events older than tolerance window ───────────
    const eventTimestampSec = parseInt(timestamp, 10)
    if (isNaN(eventTimestampSec)) {
      return { valid: false, reason: 'Non-numeric timestamp in Stripe-Signature header' }
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const ageSec = Math.abs(nowSec - eventTimestampSec)
    if (ageSec > STRIPE_TIMESTAMP_TOLERANCE_SECONDS) {
      return {
        valid: false,
        reason: `Webhook timestamp is ${ageSec}s old (tolerance: ${STRIPE_TIMESTAMP_TOLERANCE_SECONDS}s). Possible replay attack.`,
      }
    }

    const signedPayload = `${timestamp}.${rawBody}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')

    if (!signatures.includes(computed)) {
      return { valid: false, reason: 'HMAC signature mismatch' }
    }
    return { valid: true }
  } catch {
    return { valid: false, reason: 'Exception during signature validation' }
  }
}

// ── Generic HMAC validation (for custom integrations) ──────────────────────────

async function validateHmacSignature(
  rawBody: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
    const received = sigHeader.replace(/^sha256=/, '')
    return computed === received
  } catch {
    return false
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ projectId: string; integration: string }> }
) {
  const params = await props.params;
  const { projectId, integration } = params
  const integrationLower = integration.toLowerCase()

  // Read raw body (needed for signature validation)
  const rawBody = await request.text()
  let payload: Record<string, any>

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // ── Validate project exists ────────────────────────────────────────────────
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // ── Integration-specific signature validation ──────────────────────────────
  // Security policy:
  //   Stripe: webhook secret is required; missing secret is a hard reject.
  //   Generic: webhook secret is required; missing secret is a hard reject.
  //   When a secret is configured, signatures must be valid.
  //
  // Rationale: inbound webhooks can mutate project state through AI functions,
  // so unsigned delivery is fail-closed by default.

  if (integrationLower === 'stripe') {
    const webhookSecret = await getIntegrationKey(projectId, 'stripe_webhook_secret').catch(() => null)

    if (!webhookSecret) {
      console.warn(`[Webhook] Stripe webhook rejected — no webhook secret configured for project ${projectId}`)
      return NextResponse.json(
        { error: 'Stripe webhook secret is not configured for this project. Add it in integration settings.' },
        { status: 401 }
      )
    }

    const sigHeader = request.headers.get('stripe-signature') || ''
    if (!sigHeader) {
      return NextResponse.json({ error: 'Missing Stripe-Signature header' }, { status: 401 })
    }

    const { valid: signatureValid, reason: sigReason } = await validateStripeSignature(rawBody, sigHeader, webhookSecret)
    if (!signatureValid) {
      const taxonomy = ERROR_TAXONOMY.WEBHOOK_VERIFY_FAILURE
      console.warn(
        `[Webhook][${taxonomy.code}] Stripe signature rejected for project ${projectId}: ${sigReason}. ` +
        taxonomy.operatorGuidance
      )
      return NextResponse.json(
        {
          error: 'Invalid webhook signature',
          reason: sigReason,
          errorCode: taxonomy.code,
          operatorGuidance: taxonomy.operatorGuidance,
        },
        { status: 401 }
      )
    }
  } else {
    // Generic HMAC validation for other integrations
    const webhookSecret = await getIntegrationKey(projectId, `${integrationLower}_webhook_secret`).catch(() => null)

    if (webhookSecret) {
      // Secret is configured — validate the signature; reject if missing or wrong
      const sigHeader =
        request.headers.get('x-webhook-signature') ||
        request.headers.get('x-hub-signature-256') ||
        request.headers.get(`x-${integrationLower}-signature`) || ''

      if (!sigHeader) {
        return NextResponse.json(
          { error: `Missing webhook signature header for ${integration} integration` },
          { status: 401 }
        )
      }

      const signatureValid = await validateHmacSignature(rawBody, sigHeader, webhookSecret)
      if (!signatureValid) {
        const taxonomy = ERROR_TAXONOMY.WEBHOOK_VERIFY_FAILURE
        console.warn(
          `[Webhook][${taxonomy.code}] Invalid HMAC signature for ${integrationLower} on project ${projectId}. ` +
          taxonomy.operatorGuidance
        )
        return NextResponse.json(
          {
            error: 'Invalid webhook signature',
            errorCode: taxonomy.code,
            operatorGuidance: taxonomy.operatorGuidance,
          },
          { status: 401 }
        )
      }
    } else {
      return NextResponse.json(
        { error: `${integration} webhook secret is not configured for this project. Add ${integrationLower}_webhook_secret before accepting webhooks.` },
        { status: 401 }
      )
    }
  }

  // ── Build event payload ────────────────────────────────────────────────────
  const event: FunctionEvent = {
    type: 'webhook',
    table: integrationLower, // used as the "trigger table" filter
    data: payload,
  }

  // Add integration-specific event type field to the data
  if (integrationLower === 'stripe' && payload.type) {
    event.data = { ...payload, _event_type: payload.type }
  }

  // ── Stripe: deterministic business logic for standard events ──────────────
  // These run regardless of whether AI functions are configured, providing
  // reliable workspace-table updates for the most important Stripe events.
  if (integrationLower === 'stripe' && payload.type) {
    await handleStripeBusinessLogic(projectId, payload).catch(err =>
      console.error(`[Webhook] Stripe business logic error for project ${projectId}:`, err)
    )
  }

  // ── Find and fire matching AI functions ───────────────────────────────────
  // Match functions with triggerType='on_webhook' and triggerTable=integration
  const functions = await prisma.aiFunction.findMany({
    where: {
      projectId,
      status: 'active',
      triggerType: 'on_webhook',
      triggerTable: integrationLower,
    },
    select: { id: true, name: true },
  })

  if (functions.length === 0) {
    // Also check for wildcard webhook functions (triggerTable = null or 'any')
    const wildcardFunctions = await prisma.aiFunction.findMany({
      where: {
        projectId,
        status: 'active',
        triggerType: 'on_webhook',
        triggerTable: null,
      },
      select: { id: true, name: true },
    })

    if (wildcardFunctions.length === 0) {
      // No functions registered — still return 200 so the provider doesn't retry
      console.log(`[Webhook] No active on_webhook functions for ${integrationLower} on project ${projectId}`)
      return NextResponse.json({ received: true, functionsTriggered: 0 })
    }

    // Execute wildcard functions
    await Promise.allSettled(
      wildcardFunctions.map(fn => executeAiFunction(fn.id, projectId, event))
    )
    return NextResponse.json({ received: true, functionsTriggered: wildcardFunctions.length })
  }

  // Execute matching functions in parallel (non-blocking from caller's perspective)
  await Promise.allSettled(
    functions.map(fn => executeAiFunction(fn.id, projectId, event))
  )

  console.log(`[Webhook] Fired ${functions.length} function(s) for ${integrationLower} webhook on project ${projectId}`)
  return NextResponse.json({ received: true, functionsTriggered: functions.length })
}

// ── Stripe business logic ─────────────────────────────────────────────────────
// Handles standard Stripe events deterministically against workspace tables.
// This runs in addition to (not instead of) any AI-function webhook handlers.

async function handleStripeBusinessLogic(projectId: string, payload: Record<string, any>): Promise<void> {
  const eventType: string = payload.type
  const data = payload.data?.object ?? {}
  const schemaName = `workspace_${projectId}`

  // Idempotency: skip if already logged
  const eventId: string = payload.id
  if (eventId) {
    const alreadyLogged = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'payment_events'`,
      schemaName
    ).then(r => {
      if (Number(r[0]?.count ?? 0) === 0) return false
      return prisma.$queryRawUnsafe<{ count: number }[]>(
        `SELECT COUNT(*)::int AS count FROM "${schemaName}"."payment_events" WHERE stripe_event_id = $1`,
        eventId
      ).then(r2 => Number(r2[0]?.count ?? 0) > 0)
    }).catch(() => false)

    if (alreadyLogged) {
      console.log(`[Webhook] Stripe event ${eventId} already processed (idempotent), skipping`)
      return
    }

    // Log the event
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schemaName}"."payment_events"
         (stripe_event_id, event_type, payload, processed, processed_at)
       VALUES ($1, $2, $3::jsonb, true, now())
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      eventId, eventType, JSON.stringify(payload)
    ).catch(() => {}) // Table may not exist yet on first event before executor runs
  }

  switch (eventType) {
    // ── payment_intent.succeeded → update order, credit wallet, send notification ─
    case 'payment_intent.succeeded': {
      const paymentIntentId: string = data.id
      const amountReceived: number = data.amount_received ?? data.amount ?? 0
      const currency: string = data.currency ?? 'usd'
      const metadata: Record<string, string> = data.metadata ?? {}
      if (!paymentIntentId) break

      // 1. Update orders table (match by stripe_payment_intent_id)
      const updatedOrders = await prisma.$executeRawUnsafe(
        `UPDATE "${schemaName}"."orders"
            SET status = 'paid',
                stripe_payment_intent_id = $1,
                "updatedAt" = now()
          WHERE stripe_payment_intent_id = $1`,
        paymentIntentId
      ).catch(() => 0)

      // 2. Update payments table
      await prisma.$executeRawUnsafe(
        `UPDATE "${schemaName}"."payments"
            SET status = 'paid',
                stripe_payment_intent_id = $1,
                "updatedAt" = now()
          WHERE stripe_payment_intent_id = $1`,
        paymentIntentId
      ).catch(() => {})

      // 3. Credit wallet top-up — if metadata.credits_amount is set, this was a
      //    credit purchase. Add credits to the user's wallet atomically.
      const creditsAmount = metadata.credits_amount ? parseInt(metadata.credits_amount, 10) : 0
      const userId = metadata.user_id ?? metadata.userId ?? null
      if (creditsAmount > 0 && userId) {
        // Try wallet model first (single row with balance column)
        const walletUpdated = await prisma.$executeRawUnsafe(
          `UPDATE "${schemaName}"."credit_wallets"
              SET balance = balance + $1, "updatedAt" = now()
            WHERE user_id = $2`,
          creditsAmount, userId
        ).catch(() => 0)

        // Fall back to ledger model (insert positive credit transaction)
        if (!walletUpdated) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "${schemaName}"."credit_transactions" (user_id, amount, reason, stripe_payment_intent_id, "createdAt")
             VALUES ($1, $2, 'purchase', $3, now())
             ON CONFLICT DO NOTHING`,
            userId, creditsAmount, paymentIntentId
          ).catch(() => {})
        }

        console.log(`[Webhook] Credited ${creditsAmount} credits to user ${userId}`)
      }

      // 4. Decrement stock for ordered products (if order line items exist)
      //    Looks for an order_items / line_items table linked to the paid order
      if (updatedOrders > 0) {
        // Try to decrement product stock atomically (prevents overselling)
        await prisma.$executeRawUnsafe(
          `UPDATE "${schemaName}"."products" p
              SET stock_quantity = GREATEST(0, p.stock_quantity - oi.quantity),
                  "updatedAt" = now()
             FROM "${schemaName}"."order_items" oi
             JOIN "${schemaName}"."orders" o ON oi.order_id = o.id
            WHERE p.id = oi.product_id
              AND o.stripe_payment_intent_id = $1`,
          paymentIntentId
        ).catch(() => {}) // Tables may not exist in all projects — non-fatal

        // Insert success notification for the end-user who placed the order
        const orderUserRow = await prisma.$queryRawUnsafe<{ user_id: string; id: string }[]>(
          `SELECT user_id, id FROM "${schemaName}"."orders"
            WHERE stripe_payment_intent_id = $1 LIMIT 1`,
          paymentIntentId
        ).catch(() => [] as { user_id: string; id: string }[])

        const orderUserId = orderUserRow[0]?.user_id
        const orderId = orderUserRow[0]?.id
        if (orderUserId) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "${schemaName}"."notifications" (user_id, type, title, message, "createdAt")
             VALUES ($1, 'payment_succeeded', 'Payment Confirmed',
                     $2, now())
             ON CONFLICT DO NOTHING`,
            orderUserId,
            `Your payment of ${(amountReceived / 100).toFixed(2)} ${currency.toUpperCase()} was successful. Order ${orderId ?? paymentIntentId} is confirmed.`
          ).catch(() => {})
        }
      }

      console.log(`[Webhook] payment_intent.succeeded processed: ${paymentIntentId} (${(amountReceived / 100).toFixed(2)} ${currency})`)
      break
    }

    // ── checkout.session.completed → mark order paid, record intent ──────────
    case 'checkout.session.completed': {
      const sessionId: string = data.id
      const paymentIntentId: string | undefined = data.payment_intent
      if (!sessionId) break

      await prisma.$executeRawUnsafe(
        `UPDATE "${schemaName}"."orders"
            SET status = 'paid',
                stripe_payment_intent_id = $1,
                updated_at = now()
          WHERE stripe_session_id = $2`,
        paymentIntentId ?? null, sessionId
      ).catch(() => {})

      await prisma.$executeRawUnsafe(
        `UPDATE "${schemaName}"."payments"
            SET status = 'paid',
                stripe_payment_intent_id = $1,
                updated_at = now()
          WHERE stripe_session_id = $2`,
        paymentIntentId ?? null, sessionId
      ).catch(() => {})

      console.log(`[Webhook] checkout.session.completed processed for project ${projectId}`)
      break
    }

    // ── customer.subscription.updated ────────────────────────────────────────
    case 'customer.subscription.updated': {
      const subscriptionId: string = data.id
      const status: string = data.status ?? 'unknown'
      const currentPeriodEnd: Date | null = data.current_period_end
        ? new Date(data.current_period_end * 1000)
        : null

      await prisma.$executeRawUnsafe(
        `UPDATE "${schemaName}"."subscriptions"
            SET status = $1,
                current_period_end = $2,
                updated_at = now()
          WHERE stripe_subscription_id = $3`,
        status, currentPeriodEnd, subscriptionId
      ).catch(() => {})

      console.log(`[Webhook] customer.subscription.updated (${status}) processed for project ${projectId}`)
      break
    }

    // ── customer.subscription.deleted → downgrade to inactive ────────────────
    case 'customer.subscription.deleted': {
      const subscriptionId: string = data.id

      await prisma.$executeRawUnsafe(
        `UPDATE "${schemaName}"."subscriptions"
            SET status = 'inactive',
                cancel_at_period_end = true,
                updated_at = now()
          WHERE stripe_subscription_id = $1`,
        subscriptionId
      ).catch(() => {})

      // Send dunning / downgrade notification via workspace notification system
      const userRow = await prisma.$queryRawUnsafe<{ user_id: string }[]>(
        `SELECT user_id FROM "${schemaName}"."subscriptions"
          WHERE stripe_subscription_id = $1 LIMIT 1`,
        subscriptionId
      ).catch(() => [] as { user_id: string }[])

      const endUserId = userRow[0]?.user_id
      if (endUserId) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${schemaName}"."notifications" (user_id, type, title, message, created_at)
           VALUES ($1, 'subscription_canceled', 'Subscription Canceled',
                   'Your subscription has been canceled. You have been downgraded to the free tier.', now())
           ON CONFLICT DO NOTHING`,
          endUserId
        ).catch(() => {}) // notifications table may not exist
      }

      console.log(`[Webhook] customer.subscription.deleted processed for project ${projectId}`)
      break
    }

    // ── invoice.payment_failed → mark subscription past_due + send dunning ───
    case 'invoice.payment_failed': {
      const subscriptionId: string | undefined = data.subscription

      if (subscriptionId) {
        await prisma.$executeRawUnsafe(
          `UPDATE "${schemaName}"."subscriptions"
              SET status = 'past_due',
                  updated_at = now()
            WHERE stripe_subscription_id = $1`,
          subscriptionId
        ).catch(() => {})

        // Retrieve the user_id for dunning email
        const userRow = await prisma.$queryRawUnsafe<{ user_id: string }[]>(
          `SELECT user_id FROM "${schemaName}"."subscriptions"
            WHERE stripe_subscription_id = $1 LIMIT 1`,
          subscriptionId
        ).catch(() => [] as { user_id: string }[])

        const endUserId = userRow[0]?.user_id
        if (endUserId) {
          // Insert dunning notification
          await prisma.$executeRawUnsafe(
            `INSERT INTO "${schemaName}"."notifications" (user_id, type, title, message, created_at)
             VALUES ($1, 'payment_failed', 'Payment Failed',
                     'Your most recent payment failed. Please update your payment method to keep your subscription active.', now())
             ON CONFLICT DO NOTHING`,
            endUserId
          ).catch(() => {})
        }
      }

      console.log(`[Webhook] invoice.payment_failed processed for project ${projectId}`)
      break
    }

    // ── invoice.paid → reset any past_due status ──────────────────────────────
    case 'invoice.paid': {
      const subscriptionId: string | undefined = data.subscription
      if (subscriptionId) {
        await prisma.$executeRawUnsafe(
          `UPDATE "${schemaName}"."subscriptions"
              SET status = 'active',
                  updated_at = now()
            WHERE stripe_subscription_id = $1
              AND status = 'past_due'`,
          subscriptionId
        ).catch(() => {})
      }
      break
    }

    default:
      // Unrecognised event — already logged in payment_events, nothing else to do
      break
  }
}
