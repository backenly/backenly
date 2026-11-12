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
import { RUNNABLE_FUNCTION_STATUS_FILTER } from '@/lib/services/ai-functions/status'
import { ERROR_TAXONOMY } from '@/lib/errors/taxonomy'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { applyStripeEvent, syncReply, type SyncOutcome } from '@/lib/integrations/stripe-sync'

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

async function handlePOST(
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
  // What could not be applied is in the project's logs, in payment_events and
  // in this reply (lib/integrations/stripe-sync.ts). The reply stays 200: a
  // redelivery would meet the same tables, and functions it fired have run.
  let sync: ReturnType<typeof syncReply> | undefined
  if (integrationLower === 'stripe' && payload.type) {
    const outcome = await handleStripeBusinessLogic(projectId, payload).catch((err) => {
      console.error(`[Webhook] Stripe business logic error for project ${projectId}:`, err)
      return undefined
    })
    if (outcome) sync = syncReply(outcome)
  }

  // ── Find and fire matching AI functions ───────────────────────────────────
  // Match functions with triggerType='on_webhook' and triggerTable=integration
  const functions = await prisma.aiFunction.findMany({
    where: {
      projectId,
      status: RUNNABLE_FUNCTION_STATUS_FILTER,
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
        status: RUNNABLE_FUNCTION_STATUS_FILTER,
        triggerType: 'on_webhook',
        triggerTable: null,
      },
      select: { id: true, name: true },
    })

    if (wildcardFunctions.length === 0) {
      // No functions registered — still return 200 so the provider doesn't retry
      console.log(`[Webhook] No active on_webhook functions for ${integrationLower} on project ${projectId}`)
      return NextResponse.json({ received: true, functionsTriggered: 0, ...(sync ? { sync } : {}) })
    }

    // Execute wildcard functions
    await Promise.allSettled(
      wildcardFunctions.map(fn => executeAiFunction(fn.id, projectId, event))
    )
    return NextResponse.json({ received: true, functionsTriggered: wildcardFunctions.length, ...(sync ? { sync } : {}) })
  }

  // Execute matching functions in parallel (non-blocking from caller's perspective)
  await Promise.allSettled(
    functions.map(fn => executeAiFunction(fn.id, projectId, event))
  )

  console.log(`[Webhook] Fired ${functions.length} function(s) for ${integrationLower} webhook on project ${projectId}`)
  return NextResponse.json({ received: true, functionsTriggered: functions.length, ...(sync ? { sync } : {}) })
}

// ── Stripe business logic ─────────────────────────────────────────────────────
// Standard Stripe events applied to the project's own tables, as those tables
// are: lib/integrations/stripe-sync.ts. This runs in addition to (not instead
// of) any AI-function webhook handlers.

export async function handleStripeBusinessLogic(projectId: string, payload: Record<string, any>): Promise<SyncOutcome> {
  return applyStripeEvent(projectId, payload)
}

export const POST = recordedV1(handlePOST)
