export const dynamic = 'force-dynamic'

/**
 * Send one failed delivery again, from the console's endpoint page.
 *
 * The agent could already do this (`webhooks { action: "redeliver" }`,
 * lib/webhooks/agent-actions.ts); the console showed a delivery that gave up
 * and offered nothing. Both doors now call the same service function,
 * redeliverWebhookLog, so they cannot drift: only a FAILED or DEAD_LETTER
 * delivery of an endpoint that is on qualifies, the original payload is sent
 * as ONE new attempt signed with the current secret, and the original row is
 * left as it was.
 *
 * Both ids come from the path and both reach the query: the delivery must
 * belong to this endpoint, and the endpoint to this project, or the answer is
 * the same 404 a missing id gets (the confused-deputy rule in ../../route.ts).
 *
 * The answer describes the RESULT, as the test route's does: the receiver's
 * status code, its error and the new log id. A refusal says why, in the
 * service's own words, as a 409: the delivery exists and is in a state that
 * cannot be sent again.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { redeliverWebhookLog } from '@/lib/webhooks'
import { guardWebhookRoute } from '@/lib/webhooks/route-guard'

export const POST = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId, logId } = await params

  // Write, as Send test: it sends live traffic to a third party and adds a row
  // to the delivery history, and sending again needs a plan with webhooks
  // (lib/webhooks/plan.ts). A VIEWER may read what happened, not cause it.
  const denied = await guardWebhookRoute(user.userId, projectId, 'write')
  if (denied) return denied

  const result = await redeliverWebhookLog(projectId, logId, webhookId)
  if (!result) return NextResponse.json({ error: 'Delivery not found' }, { status: 404 })

  if ('refused' in result) {
    return NextResponse.json(
      { error: `Not sent again: ${result.refused}.`, code: 'NOT_REPLAYABLE', status: result.status },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success: result.success,
    statusCode: result.statusCode ?? null,
    error: result.error ?? null,
    blocked: result.blocked ?? false,
    logId: result.logId,
    replayOf: result.replayOf,
  })
})
