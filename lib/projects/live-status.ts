/**
 * What each of a caller's projects is doing right now, for the projects list.
 *
 * The list (GET /api/projects) says what a project IS: its name, region,
 * tables and when it was last used. This says what is happening to it, read
 * for every listed project at once by GET /api/projects/status:
 *
 *   waiting          things held for a person: the self-healing loop's fixes
 *                    held for approval and the architecture changes Backenly
 *                    prepared (health_findings 'pending_approval'), plus the
 *                    calls a coding agent parked for approval that have not
 *                    expired (lib/mcp/pending-approvals.ts). The same three
 *                    queues the top bar adds up for one project.
 *   lastCheckAt      the self-healing loop's last pass over the project within
 *                    the last day (lib/autonomy/loop-tick.ts), or null. Null is
 *                    a real answer: the loop does not visit a project with
 *                    nothing built, a paused one, or one unused for 30 days,
 *                    and the list must not say it does.
 *   agentLastSeenAt  when THIS caller's coding agent last reached the project
 *                    over MCP (lib/mcp/agent-connection.ts), or null. A
 *                    teammate's agent does not count: it does not wire this
 *                    person's editor.
 *
 * Four grouped queries over the given ids, whatever their number, each on an
 * index the schema already has: health_findings and agent_approval_requests on
 * [projectId, status], api_keys on [userId], audit_logs on [projectId] and
 * [timestamp] (there is no composite index there, which is why its read is
 * bounded to a day, as getLastLoopTickAt's is). Never one query per project.
 *
 * WHICH projects is not decided here. The route passes exactly the ids the
 * projects list returns to the same caller, so the access rule and the
 * organization scoping are the list's own and cannot drift from it.
 */

import { prisma } from '@/lib/db/prisma'
import { LOOP_TICK_ACTIONS } from '@/lib/autonomy/loop-tick'

export interface ProjectLiveStatus {
  id: string
  /** Approvals waiting on a person. */
  waiting: number
  /** The self-healing loop's last pass within LOOP_CHECK_LOOKBACK_MS, as ISO 8601. */
  lastCheckAt: string | null
  /** When the caller's own coding agent last reached the project, as ISO 8601. */
  agentLastSeenAt: string | null
}

/** The most projects one answer covers: a list longer than this gets live state for its first ones. */
export const LIVE_STATUS_MAX_PROJECTS = 100

/** How far back a loop pass counts: a day, as for the project page's own clock (lib/autonomy/loop-tick.ts). */
export const LOOP_CHECK_LOOKBACK_MS = 24 * 60 * 60 * 1000

export async function projectLiveStatus(
  projectIds: readonly string[],
  userId: string,
  now: Date = new Date(),
): Promise<ProjectLiveStatus[]> {
  const ids = Array.from(new Set(projectIds)).slice(0, LIVE_STATUS_MAX_PROJECTS)
  if (ids.length === 0) return []

  const since = new Date(now.getTime() - LOOP_CHECK_LOOKBACK_MS)
  const [heldFindings, parkedCalls, loopPasses, agentKeys] = await Promise.all([
    prisma.healthFinding.groupBy({
      by: ['projectId'],
      where: { projectId: { in: ids }, status: 'pending_approval' },
      _count: { _all: true },
    }),
    prisma.agentApprovalRequest.groupBy({
      by: ['projectId'],
      where: { projectId: { in: ids }, status: 'pending', expiresAt: { gt: now } },
      _count: { _all: true },
    }),
    prisma.auditLog.groupBy({
      by: ['projectId'],
      where: { projectId: { in: ids }, action: { in: [...LOOP_TICK_ACTIONS] }, timestamp: { gte: since } },
      _max: { timestamp: true },
    }),
    prisma.apiKey.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: ids },
        userId,
        scope: 'mcp',
        lastUsed: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      _max: { lastUsed: true },
    }),
  ])

  const waiting = new Map<string, number>()
  for (const row of [...heldFindings, ...parkedCalls]) {
    if (row.projectId) waiting.set(row.projectId, (waiting.get(row.projectId) ?? 0) + row._count._all)
  }
  const lastCheck = new Map<string, Date>()
  for (const row of loopPasses) {
    if (row.projectId && row._max.timestamp) lastCheck.set(row.projectId, row._max.timestamp)
  }
  const agentSeen = new Map<string, Date>()
  for (const row of agentKeys) {
    if (row.projectId && row._max.lastUsed) agentSeen.set(row.projectId, row._max.lastUsed)
  }

  return ids.map((id) => ({
    id,
    waiting: waiting.get(id) ?? 0,
    lastCheckAt: lastCheck.get(id)?.toISOString() ?? null,
    agentLastSeenAt: agentSeen.get(id)?.toISOString() ?? null,
  }))
}
