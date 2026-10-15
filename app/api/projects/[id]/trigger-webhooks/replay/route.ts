export const dynamic = 'force-dynamic'

/**
 * Replay a dead-lettered trigger delivery from the console — the same
 * operation `webhooks { action: "replay_trigger_delivery" }` performs over
 * MCP, through the same service function, so the two doors cannot drift.
 *
 * POST /api/projects/[id]/trigger-webhooks/replay  { deliveryLogId }
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { replayDelivery } from '@/lib/services/trigger-service'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    const deliveryLogId = typeof body.deliveryLogId === 'string' ? body.deliveryLogId : ''
    if (!deliveryLogId) {
      return NextResponse.json({ error: 'deliveryLogId is required' }, { status: 400 })
    }
    const result = await replayDelivery(validated.projectId, deliveryLogId)
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? 'Replay failed' }, { status: 422 })
    }
    return NextResponse.json({ success: true })
  })
}
