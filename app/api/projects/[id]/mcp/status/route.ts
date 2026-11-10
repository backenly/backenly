export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/mcp/status
 *
 * Is the signed-in user's coding agent connected to this project over MCP?
 *
 *   { connected: boolean, active: boolean, lastSeenAt: string | null, client: string | null }
 *
 * Every console surface that offers "Connect your agent" reads this, through
 * lib/hooks/useAgentConnection.ts, so a user whose agent is already wired in is
 * not sent back to the Connect page from every section. The rule itself lives
 * in lib/mcp/agent-connection.ts.
 *
 * Auth: platform session via withProjectValidation, so anyone who can open the
 * project can ask about their own agent. Nothing that identifies a credential
 * is returned: no id, no prefix.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { agentConnectionFor } from '@/lib/mcp/agent-connection'

export async function GET(req: NextRequest) {
  return withProjectValidation<any>(req, async ({ projectId, userId }) => {
    try {
      const status = await agentConnectionFor(projectId, userId)
      return NextResponse.json({
        connected: status.connected,
        active: status.active,
        lastSeenAt: status.lastSeenAt ? status.lastSeenAt.toISOString() : null,
        client: status.client,
      })
    } catch (err) {
      // Clean JSON rather than a framework text 500. The console treats a
      // failed answer as "not connected" and offers the Connect step, which is
      // what every surface did before this route existed.
      console.error('[mcp/status] GET failed:', err)
      return NextResponse.json({ error: 'Could not load the agent connection' }, { status: 500 })
    }
  })
}
