export const dynamic = 'force-dynamic'

/**
 * Rotate a webhook's signing secret.
 *
 * POST, not PATCH on the parent: rotating is not editing a field, it is
 * invalidating every signature the receiver has been told to trust. Giving it
 * its own route means it needs its own request, cannot be triggered by a stray
 * key in an edit body, and reads unambiguously in an audit of what a session
 * did.
 *
 * ADMIN, not DEVELOPER. A rotation breaks the receiver until its configuration
 * is updated, which is the same "not undoable from the dashboard" bar that
 * holds deletion one rank above ordinary writes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { rotateWebhookSecret } from '@/lib/webhooks'
import { guardWebhookRoute } from '@/lib/webhooks/route-guard'

export const POST = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, webhookId } = await params

  const denied = await guardWebhookRoute(user.userId, projectId, 'admin')
  if (denied) return denied

  const rotated = await rotateWebhookSecret(projectId, webhookId)
  if (!rotated) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  // The second and last time this value is ever returned by any route.
  return NextResponse.json({ secret: rotated.secret })
})
