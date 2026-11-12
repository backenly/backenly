/**
 * Whether a user's coding agent is connected to a project over MCP.
 *
 * Connected means the user holds an MCP credential for the project, an
 * `mcp_live_` key or an OAuth connection, that has authenticated at least once
 * and has not expired. lib/mcp/auth.ts stamps `lastUsed` on every authenticated
 * MCP request, including the handshake a host sends when it connects, so this
 * turns true when VS Code, Cursor or Claude Code connects, before the agent has
 * used a single tool. Revoking a key or a connection deletes its row, so it
 * turns false again.
 *
 * It is the user's agent, not the project's. On a shared project a teammate's
 * connection does not wire this user's editor, so it must not hide their
 * "Connect your agent" step.
 *
 * A key nobody has presented yet does not count. Minting one is the first half
 * of connecting; until an agent uses it, nothing is connected.
 *
 * Connected is not at work. MCP over HTTP holds no connection Backenly could
 * watch, so a call is the only sign of an agent at work: `active` is a call
 * within ACTIVE_WITHIN_MS, the one state a green "connected" may claim.
 * Production QA (2026-11-09): "Agent connected", green, six days after the
 * last call.
 */

import { prisma } from '@/lib/db/prisma'

/** How recent the last call must be for the agent to count as at work. */
export const ACTIVE_WITHIN_MS = 60 * 60_000

export interface AgentConnection {
  connected: boolean
  /** It called within ACTIVE_WITHIN_MS. Connected and not active is idle. */
  active: boolean
  /** When the agent last reached Backenly. Null when not connected. */
  lastSeenAt: Date | null
  /**
   * Which client: the label given to the key, or the name an OAuth client
   * registered with (e.g. "Visual Studio Code"). Null for an unlabelled key.
   */
  client: string | null
}

export async function agentConnectionFor(
  projectId: string,
  userId: string,
  now: Date = new Date(),
): Promise<AgentConnection> {
  const latest = await prisma.apiKey.findFirst({
    where: {
      projectId,
      userId,
      scope: 'mcp',
      lastUsed: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { lastUsed: 'desc' },
    select: { lastUsed: true, mcpClientLabel: true },
  })
  if (!latest?.lastUsed) return { connected: false, active: false, lastSeenAt: null, client: null }
  return {
    connected: true,
    active: now.getTime() - latest.lastUsed.getTime() < ACTIVE_WITHIN_MS,
    lastSeenAt: latest.lastUsed,
    client: latest.mcpClientLabel || null,
  }
}
