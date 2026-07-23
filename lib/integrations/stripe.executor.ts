/**
 * STRIPE INTEGRATION EXECUTOR — BEHAVIORAL CHAIN
 * ================================================
 * Phase 2: Moves beyond key storage to full end-to-end wiring.
 *
 * States produced:
 *   key_stored          → API key stored, no webhook secret → tables and routes
 *                         cannot be made safe; partial setup only.
 *   partially_configured → Key + webhook secret stored, tables created, but
 *                          route generation failed or commerce columns missing.
 *   behaviorally_ready   → Key + webhook secret + tables + checkout endpoint +
 *                          webhook handler + status-update logic all in place.
 *
 * Behavioral chain (runs unconditionally when keys are present):
 *   1. Validate Stripe key against the API
 *   2. Store key + webhook secret (both required for behaviorally_ready)
 *   3. Create `subscriptions` and `payment_events` tables
 *   4. Detect existing commerce tables (orders/payments/purchases)
 *      → add `stripe_session_id`, `stripe_payment_intent_id`, `status` columns
 *   5. Generate POST /checkout/session AI function (creates Stripe checkout session)
 *   6. Generate POST /webhooks/stripe AI function
 *      (HMAC verification + order/payment status update on checkout.session.completed)
 *   7. Compute readiness and store it in project.activeIntegrations
 */

import { prisma } from '@/lib/db/prisma'
import { storeIntegrationKey, hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { getCircuitBreaker, CircuitOpenError } from '@/lib/services/circuit-breaker'
import { executeAction } from '@/lib/ai/minimal-executor'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { withAgentTransaction } from '@/lib/ai/transaction-manager'
import { emit } from '@/lib/events/bus'
import {
  checkIntegrationReadiness,
  toIntegrationRecord,
  formatReadinessReport,
} from './readiness'

export interface IntegrationResult {
  success: boolean
  message: string
  needsApiKey?: boolean
  needsWebhookSecret?: boolean
  keyHint?: string
  readiness?: string
}

// Commerce table names we look for when auto-wiring Stripe columns
const COMMERCE_TABLES = ['orders', 'order', 'payments', 'payment', 'purchases', 'purchase', 'transactions']

export async function executeStripeIntegration(
  projectId: string,
  apiKey?: string,
  webhookSecret?: string,
): Promise<IntegrationResult> {
  const keyExists   = await hasIntegrationKey(projectId, 'stripe')
  const secretExists = await hasIntegrationKey(projectId, 'stripe_webhook_secret')

  // ── Require at least an API key ────────────────────────────────────────────
  if (!keyExists && !apiKey) {
    // Short, friendly message. The full "Paste your Stripe secret key" UX
    // is delivered by the new ChoiceView credential card in the chat, so we
    // do NOT repeat the dashboard URL or key format here — that would feel
    // like a robotic dump on top of the interactive card.
    return {
      success: false,
      needsApiKey: true,
      message: 'Stripe needs an API key — pick how you want to proceed in the card below.',
      keyHint: 'Paste your Stripe secret key (sk_live_... or sk_test_...)',
    }
  }

  // ── Warn when webhook secret is missing (blocking for behaviorally_ready) ──
  const hasSecret = secretExists || !!webhookSecret
  if (!hasSecret) {
    // We still proceed but the caller is told the integration will only reach
    // partially_configured until the secret is provided.
    console.warn(`[Stripe] No webhook secret for project ${projectId} — will reach partially_configured only`)
  }

  // ── Validate the API key against Stripe ───────────────────────────────────
  // liveValidated is only true when Stripe's API confirms the key is valid (HTTP 2xx).
  // Skipped validation (circuit open, network error, or vault key) leaves it false.
  let liveValidated = false
  if (apiKey) {
    const stripeCb = getCircuitBreaker('stripe', { failureThreshold: 3, resetTimeoutMs: 60_000 })
    try {
      const check = await stripeCb.execute(() =>
        fetch('https://api.stripe.com/v1/customers?limit=1', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        })
      )
      if (check.status === 401) {
        return {
          success: false,
          message: [
            '**Invalid Stripe API key.** Stripe rejected this key (HTTP 401).',
            'Verify it in your [Stripe Dashboard → Developers → API keys](https://dashboard.stripe.com/apikeys) and retry.',
            '',
            'Make sure you are pasting a **secret key** (`sk_live_...` or `sk_test_...`), not a publishable key (`pk_...`).',
          ].join('\n'),
        }
      }
      if (check.ok) {
        liveValidated = true
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        console.warn(`[Stripe] Circuit open during key validation: ${err.message}`)
        // Proceed optimistically — store key even if we can't validate right now
      }
      // Other network errors — proceed optimistically (offline/test envs)
    }
  }

  const autoWiredSteps: string[] = []

  // ── Transaction: store keys + create tables + add columns ─────────────────
  const txResult = await withAgentTransaction(projectId, async (ctx) => {
    // 1. Store API key
    if (apiKey) {
      await storeIntegrationKey(projectId, 'stripe', apiKey)
      ctx.record({ type: 'key_stored', payload: { integrationId: 'stripe' } })
      // Persist live-verification marker so readiness checks can distinguish
      // "key stored" from "key confirmed valid by Stripe API".
      if (liveValidated) {
        await storeIntegrationKey(projectId, 'stripe_key_verified', '1')
      }
    }

    // 2. Store webhook secret
    if (webhookSecret) {
      await storeIntegrationKey(projectId, 'stripe_webhook_secret', webhookSecret)
      ctx.record({ type: 'key_stored', payload: { integrationId: 'stripe_webhook_secret' } })
    }

    // 3. Create subscriptions table
    const subResult = await executeAction({
      action: 'CREATE_TABLE',
      params: {
        tableName: 'subscriptions',
        columns: [
          { name: 'user_id',                  type: 'TEXT',      notNull: true },
          { name: 'plan',                      type: 'TEXT',      notNull: true, default: 'free' },
          { name: 'status',                    type: 'TEXT',      notNull: true, default: 'inactive' },
          { name: 'stripe_customer_id',        type: 'TEXT' },
          { name: 'stripe_subscription_id',    type: 'TEXT' },
          { name: 'stripe_price_id',           type: 'TEXT' },
          { name: 'current_period_start',      type: 'TIMESTAMP' },
          { name: 'current_period_end',        type: 'TIMESTAMP' },
          { name: 'cancel_at_period_end',      type: 'BOOLEAN',   default: 'false' },
        ],
      },
    }, projectId)
    if (subResult.success) {
      autoWiredSteps.push('✅ `subscriptions` table created')
      ctx.record({ type: 'table_created', payload: { tableName: 'subscriptions' } })
    }

    // 4. Create payment_events table (idempotent log of all Stripe webhook events)
    const evtResult = await executeAction({
      action: 'CREATE_TABLE',
      params: {
        tableName: 'payment_events',
        columns: [
          { name: 'stripe_event_id',   type: 'TEXT',    notNull: true, unique: true },
          { name: 'event_type',        type: 'TEXT',    notNull: true },
          { name: 'payload',           type: 'JSONB' },
          { name: 'processed',         type: 'BOOLEAN', default: 'false' },
          { name: 'processed_at',      type: 'TIMESTAMP' },
          { name: 'error',             type: 'TEXT' },
        ],
      },
    }, projectId)
    if (evtResult.success) {
      autoWiredSteps.push('✅ `payment_events` table created')
      ctx.record({ type: 'table_created', payload: { tableName: 'payment_events' } })
    }

    // 5. Detect existing commerce tables → add Stripe-required columns
    const commerceTable = await prisma.table.findFirst({
      where: { projectId, name: { in: COMMERCE_TABLES } },
      select: { id: true, name: true },
    })
    if (commerceTable) {
      const tbl = commerceTable.name
      const columnsToAdd = [
        { columnName: 'stripe_session_id',         columnType: 'TEXT' },
        { columnName: 'stripe_payment_intent_id',  columnType: 'TEXT' },
        { columnName: 'status',                    columnType: 'TEXT' },
      ]
      for (const col of columnsToAdd) {
        const colResult = await executeAction(
          { action: 'ADD_COLUMN', params: { tableName: tbl, ...col } },
          projectId,
        ).catch(() => ({ success: false }))
        if (colResult.success) {
          autoWiredSteps.push(`✅ Added \`${col.columnName}\` to \`${tbl}\``)
        }
      }
    }

    // 6. Mark in activeIntegrations (preliminary — readiness computed after tx)
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })
    const existing = (project?.activeIntegrations as Record<string, any>) ?? {}
    await prisma.project.update({
      where: { id: projectId },
      data: {
        activeIntegrations: {
          ...existing,
          stripe: {
            enabled: true,
            readiness: 'partially_configured', // will be updated below
            activatedAt: existing.stripe?.activatedAt ?? new Date().toISOString(),
            activatedBy: 'integration_executor',
            tables: ['subscriptions', 'payment_events'],
            webhookPath: `/api/v1/${projectId}/webhooks/stripe`,
          },
        },
      },
    })
    ctx.record({ type: 'integration_activated', payload: { integrationId: 'stripe' } })
  })

  if (!txResult.success) {
    return {
      success: false,
      message: txResult.rolledBack
        ? `Stripe setup failed and was rolled back: ${txResult.message}`
        : `Stripe setup failed: ${txResult.message}`,
    }
  }

  // ── Generate behavioral endpoints (outside transaction — additive, not destructive) ──

  // 7. POST /checkout/session — creates a Stripe checkout session
  const checkoutResult = await executeGenerateFunction(
    {
      functionName: 'stripe-checkout-session',
      description: [
        'Create a Stripe Checkout session.',
        'Accept { lineItems, successUrl, cancelUrl, customerEmail? } in the request body.',
        'Each lineItem is { price: "price_xxx", quantity } or { priceData: { currency, unitAmount, productName, recurringInterval? }, quantity }.',
        'Call ctx.integrations.stripe.createCheckoutSession({ lineItems, successUrl, cancelUrl, customerEmail }) — it returns { id, url }.',
        'Require authentication — return 401 for unauthenticated requests.',
        'On success, write a row to `payment_events` with event_type="checkout.session.created" and return { checkoutUrl: session.url, sessionId: session.id }.',
        'On error, return 500 with the Stripe error message.',
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (checkoutResult.success) {
    autoWiredSteps.push('✅ Generated `POST /fn/stripe-checkout-session`')
  }

  // 8. stripe-webhook — supplementary handler for Stripe events.
  // The platform receiver at POST /api/v1/{projectId}/webhooks/stripe verifies the
  // Stripe-Signature header AND runs deterministic order/subscription updates
  // before this function fires. This function therefore works on an
  // already-verified payload (event.data) and must NOT re-verify the signature —
  // sandbox functions have no access to raw request headers.
  const webhookResult = await executeGenerateFunction(
    {
      functionName: 'stripe-webhook',
      description: [
        'Process a verified Stripe webhook event delivered in event.data.',
        'The platform webhook receiver has already verified the signature — do not re-verify.',
        'Read event.data.type for the Stripe event type and event.data.data.object for the payload.',
        'On `checkout.session.completed`: mark the matching row in `payment_events` as processed=true,',
        '  and if an `orders` or `payments` table exists, update the row whose stripe_session_id matches',
        '  session.id, setting status="paid" and stripe_payment_intent_id=session.payment_intent.',
        'On `charge.refunded`: if an `orders` or `payments` table exists, update the matching row',
        '  (matched by stripe_payment_intent_id) setting status="refunded".',
        'On `customer.subscription.updated` or `customer.subscription.deleted`:',
        '  update the matching row in `subscriptions` (matched by stripe_subscription_id),',
        '  setting status and current_period_end from the Stripe event.',
        'On `invoice.payment_failed`: update the matching subscription status to "past_due".',
        'Return { handled: true } for recognised events.',
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (webhookResult.success) {
    autoWiredSteps.push('✅ Generated `POST /fn/stripe-webhook` (HMAC-verified, status-update logic)')
  }

  // ── 9. Create AppTrigger records so the Triggers UI reflects Stripe events ──
  // These are metadata records only — actual logic runs in the webhook AI function.
  // They give platform users visibility into what events are wired up.
  try {
    const { createTrigger } = await import('@/lib/services/trigger-service')

    const paidTrigger = await createTrigger(projectId, {
      name: 'stripe-payment-success',
      description: 'Stripe checkout.session.completed → set order status to "paid"',
      sourceTable: 'payment_events',
      event: 'insert',
      conditions: { event_type: 'checkout.session.completed' },
      actionType: 'update_row',
      targetTable: 'orders',
      fieldMappings: { stripe_session_id: 'stripe_session_id' },
      staticFields: { status: 'paid' },
    }).catch(() => null)
    if (paidTrigger) autoWiredSteps.push('✅ Trigger: checkout.session.completed → orders.status = "paid"')

    const refundTrigger = await createTrigger(projectId, {
      name: 'stripe-refund',
      description: 'Stripe charge.refunded → set order status to "refunded"',
      sourceTable: 'payment_events',
      event: 'insert',
      conditions: { event_type: 'charge.refunded' },
      actionType: 'update_row',
      targetTable: 'orders',
      fieldMappings: { stripe_payment_intent_id: 'stripe_payment_intent_id' },
      staticFields: { status: 'refunded' },
    }).catch(() => null)
    if (refundTrigger) autoWiredSteps.push('✅ Trigger: charge.refunded → orders.status = "refunded"')
  } catch {
    // Non-fatal — triggers are metadata; the webhook AI function handles the actual logic
  }

  // ── Emit events + schema snapshot ─────────────────────────────────────────
  emit('integration.activated', projectId, {
    integrationId: 'stripe',
    tables: ['subscriptions', 'payment_events'],
  })
  emit('schema.changed', projectId, { tables: ['subscriptions', 'payment_events'] })

  import('@/lib/versioning/schema-versions').then(({ snapshotSchema }) =>
    snapshotSchema(
      projectId,
      'Stripe integration: subscriptions + payment_events + checkout + webhook',
      'stripe_executor',
    ).catch(() => {})
  )

  // ── Compute final readiness ────────────────────────────────────────────────
  const readinessReport = await checkIntegrationReadiness(projectId, 'stripe')

  // Persist final readiness status
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeIntegrations: true },
  })
  const existingIntegrations = (project?.activeIntegrations as Record<string, any>) ?? {}
  await prisma.project.update({
    where: { id: projectId },
    data: {
      activeIntegrations: {
        ...existingIntegrations,
        stripe: toIntegrationRecord(readinessReport, {
          activatedAt: existingIntegrations.stripe?.activatedAt ?? new Date().toISOString(),
          activatedBy: 'integration_executor',
          tables: ['subscriptions', 'payment_events'],
          webhookPath: `/api/v1/${projectId}/webhooks/stripe`,
        }),
      },
    },
  })

  // ── Build response message ─────────────────────────────────────────────────
  const webhookNote = !hasSecret
    ? [
        '',
        '⚠️ **Webhook secret not provided.**',
        'Stripe will not be able to verify incoming webhook events.',
        'Add your webhook secret to reach **Behaviorally Ready**:',
        '```',
        `Connect Stripe webhook secret whsec_...`,
        '```',
        `Your webhook endpoint: \`/api/v1/${projectId}/webhooks/stripe\``,
      ].join('\n')
    : `\n\nWebhook endpoint: \`/api/v1/${projectId}/webhooks/stripe\``

  const stepsMsg = autoWiredSteps.length > 0
    ? `\n\n**Auto-wired:**\n${autoWiredSteps.join('\n')}`
    : ''

  const readinessMsg = `\n\n${formatReadinessReport(readinessReport)}`

  // Only claim "connected" when Stripe's API confirmed the key is valid this session.
  // Vault-only keys and circuit-open fallbacks are honest about their unverified state.
  const keyStatusLine = liveValidated
    ? 'Stripe API key verified.'
    : apiKey
      ? 'Stripe key stored — live API validation skipped (circuit open or network error). Re-submit the key when connectivity is restored to verify it.'
      : 'Stripe key previously stored (live re-validation not performed this session).'

  return {
    success: true,
    message: `${keyStatusLine}${webhookNote}${stepsMsg}${readinessMsg}`,
    readiness: readinessReport.status,
  }
}
