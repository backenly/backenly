export const dynamic = 'force-dynamic'

/**
 * The webhook collection: list and create.
 *
 * Per-webhook operations live at ./[webhookId]/ rather than behind a
 * `?webhookId=` parameter on this route. That is not tidying. `extractProjectId`
 * was made to prefer the path over the query precisely because a handler that
 * reads its subject from one place and is authorized from another is the
 * confused-deputy shape; keeping the child id in the path means the id being
 * authorized and the id being acted on are the same string.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { createWebhook, getProjectWebhooks } from '@/lib/webhooks'
import { isWebhookEventType, isRowEventType, WEBHOOK_EVENT_TYPES } from '@/lib/webhooks/events'
import { syncWebhookCapture, listCapturedTables } from '@/lib/webhooks/capture'
import { guardWebhookRoute } from '@/lib/webhooks/route-guard'
import { BlockedOutboundError } from '@/lib/security/outbound-guard'

/**
 * The shape the dashboard receives.
 *
 * `secret` is absent, and that is load-bearing. The audit found an auth
 * provider route returning `clientSecret` to any authenticated browser; a
 * signing secret is the same kind of material, because whoever holds it can
 * forge a request the receiver will believe came from Backenly. It is shown
 * once at creation and once at rotation, and is never readable again.
 */
function present(w: Awaited<ReturnType<typeof getProjectWebhooks>>[number]) {
  return {
    id: w.id,
    eventType: w.eventType,
    targetUrl: w.targetUrl,
    active: w.active,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    logCount: w._count.logs,
  }
}

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'read')
  if (denied) return denied

  const webhooks = await getProjectWebhooks(projectId)

  // Capture state is read from information_schema, not from a flag this app
  // set and believed. The PG catalog is the source of truth for what the
  // database is actually doing; a cached "enabled" boolean is how a surface
  // ends up reporting that it works while nothing fires.
  const wantsRowEvents = webhooks.some(w => w.active && isRowEventType(w.eventType))
  const capturedTables = await listCapturedTables(projectId).catch(() => null)

  return NextResponse.json({
    webhooks: webhooks.map(present),
    capture: {
      /** Tables carrying a live capture trigger right now. */
      tables: capturedTables ?? [],
      /** Whether any active webhook needs capture at all. */
      required: wantsRowEvents,
      /**
       * False means row events are subscribed and the database is not
       * capturing them — the webhook would never fire. The dashboard says so
       * out loud rather than showing a green row.
       */
      healthy: !wantsRowEvents || (capturedTables !== null && capturedTables.length > 0),
      /** Null when the workspace schema could not be read at all. */
      readable: capturedTables !== null,
    },
  })
})

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'write')
  if (denied) return denied

  const body = await request.json().catch(() => null)
  const eventType = body?.eventType
  const targetUrl = body?.targetUrl

  if (typeof targetUrl !== 'string' || !targetUrl) {
    return NextResponse.json({ error: 'targetUrl is required' }, { status: 400 })
  }
  if (!isWebhookEventType(eventType)) {
    return NextResponse.json(
      { error: `eventType must be one of: ${WEBHOOK_EVENT_TYPES.join(', ')}` },
      { status: 400 },
    )
  }

  let webhook
  try {
    webhook = await createWebhook(projectId, eventType, targetUrl)
  } catch (err) {
    // The egress guard's reason is shown to the operator verbatim. They typed
    // the URL; telling them "invalid" when the real answer is "that resolves to
    // a loopback address" turns a five-second fix into a support thread.
    if (err instanceof BlockedOutboundError) {
      return NextResponse.json({ error: err.message, code: 'BLOCKED_DESTINATION' }, { status: 400 })
    }
    throw err
  }

  // Attach the database capture for this project's new subscription set. A
  // webhook that exists and captures nothing is the state this whole surface
  // was in before: configured, and never fired.
  //
  // A failure here does not fail the create — the webhook row is real and the
  // next sync will pick it up — but it is REPORTED. Swallowing it would leave
  // the operator looking at a webhook that can never fire, which is the defect
  // this route exists to stop shipping.
  let captureError: string | null = null
  try {
    await syncWebhookCapture(projectId)
  } catch (err: any) {
    captureError = err?.message ?? String(err)
    console.warn('[webhooks] capture sync failed after create:', captureError)
  }

  return NextResponse.json(
    {
      webhook: {
        id: webhook.id,
        eventType: webhook.eventType,
        targetUrl: webhook.targetUrl,
        active: webhook.active,
        createdAt: webhook.createdAt,
        // Shown exactly once. There is no route that returns it again.
        secret: webhook.secret,
      },
      captureError,
    },
    { status: 201 },
  )
})
