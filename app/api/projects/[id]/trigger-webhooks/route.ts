export const dynamic = 'force-dynamic'

/**
 * Trigger webhooks — the console read for what the agent wires over MCP.
 *
 * `webhooks { action: "create_trigger" | "triggers" | "trigger_deliveries" |
 * "replay_trigger_delivery" | "rotate_trigger_secret" }` writes AppTrigger and
 * TriggerDeliveryLog rows, but no console surface rendered either table — an
 * agent-created webhook delivered (or dead-lettered) invisibly. This GET
 * serves the Webhooks page the same rows the MCP tool reads.
 *
 * GET /api/projects/[id]/trigger-webhooks
 *   → { triggers: [...webhook triggers], deliveries: [...recent logs] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { listTriggers, listDeliveryLogs } from '@/lib/services/trigger-service'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const [allTriggers, deliveries] = await Promise.all([
      listTriggers(validated.projectId),
      listDeliveryLogs(validated.projectId, { limit: 50 }),
    ])
    return NextResponse.json({
      triggers: allTriggers.filter((t) => t.actionType === 'webhook'),
      deliveries,
    })
  })
}
