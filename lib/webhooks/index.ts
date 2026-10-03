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
import { safeFetch, assertAllowedUrl, BlockedOutboundError } from '@/lib/security/outbound-guard'
import { WEBHOOK_EVENT_TYPES, isWebhookEventType, type WebhookEventType } from './events'

// ─── Retry schedule ───────────────────────────────────────────────────────────

/** ms to wait before attempt N (0-based index). Attempt 0 = immediate. */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 300_000, 1_800_000] as const
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length

// ─── Types ────────────────────────────────────────────────────────────────────

export type { WebhookEventType }
export { WEBHOOK_EVENT_TYPES, isWebhookEventType }

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
  /**
   * The egress guard refused the destination.
   *
   * Distinct from an ordinary failure because retrying cannot change the
   * answer: the URL resolves somewhere this deployment will not send traffic,
   * and it will still resolve there in thirty minutes. Retrying it four more
   * times would only bury the real message under identical ones.
   */
  blocked?: boolean
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

  try {
    // safeFetch, NOT fetch. This function used to call `fetch(targetUrl)` on a
    // URL the caller supplies, from the unsandboxed web process, and store up
    // to 1 KB of the reply. That is a server-side request forgery primitive
    // with a persistence layer attached: the reachable set included the
    // PostgREST data plane on loopback:3002, the runtime on :3001, the whole
    // VPC, and 169.254.169.254.
    //
    // The guard the function runtime already used covers all of it — scheme,
    // literal address, connect-time DNS (so a rebind cannot win the race),
    // every redirect hop re-validated, and a response size cap. Webhooks get
    // their own private-egress opt-in because "my webhook may reach the
    // container next to me" is the operator's decision to make, and is not the
    // same decision as "generated function code may reach my LAN".
    const response = await safeFetch(targetUrl, {
      method: 'POST',
      egressScope: 'webhook',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': payload.event,
        'X-Webhook-Attempt': String(attemptNumber),
        'X-Webhook-ID': webhookId,
        'X-Webhook-Delivery': logId,
        'User-Agent': 'Backenly-Webhook/1.0',
      },
      body: payloadString,
      timeoutMs: 10_000,
      // A receiver's body is diagnostic only. Anything past this is not going
      // to help an operator read an error message.
      maxBytes: 64 * 1024,
    })

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
      error: `HTTP ${response.status}`,
      responseBody: responseBody?.slice(0, 1000) ?? undefined,
    }
  } catch (err: any) {
    // A refused destination is a permanent configuration fault, not a transient
    // one. Reported distinctly so the operator reads "this URL is not allowed"
    // instead of watching five identical timeouts and guessing.
    if (err instanceof BlockedOutboundError) {
      return { success: false, error: `Destination refused: ${err.message}`, blocked: true }
    }
    return { success: false, error: err?.message ?? String(err) }
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

  // A refused destination is terminal on the first attempt. FAILED rather than
  // DEAD_LETTER: dead-letter means "we tried and they never answered", and
  // raising that alarm for a URL we declined to dial would be describing the
  // wrong problem to whoever reads the notification.
  if (lastResult.blocked) {
    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'FAILED',
        attemptCount: attemptNumber,
        error: lastResult.error ?? 'Destination refused by the egress guard',
        statusCode: null,
        nextRetryAt: null,
      },
    })
    return
  }

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
      // Pausing cancels these; this keeps one created by a drain that was
      // already in flight from being delivered before that cancellation lands.
      webhook: { project: { pausedAt: null } },
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

/**
 * Reject a destination before it is ever stored.
 *
 * Validating at write time is a usability control, not the security boundary:
 * it tells the operator their URL is unusable while they are looking at the
 * form, instead of leaving them to discover it in a delivery log. The boundary
 * is `safeFetch` at delivery time, because a hostname that is public today can
 * point at 169.254.169.254 tomorrow and nothing re-validates a stored row.
 *
 * Both layers are required. Neither is redundant.
 */
export function assertDeliverableUrl(targetUrl: string): void {
  assertAllowedUrl(targetUrl, 'webhook')
}

export async function createWebhook(
  projectId: string,
  eventType: WebhookEventType,
  targetUrl: string
) {
  assertDeliverableUrl(targetUrl)
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

/**
 * One webhook, or null — scoped by project, never by id alone.
 *
 * `findUnique({ where: { id } })` is the shape that produced this program's
 * cross-tenant findings: a child id is not proof of ownership, and a route
 * that authorizes a project and then looks a child up without it has checked
 * nothing. The projectId is in the WHERE clause so the query cannot return
 * another tenant's row even if a caller gets the authorization wrong.
 */
export async function getWebhook(projectId: string, webhookId: string) {
  return prisma.webhook.findFirst({
    where: { id: webhookId, projectId },
    include: { _count: { select: { logs: true } } },
  })
}

/** Hard ceiling on a page of delivery history. */
const MAX_LOG_PAGE = 200

/**
 * Delivery history for one webhook, scoped by project.
 *
 * `limit` is clamped rather than trusted: the previous route passed
 * `parseInt(searchParams.get('limit'))` straight through, so `?limit=abc` sent
 * Prisma a NaN and `?limit=9999999` asked Postgres for every row this project
 * had ever delivered.
 */
export async function getWebhookLogs(projectId: string, webhookId: string, limit = 50) {
  const take = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LOG_PAGE) : 50
  return prisma.webhookLog.findMany({
    where: { webhookId, webhook: { projectId } },
    orderBy: { createdAt: 'desc' },
    take,
  })
}

/**
 * Change a webhook's destination or event.
 *
 * Returns null when the webhook does not belong to this project, which the
 * route turns into the same 404 a missing one gets.
 */
export async function updateWebhook(
  projectId: string,
  webhookId: string,
  changes: { eventType?: WebhookEventType; targetUrl?: string; active?: boolean }
) {
  if (changes.targetUrl !== undefined) assertDeliverableUrl(changes.targetUrl)

  const existing = await prisma.webhook.findFirst({
    where: { id: webhookId, projectId },
    select: { id: true },
  })
  if (!existing) return null

  return prisma.webhook.update({ where: { id: webhookId }, data: changes })
}

/**
 * Issue a new signing secret and return it once.
 *
 * There is no read-back anywhere else: the list route never returns `secret`,
 * and neither does this module's `getWebhook`. An operator who loses it
 * rotates rather than retrieves, which means a leaked dashboard response can
 * never be replayed into a forged signature.
 */
export async function rotateWebhookSecret(projectId: string, webhookId: string) {
  const existing = await prisma.webhook.findFirst({
    where: { id: webhookId, projectId },
    select: { id: true },
  })
  if (!existing) return null

  const secret = crypto.randomBytes(32).toString('hex')
  await prisma.webhook.update({ where: { id: webhookId }, data: { secret } })
  return { secret }
}

/**
 * Deliver a test event to one webhook, now, and report what happened.
 *
 * This performs a REAL request through the same `deliverSingleAttempt` every
 * production delivery uses, and writes a REAL WebhookLog. It is not a
 * simulation and it does not fabricate a history row: an operator who clicks
 * "Send test" and sees SUCCESS has learned that their endpoint is reachable,
 * that their secret verifies, and that their receiver returned 2xx — which is
 * the only reason to offer the button.
 *
 * One attempt, no retry ladder: the operator is standing there watching, and a
 * test that quietly succeeds on attempt four thirty minutes later answers a
 * question nobody asked.
 */
export async function sendTestDelivery(projectId: string, webhookId: string) {
  const webhook = await prisma.webhook.findFirst({ where: { id: webhookId, projectId } })
  if (!webhook) return null

  const payload: WebhookPayload = {
    event: webhook.eventType as WebhookEventType,
    timestamp: new Date().toISOString(),
    projectId,
    data: {
      test: true,
      message: 'Test delivery from Backenly. No project data is included.',
    },
  }

  return deliverOnceAndRecord(webhook, payload)
}

/** Why a delivery cannot be sent again, or null when it can. */
export function replayRefusal(status: string, active: boolean): string | null {
  if (!active) return 'the webhook is disabled; enable it first'
  if (status === 'SUCCESS') return 'it was delivered; sending it again would deliver the event twice'
  if (status === 'PENDING' || status === 'RETRYING') return 'it is still being retried'
  if (status === 'CANCELLED') {
    return 'it was withdrawn when the project was paused, so sending it now would fire a stale event'
  }
  return null
}

/**
 * Send a failed delivery again: the original payload, signed with the
 * webhook's current secret, as ONE new attempt with its own log row.
 *
 * Only FAILED and DEAD_LETTER deliveries qualify (replayRefusal). The original
 * row is left as it was, so the history still says what happened the first
 * time; the new row says what happened now.
 */
export async function redeliverWebhookLog(projectId: string, logId: string) {
  const original = await prisma.webhookLog.findFirst({
    where: { id: logId, webhook: { projectId } },
    include: { webhook: true },
  })
  if (!original) return null

  const refusal = replayRefusal(original.status, original.webhook.active)
  if (refusal) return { refused: refusal, status: original.status }

  const result = await deliverOnceAndRecord(original.webhook, original.payload as unknown as WebhookPayload)
  return { replayOf: original.id, ...result }
}

/**
 * One attempt, recorded honestly: a REAL WebhookLog row, and a failure written
 * as FAILED rather than left looking like a delivery still in progress.
 */
async function deliverOnceAndRecord(
  webhook: { id: string; eventType: string; targetUrl: string; secret: string },
  payload: WebhookPayload,
) {
  const log = await prisma.webhookLog.create({
    data: {
      webhookId: webhook.id,
      eventType: webhook.eventType,
      payload: payload as any,
      signature: generateWebhookSignature(JSON.stringify(payload), webhook.secret),
    },
  })

  const result = await deliverSingleAttempt(
    webhook.id,
    webhook.targetUrl,
    webhook.secret,
    payload,
    log.id,
    1,
  )

  // deliverSingleAttempt only writes the log on success, so a failed attempt
  // would otherwise sit at PENDING for ever and read as "still trying".
  if (!result.success) {
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attemptCount: 1,
        error: result.error ?? null,
        statusCode: result.statusCode ?? null,
        responseBody: result.responseBody?.slice(0, 1000) ?? null,
        nextRetryAt: null,
      },
    })
  }

  return { logId: log.id, ...result }
}

export async function deleteWebhook(webhookId: string, projectId: string) {
  return prisma.webhook.deleteMany({ where: { id: webhookId, projectId } })
}

export async function toggleWebhook(webhookId: string, projectId: string, active: boolean) {
  return prisma.webhook.updateMany({ where: { id: webhookId, projectId }, data: { active } })
}
