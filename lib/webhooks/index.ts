/**
 * Webhook System Library
 *
 * Delivers outbound webhooks with HMAC signing, persistent retry, and
 * dead-letter handling.  PRO plan feature.
 *
 * Retry schedule (5 attempts total):
 *   Attempt 1 — immediate (inline with the originating request)
 *   Attempt 2 — 5 s   (scheduled via retryFailedWebhooks cron)
 *   Attempt 3 — 30 s
 *   Attempt 4 — 5 min
 *   Attempt 5 — 30 min
 *   After attempt 5 — status=DEAD_LETTER, event emitted, notification created
 *
 * Key design decisions:
 *   - deliverWebhook()       → one attempt only, never sleeps, never blocks
 *   - retryFailedWebhooks()  → called from cron, handles scheduled retries
 *   - deliverSingleAttempt() → shared single-attempt helper used by both paths
 */

import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'
import { emit } from '@/lib/events/bus'

// ─── Retry schedule ───────────────────────────────────────────────────────────

/** ms to wait before attempt N (0-based index). Attempt 0 = immediate. */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 300_000, 1_800_000] as const
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookEventType = 'row.inserted' | 'row.updated' | 'row.deleted' | 'auth.user.created'

export interface WebhookPayload {
  event: WebhookEventType
  timestamp: string
  projectId: string
  data: Record<string, any>
}

export interface WebhookDeliveryResult {
  success: boolean
  statusCode?: number
  error?: string
  responseBody?: string
}

// ─── HMAC Signing ─────────────────────────────────────────────────────────────

/** Generate sha256=<hex> HMAC signature. */
export function generateWebhookSignature(payload: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

/** Constant-time signature comparison. */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature
  const expected = generateWebhookSignature(payload, secret).slice(7)
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

// ─── Single Attempt ───────────────────────────────────────────────────────────

/**
 * Perform ONE HTTP delivery attempt.
 * Does not retry, does not sleep, does not update the WebhookLog.
 * Returns the raw result so the caller can decide what to do next.
 *
 * Timeout: 10 s per attempt (enough for a slow endpoint, but won't block long).
 */
export async function deliverSingleAttempt(
  webhookId: string,
  targetUrl: string,
  secret: string,
  payload: WebhookPayload,
  logId: string,
  attemptNumber: number = 1
): Promise<WebhookDeliveryResult> {
  const payloadString = JSON.stringify(payload)
  const signature = generateWebhookSignature(payloadString, secret)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': payload.event,
        'X-Webhook-Attempt': String(attemptNumber),
        'X-Webhook-ID': webhookId,
        'User-Agent': 'Backenly-Webhook/1.0',
      },
      body: payloadString,
      signal: controller.signal,
    })

    clearTimeout(timer)
    const responseBody = await response.text().catch(() => null)

    if (response.ok) {
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'SUCCESS',
          statusCode: response.status,
          responseBody: responseBody?.slice(0, 1000) ?? null,
          attemptCount: attemptNumber,
          deliveredAt: new Date(),
        },
      })
      return {
        success: true,
        statusCode: response.status,
        responseBody: responseBody?.slice(0, 1000) ?? undefined,
      }
    }

    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}: ${response.statusText}`,
      responseBody: responseBody?.slice(0, 1000) ?? undefined,
    }
  } catch (err: any) {
    clearTimeout(timer)
    return {
      success: false,
      error: err.name === 'AbortError' ? 'Request timed out (10 s)' : err.message,
    }
  }
}

// ─── Primary Delivery ─────────────────────────────────────────────────────────

/**
 * Attempt immediate delivery of a webhook (attempt #1).
 * If it fails, schedules the next retry without blocking the caller.
 *
 * This is the function called inline from row-mutation handlers.
 * It performs exactly ONE HTTP request and returns immediately on failure.
 */
export async function deliverWebhook(
  webhookId: string,
  targetUrl: string,
  secret: string,
  payload: WebhookPayload,
  logId: string
): Promise<WebhookDeliveryResult> {
  const result = await deliverSingleAttempt(webhookId, targetUrl, secret, payload, logId, 1)

  if (result.success) return result

  // Schedule retry #2 (5 s from now) — subsequent retries handled by cron
  await _scheduleRetry(logId, result, 1)

  return result
}

// ─── Retry Scheduling ─────────────────────────────────────────────────────────

/**
 * Record the failure of attempt `attemptNumber` and either:
 *   - Schedule the next retry (if attemptNumber < MAX_ATTEMPTS)
 *   - Move to DEAD_LETTER and emit an event (if exhausted)
 */
async function _scheduleRetry(
  logId: string,
  lastResult: WebhookDeliveryResult,
  attemptNumber: number
): Promise<void> {
  const nextAttempt = attemptNumber + 1

  if (nextAttempt > MAX_ATTEMPTS) {
    // All retries exhausted → dead letter
    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'DEAD_LETTER',
        attemptCount: attemptNumber,
        error: lastResult.error ?? null,
        statusCode: lastResult.statusCode ?? null,
        responseBody: lastResult.responseBody?.slice(0, 1000) ?? null,
        nextRetryAt: null,
      },
    })

    // Notify via event bus → creates a PlatformNotification for the project owner
    const log = await prisma.webhookLog.findUnique({
      where: { id: logId },
      include: { webhook: { select: { projectId: true, targetUrl: true } } },
    })

    if (log?.webhook) {
      emit('webhook.dead_letter', log.webhook.projectId, {
        webhookId: log.webhookId,
        logId,
        targetUrl: log.webhook.targetUrl,
        attempts: attemptNumber,
        error: lastResult.error,
      })
    }
  } else {
    const delayMs = RETRY_DELAYS_MS[nextAttempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
    const nextRetryAt = new Date(Date.now() + delayMs)

    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'RETRYING',
        attemptCount: attemptNumber,
        error: lastResult.error ?? null,
        statusCode: lastResult.statusCode ?? null,
        responseBody: lastResult.responseBody?.slice(0, 1000) ?? null,
        nextRetryAt,
      },
    })
  }
}

// ─── Cron: Retry Scheduled Webhooks ──────────────────────────────────────────

/**
 * Process all webhook logs in RETRYING state whose nextRetryAt has passed.
 * Called every minute by the system cron scheduler.
 *
 * Returns the number of logs processed (attempted, regardless of outcome).
 */
export async function retryFailedWebhooks(): Promise<number> {
  const now = new Date()

  const pending = await prisma.webhookLog.findMany({
    where: {
      status: 'RETRYING',
      nextRetryAt: { lte: now },
      attemptCount: { lt: MAX_ATTEMPTS },
    },
    include: {
      webhook: {
        select: { id: true, targetUrl: true, secret: true, active: true },
      },
    },
  })

  if (pending.length === 0) return 0

  await Promise.allSettled(
    pending.map(async (log) => {
      // Skip disabled webhooks (owner may have paused it)
      if (!log.webhook.active) {
        await prisma.webhookLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', error: 'Webhook disabled — skipping retry' },
        })
        return
      }

      const nextAttempt = log.attemptCount + 1
      const payload = log.payload as unknown as WebhookPayload

      const result = await deliverSingleAttempt(
        log.webhookId,
        log.webhook.targetUrl,
        log.webhook.secret,
        payload,
        log.id,
        nextAttempt
      )

      if (!result.success) {
        await _scheduleRetry(log.id, result, nextAttempt)
      }
    })
  )

  console.log(`[Webhooks] Processed ${pending.length} scheduled webhook retry(ies)`)
  return pending.length
}

// ─── Webhook Triggering ───────────────────────────────────────────────────────

/**
 * Trigger outbound webhooks for a project event.
 * Delivery is fire-and-forget — failures are logged and retried by cron.
 */
export async function triggerWebhooks(
  projectId: string,
  eventType: WebhookEventType,
  data: Record<string, any>
): Promise<void> {
  const webhooks = await prisma.webhook.findMany({
    where: { projectId, eventType, active: true },
  })

  if (webhooks.length === 0) return

  const payload: WebhookPayload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    projectId,
    data,
  }

  await Promise.all(
    webhooks.map(async (webhook) => {
      const log = await prisma.webhookLog.create({
        data: {
          webhookId: webhook.id,
          eventType,
          payload: payload as any,
          signature: generateWebhookSignature(JSON.stringify(payload), webhook.secret),
        },
      })

      // Fire-and-forget: don't await delivery so the HTTP response isn't delayed
      deliverWebhook(webhook.id, webhook.targetUrl, webhook.secret, payload, log.id).catch(
        err => console.warn('[Webhooks] deliverWebhook error (non-fatal):', err?.message)
      )
    })
  )
}

// ─── Webhook Management ───────────────────────────────────────────────────────

export async function createWebhook(
  projectId: string,
  eventType: WebhookEventType,
  targetUrl: string
) {
  return prisma.webhook.create({
    data: { projectId, eventType, targetUrl, secret: crypto.randomBytes(32).toString('hex') },
  })
}

export async function getProjectWebhooks(projectId: string) {
  return prisma.webhook.findMany({
    where: { projectId },
    include: { _count: { select: { logs: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getWebhookLogs(webhookId: string, limit = 50) {
  return prisma.webhookLog.findMany({
    where: { webhookId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

export async function deleteWebhook(webhookId: string, projectId: string) {
  return prisma.webhook.deleteMany({ where: { id: webhookId, projectId } })
}

export async function toggleWebhook(webhookId: string, projectId: string, active: boolean) {
  return prisma.webhook.updateMany({ where: { id: webhookId, projectId }, data: { active } })
}
