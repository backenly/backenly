export const dynamic = 'force-dynamic'

/**
 * Send a real test delivery and report what actually happened.
 *
 * The temptation with a button like this is to report success when the request
 * was dispatched. A restore step in the recovery tranche did exactly that —
 * returned a cheerful string having restored nothing — and the rule that came
 * out of it applies here: the answer describes the RESULT, not the attempt.
 *
 * So the response carries the receiver's status code, its error, and the log id
 * of the row this created. A 500 from the receiver reports `success: false`
 * with 500, not "test sent".
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { sendTestDelivery } from '@/lib/webhooks'
import { guardWebhookRoute } from '@/lib/webhooks/route-guard'

export const POST = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId } = await params

  // Write, not read: this sends live traffic to a third party and adds a row
  // to the delivery history. A VIEWER may read what happened and may not cause
  // it to happen.
  const denied = await guardWebhookRoute(user.userId, projectId, 'write')
  if (denied) return denied

  const result = await sendTestDelivery(projectId, webhookId)
  if (!result) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  return NextResponse.json({
    success: result.success,
    statusCode: result.statusCode ?? null,
    error: result.error ?? null,
    blocked: result.blocked ?? false,
    logId: result.logId,
  })
})
