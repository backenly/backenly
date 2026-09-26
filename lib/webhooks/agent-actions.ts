/**
 * The Webhooks page, as operations an agent can run.
 *
 * The dashboard's Webhooks page manages outbound endpoints (this module's
 * siblings) through /api/projects/[id]/webhooks/*. Agents had no way to reach
 * it: the MCP webhooks tool served trigger deliveries, which live in another
 * table. These are the same operations behind the same gates, asked in the
 * same order as route-guard.ts (may this caller act on the project, then does
 * the plan include webhooks), and each one finishes the way its route does,
 * including re-syncing row capture after a change.
 *
 * A signing secret is returned in `data` only, never in `summary`: summaries
 * are what logs and model transcripts keep.
 */

import { canAccessProject, canWriteProject, canAdministerProject } from '@/lib/edition/guard'
import { enforceWebhook } from '@/lib/entitlements/policy'
import {
  createWebhook,
  deleteWebhook,
  getProjectWebhooks,
  getWebhook,
  getWebhookLogs,
  redeliverWebhookLog,
  rotateWebhookSecret,
  sendTestDelivery,
  updateWebhook,
} from '@/lib/webhooks'
import { isRowEventType, isWebhookEventType, WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@/lib/webhooks/events'
import { listCapturedTables, syncWebhookCapture } from '@/lib/webhooks/capture'
import { BlockedOutboundError } from '@/lib/security/outbound-guard'

export interface WebhookActor {
  userId: string
  projectId: string
}

export interface WebhookActionResult {
  ok: boolean
  summary: string
  data?: unknown
  code?: string
}

/** How receivers verify a delivery. Stated once, so every answer says the same thing. */
export const SIGNATURE_NOTE =
  'Each delivery is a POST signed as X-Webhook-Signature: sha256=<HMAC-SHA256 of the raw body with the secret>, ' +
  'with X-Webhook-Event and X-Webhook-Delivery (the log id) alongside.'

type Access = 'read' | 'write' | 'admin'
const GUARD = { read: canAccessProject, write: canWriteProject, admin: canAdministerProject } as const

async function refuse(actor: WebhookActor, access: Access): Promise<WebhookActionResult | null> {
  if (!(await GUARD[access](actor.userId, actor.projectId))) {
    return { ok: false, code: 'PROJECT_NOT_FOUND', summary: 'Project not found, or this key may not do that here.' }
  }
  const entitlement = await enforceWebhook(actor.userId)
  if (entitlement !== true) {
    return {
      ok: false,
      code: 'PLAN_LIMIT_EXCEEDED',
      summary: `Webhooks require the Pro plan (current plan: ${entitlement.currentPlan}). Nothing was changed; a human upgrades the plan.`,
    }
  }
  return null
}

const notFound = (what: string): WebhookActionResult => ({
  ok: false,
  code: 'NOT_FOUND',
  summary: `${what} was not found in this project. List them with webhooks { action: "list" }.`,
})

function present(w: {
  id: string; eventType: string; targetUrl: string; active: boolean
  createdAt: Date; updatedAt: Date; _count?: { logs: number }
}) {
  return {
    id: w.id,
    eventType: w.eventType,
    targetUrl: w.targetUrl,
    active: w.active,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    ...(w._count ? { deliveries: w._count.logs } : {}),
  }
}

/**
 * Row events are captured by a trigger in the workspace schema, which has to
 * follow every change to the set of active row webhooks. The routes do this
 * after the change and report a failure instead of failing the request, since
 * the webhook itself was saved; so do these.
 */
async function resyncCapture(projectId: string): Promise<string | null> {
  try {
    await syncWebhookCapture(projectId)
    return null
  } catch (err: any) {
    return err?.message ?? String(err)
  }
}

function captureWarning(captureError: string | null): string {
  return captureError
    ? `\n\nWARNING: the change was saved, but row-event capture could not be updated (${captureError}), ` +
      'so row events may not be delivered. Check with webhooks { action: "list" } (capture.healthy).'
    : ''
}

function blocked(err: unknown): WebhookActionResult | null {
  return err instanceof BlockedOutboundError
    ? { ok: false, code: 'BLOCKED_DESTINATION', summary: `${err.message} Nothing was saved.` }
    : null
}

function badEventType(value: unknown): WebhookActionResult | null {
  return isWebhookEventType(value)
    ? null
    : { ok: false, code: 'INVALID_ARGUMENT', summary: `eventType must be one of: ${WEBHOOK_EVENT_TYPES.join(', ')}.` }
}

export async function listWebhooks(actor: WebhookActor): Promise<WebhookActionResult> {
  const denied = await refuse(actor, 'read')
  if (denied) return denied

  const webhooks = await getProjectWebhooks(actor.projectId)
  const required = webhooks.some((w) => w.active && isRowEventType(w.eventType))
  const tables = await listCapturedTables(actor.projectId).catch(() => null)
  const capture = {
    tables: tables ?? [],
    required,
    healthy: !required || (tables !== null && tables.length > 0),
    readable: tables !== null,
  }

  const lines = webhooks.map((w) =>
    `• ${w.id}: ${w.eventType} → ${w.targetUrl}${w.active ? '' : ' (disabled)'}, ${w._count.logs} deliveries`)
  return {
    ok: true,
    summary: webhooks.length
      ? `Webhooks (${webhooks.length}):\n${lines.join('\n')}` +
        (capture.healthy ? '' : '\n\nWARNING: an active row webhook exists but no table is being captured, so row events are not being delivered.')
      : `No webhooks yet. Create one with webhooks { action: "create", eventType, targetUrl }; eventType is one of ${WEBHOOK_EVENT_TYPES.join(', ')}.`,
    data: { webhooks: webhooks.map(present), capture },
  }
}

export async function createProjectWebhook(
  actor: WebhookActor,
  args: { eventType?: unknown; targetUrl?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.targetUrl !== 'string' || !args.targetUrl) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'targetUrl is required: the https URL that receives the events.' }
  }
  const invalid = badEventType(args.eventType)
  if (invalid) return invalid
  const denied = await refuse(actor, 'write')
  if (denied) return denied

  let webhook
  try {
    webhook = await createWebhook(actor.projectId, args.eventType as WebhookEventType, args.targetUrl)
  } catch (err) {
    const b = blocked(err)
    if (b) return b
    throw err
  }
  const captureError = await resyncCapture(actor.projectId)

  return {
    ok: true,
    summary:
      `Created webhook ${webhook.id}: ${webhook.eventType} → ${webhook.targetUrl}. ${SIGNATURE_NOTE} ` +
      'The signing secret is in data.secret and is shown once: put it in the receiver\'s environment, never in code.' +
      captureWarning(captureError),
    data: { webhook: present(webhook), secret: webhook.secret, captureError },
  }
}

export async function updateProjectWebhook(
  actor: WebhookActor,
  args: { webhookId?: unknown; targetUrl?: unknown; eventType?: unknown; active?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.webhookId !== 'string' || !args.webhookId) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'webhookId is required.' }
  }
  const changes: { eventType?: WebhookEventType; targetUrl?: string; active?: boolean } = {}
  if (args.targetUrl !== undefined) {
    if (typeof args.targetUrl !== 'string' || !args.targetUrl) {
      return { ok: false, code: 'INVALID_ARGUMENT', summary: 'targetUrl must be a non-empty string.' }
    }
    changes.targetUrl = args.targetUrl
  }
  if (args.eventType !== undefined) {
    const invalid = badEventType(args.eventType)
    if (invalid) return invalid
    changes.eventType = args.eventType as WebhookEventType
  }
  if (args.active !== undefined) {
    if (typeof args.active !== 'boolean') {
      return { ok: false, code: 'INVALID_ARGUMENT', summary: 'active must be true or false.' }
    }
    changes.active = args.active
  }
  if (Object.keys(changes).length === 0) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'Nothing to change: pass targetUrl, eventType or active.' }
  }
  const denied = await refuse(actor, 'write')
  if (denied) return denied

  let updated
  try {
    updated = await updateWebhook(actor.projectId, args.webhookId, changes)
  } catch (err) {
    const b = blocked(err)
    if (b) return b
    throw err
  }
  if (!updated) return notFound(`Webhook ${args.webhookId}`)
  const captureError = await resyncCapture(actor.projectId)

  return {
    ok: true,
    summary: `Updated webhook ${updated.id}: ${updated.eventType} → ${updated.targetUrl}${updated.active ? '' : ' (disabled)'}.` +
      captureWarning(captureError),
    data: { webhook: present(updated), captureError },
  }
}

export async function deleteProjectWebhook(
  actor: WebhookActor,
  args: { webhookId?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.webhookId !== 'string' || !args.webhookId) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'webhookId is required.' }
  }
  const denied = await refuse(actor, 'admin')
  if (denied) return denied

  const result = await deleteWebhook(args.webhookId, actor.projectId)
  if (result.count === 0) return notFound(`Webhook ${args.webhookId}`)
  const captureError = await resyncCapture(actor.projectId)

  return {
    ok: true,
    summary: `Deleted webhook ${args.webhookId} and its delivery history.` + captureWarning(captureError),
    data: { deleted: args.webhookId, captureError },
  }
}

export async function testProjectWebhook(
  actor: WebhookActor,
  args: { webhookId?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.webhookId !== 'string' || !args.webhookId) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'webhookId is required.' }
  }
  const denied = await refuse(actor, 'write')
  if (denied) return denied

  const result = await sendTestDelivery(actor.projectId, args.webhookId)
  if (!result) return notFound(`Webhook ${args.webhookId}`)
  const outcome = result.success
    ? `the receiver answered HTTP ${result.statusCode}`
    : result.blocked
      ? `the destination is refused by the egress guard (${result.error})`
      : `it failed: ${result.error ?? `HTTP ${result.statusCode}`}`
  return {
    // A test that reached a failing receiver is still a test that ran; `ok`
    // says whether the RECEIVER accepted it, which is what was asked.
    ok: result.success,
    code: result.success ? undefined : result.blocked ? 'BLOCKED_DESTINATION' : 'DELIVERY_FAILED',
    summary: `Sent a test delivery (log ${result.logId}); ${outcome}. It carries no project data.`,
    data: { logId: result.logId, success: result.success, statusCode: result.statusCode ?? null, error: result.error ?? null },
  }
}

export async function listWebhookLogs(
  actor: WebhookActor,
  args: { webhookId?: unknown; limit?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.webhookId !== 'string' || !args.webhookId) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'webhookId is required.' }
  }
  const denied = await refuse(actor, 'read')
  if (denied) return denied
  if (!(await getWebhook(actor.projectId, args.webhookId))) return notFound(`Webhook ${args.webhookId}`)

  const limit = typeof args.limit === 'number' ? args.limit : 25
  const logs = await getWebhookLogs(actor.projectId, args.webhookId, limit)
  const lines = logs.slice(0, 10).map((l) =>
    `• ${l.id}: ${l.status}, ${l.eventType}, HTTP ${l.statusCode ?? 'none'}, attempt ${l.attemptCount}` +
    (l.error ? `, ${String(l.error).slice(0, 80)}` : ''))
  return {
    ok: true,
    summary: logs.length
      ? `Deliveries for ${args.webhookId}, newest first:\n${lines.join('\n')}` +
        (logs.length > 10 ? `\n…${logs.length - 10} more in data.deliveries.` : '')
      : `Webhook ${args.webhookId} has no deliveries yet. Send one with webhooks { action: "test", webhookId }.`,
    data: {
      deliveries: logs.map((l) => ({
        id: l.id,
        status: l.status,
        eventType: l.eventType,
        statusCode: l.statusCode,
        attemptCount: l.attemptCount,
        error: l.error,
        responseBody: l.responseBody,
        nextRetryAt: l.nextRetryAt,
        deliveredAt: l.deliveredAt,
        createdAt: l.createdAt,
        payload: l.payload,
      })),
    },
  }
}

export async function rotateProjectWebhookSecret(
  actor: WebhookActor,
  args: { webhookId?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.webhookId !== 'string' || !args.webhookId) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'webhookId is required.' }
  }
  const denied = await refuse(actor, 'admin')
  if (denied) return denied

  const rotated = await rotateWebhookSecret(actor.projectId, args.webhookId)
  if (!rotated) return notFound(`Webhook ${args.webhookId}`)
  return {
    ok: true,
    summary:
      `Rotated the signing secret of webhook ${args.webhookId}. Deliveries from now on are signed with the new one, ` +
      'so the receiver rejects them until it has it. The new secret is in data.secret and is shown once.',
    data: { webhookId: args.webhookId, secret: rotated.secret },
  }
}

export async function replayWebhookDelivery(
  actor: WebhookActor,
  args: { deliveryId?: unknown },
): Promise<WebhookActionResult> {
  if (typeof args.deliveryId !== 'string' || !args.deliveryId) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'deliveryId is required: a log id from webhooks { action: "logs" }.' }
  }
  const denied = await refuse(actor, 'write')
  if (denied) return denied

  const result = await redeliverWebhookLog(actor.projectId, args.deliveryId)
  if (!result) return notFound(`Delivery ${args.deliveryId}`)
  if ('refused' in result) {
    return {
      ok: false,
      code: 'NOT_REPLAYABLE',
      summary: `Delivery ${args.deliveryId} (${result.status}) was not sent again: ${result.refused}.`,
    }
  }
  return {
    ok: result.success,
    code: result.success ? undefined : result.blocked ? 'BLOCKED_DESTINATION' : 'DELIVERY_FAILED',
    summary: result.success
      ? `Sent delivery ${args.deliveryId} again as ${result.logId}; the receiver answered HTTP ${result.statusCode}.`
      : `Sent delivery ${args.deliveryId} again as ${result.logId}, and it failed: ${result.error ?? `HTTP ${result.statusCode}`}.`,
    data: { replayOf: result.replayOf, logId: result.logId, success: result.success, statusCode: result.statusCode ?? null },
  }
}
