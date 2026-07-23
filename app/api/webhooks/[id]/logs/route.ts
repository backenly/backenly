export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getWebhookLogs } from '@/lib/webhooks'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/webhooks/[id]/logs
 * Get delivery logs for a webhook
 * 🔒 Protected: Requires authentication + webhook ownership
 */
export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: webhookId } = await params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '50')

    // Check if user owns the webhook
    const webhook = await prisma.webhook.findFirst({
      where: {
        id: webhookId,
        project: {
          userId: user.userId
        }
      }
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const logs = await getWebhookLogs(webhookId, limit)

    // Sanitize response
    const sanitized = logs.map(log => ({
      id: log.id,
      eventType: log.eventType,
      status: log.status,
      statusCode: log.statusCode,
      attemptCount: log.attemptCount,
      error: log.error,
      deliveredAt: log.deliveredAt,
      createdAt: log.createdAt,
      nextRetryAt: log.nextRetryAt
    }))

    return NextResponse.json({ logs: sanitized })

  } catch (error: any) {
    console.error('[Webhook Logs GET] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch webhook logs' },
      { status: 500 }
    )
  }
})
