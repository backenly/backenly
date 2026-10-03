export const dynamic = 'force-dynamic'

/**
 * One webhook: read, edit, enable/disable, delete.
 *
 * Every handler here takes BOTH ids from the path and passes both to the
 * service. That is the rule the authorization sweep arrived at the hard way:
 * `getResource(resourceId)` after a project authorization check is not scoped
 * by anything, because the check and the query are about different things.
 * The service functions below have no overload that takes a webhook id alone.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getWebhook, updateWebhook, deleteWebhook } from '@/lib/webhooks'
import { isWebhookEventType, WEBHOOK_EVENT_TYPES } from '@/lib/webhooks/events'
import { syncWebhookCapture } from '@/lib/webhooks/capture'
import { guardWebhookRoute } from '@/lib/webhooks/route-guard'
import { BlockedOutboundError } from '@/lib/security/outbound-guard'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'read')
  if (denied) return denied

  const webhook = await getWebhook(projectId, webhookId)
  if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  return NextResponse.json({
    webhook: {
      id: webhook.id,
      eventType: webhook.eventType,
      targetUrl: webhook.targetUrl,
      active: webhook.active,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
      logCount: webhook._count.logs,
    },
  })
})

/**
 * Edit destination, event, or enabled state.
 *
 * Unknown fields are ignored rather than applied — `secret` in particular.
 * Letting a PATCH body set the signing secret would hand an attacker who can
 * reach this route the ability to choose a key and then forge signed traffic
 * the receiver trusts. Rotation is a separate route that generates its own.
 */
export const PATCH = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'write')
  if (denied) return denied

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
  }

  const changes: { eventType?: any; targetUrl?: string; active?: boolean } = {}

  if (body.targetUrl !== undefined) {
    if (typeof body.targetUrl !== 'string' || !body.targetUrl) {
      return NextResponse.json({ error: 'targetUrl must be a non-empty string' }, { status: 400 })
    }
    changes.targetUrl = body.targetUrl
  }

  if (body.eventType !== undefined) {
    if (!isWebhookEventType(body.eventType)) {
      return NextResponse.json(
        { error: `eventType must be one of: ${WEBHOOK_EVENT_TYPES.join(', ')}` },
        { status: 400 },
      )
    }
    changes.eventType = body.eventType
  }

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return NextResponse.json({ error: 'active must be a boolean' }, { status: 400 })
    }
    changes.active = body.active
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json(
      { error: 'Nothing to change. Send targetUrl, eventType or active.' },
      { status: 400 },
    )
  }

  let updated
  try {
    updated = await updateWebhook(projectId, webhookId, changes)
  } catch (err) {
    if (err instanceof BlockedOutboundError) {
      return NextResponse.json({ error: err.message, code: 'BLOCKED_DESTINATION' }, { status: 400 })
    }
    throw err
  }

  if (!updated) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  // Enabling, disabling or re-pointing a webhook changes which events this
  // project needs captured. Syncing here is what makes a disabled webhook stop
  // costing a trigger on every write.
  let captureError: string | null = null
  try {
    await syncWebhookCapture(projectId)
  } catch (err: any) {
    captureError = err?.message ?? String(err)
    console.warn('[webhooks] capture sync failed after update:', captureError)
  }

  return NextResponse.json({
    webhook: {
      id: updated.id,
      eventType: updated.eventType,
      targetUrl: updated.targetUrl,
      active: updated.active,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
    captureError,
  })
})

export const DELETE = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'admin')
  if (denied) return denied

  // deleteMany with both ids: a webhook belonging to another project matches
  // nothing and reports zero, which becomes the same 404 a missing id gets.
  // The victim's row is not read, not touched, and not confirmed to exist.
  const result = await deleteWebhook(webhookId, projectId)
  if (result.count === 0) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  let captureError: string | null = null
  try {
    await syncWebhookCapture(projectId)
  } catch (err: any) {
    captureError = err?.message ?? String(err)
    console.warn('[webhooks] capture sync failed after delete:', captureError)
  }

  return NextResponse.json({ success: true, captureError })
})
