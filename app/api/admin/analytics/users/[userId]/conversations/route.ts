export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/analytics/users/[userId]/conversations
 *
 * Returns every backend_chat exchange on this user's projects, grouped by
 * project. Each message is a persisted ConversationMessage (role 'user' | 'ai').
 * FOUNDER-ONLY.
 *
 * ── What role:'user' actually means here ─────────────────────────────────────
 * NOT "the prompt the user typed". Backenly has no in-product chat door since
 * the ChatDock was removed, so the only writer left is an agent over MCP:
 *   /api/mcp/chat → runBrain (lib/ai/brain/agent.ts) → saveTurn
 *   → saveMessages (app/api/ai/chat/pipeline/conversation-store.ts)
 * That row is the message the coding agent COMPOSED and sent on the user's
 * behalf. What someone types into Claude Code goes to Anthropic's model and
 * never reaches this platform, so it cannot appear here and must not be
 * described as though it does.
 *
 * Agents that drive the backend with typed tools (apply_migration, db_insert,
 * set_rls, …) send no natural-language message at all and are invisible to this
 * endpoint by design. Their work is counted in /api/admin/agent-ops.
 *
 * Ordering: newest message first within the payload so the most recent
 * exchanges load first; the client renders each project transcript
 * chronologically (oldest → newest).
 */

// Hard safety cap so a power user with a huge history can't blow up the drawer.
const MAX_MESSAGES = 3000

export async function GET(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { userId } = params

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Every project this user owns — including sandbox/expired ones, since the
  // founder wants the *entire* prompt history, not just live projects.
  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, createdAt: true },
  })

  if (projects.length === 0) {
    return NextResponse.json({ projects: [], totalMessages: 0, truncated: false })
  }

  const projectIds = projects.map((p) => p.id)

  // Pull the user↔AI exchanges. 'system' rows are internal scaffolding, not
  // something the user typed or the assistant "answered", so we exclude them.
  const messages = await prisma.conversationMessage.findMany({
    where: { projectId: { in: projectIds }, role: { in: ['user', 'ai'] } },
    orderBy: { createdAt: 'desc' },
    take: MAX_MESSAGES + 1,
    select: { id: true, projectId: true, role: true, content: true, createdAt: true },
  })

  const truncated = messages.length > MAX_MESSAGES
  const capped = truncated ? messages.slice(0, MAX_MESSAGES) : messages

  // Group by project, then flip each group to chronological (oldest → newest)
  // so a transcript reads top-to-bottom the way it happened.
  const byProject = new Map<string, typeof capped>()
  for (const m of capped) {
    const list = byProject.get(m.projectId) ?? []
    list.push(m)
    byProject.set(m.projectId, list)
  }

  const grouped = projects
    .map((p) => {
      const list = (byProject.get(p.id) ?? []).slice().reverse()
      return {
        projectId: p.id,
        projectName: p.name,
        createdAt: p.createdAt.toISOString(),
        messageCount: list.length,
        messages: list.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'ai',
          content: m.content,
          createdAt: m.createdAt.toISOString(),
        })),
      }
    })
    // Only surface projects that actually have chat history.
    .filter((p) => p.messageCount > 0)

  return NextResponse.json({
    projects: grouped,
    totalMessages: capped.length,
    truncated,
  })
}
