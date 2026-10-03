export const dynamic = 'force-dynamic'

/**
 * Delivery history for one webhook.
 *
 * Replaces `/api/webhooks/[id]/logs`, which had no project in its path at all.
 * That route authorized with a hand-written `prisma.webhook.findFirst({ where:
 * { id, project: { userId } } })` — the ownership predicate every other route
 * under app/api/projects/** stopped writing inline when ProjectResolver became
 * the single authority. It was not a vulnerability, but it was a second
 * definition of "may this caller see this project", and in Cloud it answered
 * differently: an organization ADMIN who is not the owner row could administer
 * the project and not read its webhook logs.
 *
 * One authority, one answer, and the project id is in the path where the
 * authorization check can see it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getWebhook, getWebhookLogs } from '@/lib/webhooks'
import { guardWebhookRoute } from '@/lib/webhooks/route-guard'

export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'read')
  if (denied) return denied

  // Existence is checked against the project so a webhook id from another
  // tenant returns 404 rather than an empty log list, which would otherwise
  // confirm the id is real and merely quiet.
  const webhook = await getWebhook(projectId, webhookId)
  if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  const raw = new URL(request.url).searchParams.get('limit')
  const limit = raw === null ? 50 : Number(raw)

  const logs = await getWebhookLogs(projectId, webhookId, limit)

  return NextResponse.json({
    logs: logs.map(log => ({
      id: log.id,
      eventType: log.eventType,
      status: log.status,
      statusCode: log.statusCode,
      attemptCount: log.attemptCount,
      error: log.error,
      // The RESPONSE body is the receiver's own words about why it refused,
      // and an operator debugging a 422 needs to read it. The REQUEST payload
      // is not returned: it carries project row data, and a delivery history
      // is not a second, unauthorized read path into the tables.
      responseBody: log.responseBody,
      deliveredAt: log.deliveredAt,
      createdAt: log.createdAt,
      nextRetryAt: log.nextRetryAt,
    })),
  })
})
