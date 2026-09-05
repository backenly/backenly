export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/webhooks
 *
 * Returns recent processed webhook events (Paddle + outbound project webhooks).
 *
 * Query params:
 *   type    - "paddle" | "project" (default: both)
 *   limit   - rows per page (default 50, max 200)
 *   offset  - pagination offset (default 0)
 *
 * FOUNDER-ONLY.
 */
export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { searchParams } = request.nextUrl
  const type   = searchParams.get('type') ?? 'all'
  const limit  = Math.min(parseInt(searchParams.get('limit')  ?? '50'), 200)
  const offset = parseInt(searchParams.get('offset') ?? '0')

  const results: Record<string, any> = {}

  // Paddle idempotency log (every inbound Paddle event that was processed)
  if (type === 'all' || type === 'paddle') {
    const [paddleTotal, paddleEvents] = await Promise.all([
      prisma.processedWebhookEvent.count(),
      prisma.processedWebhookEvent.findMany({
        orderBy: { processedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ])
    results.paddle = { events: paddleEvents, total: paddleTotal }
  }

  // Project-level outbound webhooks (per-project webhook configurations)
  if (type === 'all' || type === 'project') {
    const [projectWebhookTotal, projectWebhooks, recentDeliveries] = await Promise.all([
      prisma.webhook.count(),
      prisma.webhook.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          projectId: true,
          eventType: true,
          targetUrl: true,
          active: true,
          createdAt: true,
          project: { select: { name: true } },
        },
      }),
      // Recent delivery logs (last 50 attempts)
      prisma.webhookLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          webhookId: true,
          eventType: true,
          status: true,
          statusCode: true,
          createdAt: true,
          responseBody: true,
        },
      }),
    ])
    results.project = { webhooks: projectWebhooks, total: projectWebhookTotal, recentDeliveries }
  }

  // Audit logs filtered to webhook actions
  const webhookAuditLogs = await prisma.auditLog.findMany({
    where: { type: 'webhook' },
    orderBy: { timestamp: 'desc' },
    take: 20,
    select: {
      id: true,
      action: true,
      timestamp: true,
      userId: true,
      userEmail: true,
      projectId: true,
      details: true,
      metadata: true,
    },
  })

  return NextResponse.json({
    ...results,
    auditLogs: webhookAuditLogs,
    limit,
    offset,
  })
}
