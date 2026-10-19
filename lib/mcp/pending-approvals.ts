/**
 * Agent requests waiting on a human: rows in agent_approval_requests that are
 * still pending and have not expired.
 *
 * One definition for every surface that counts them. The Overview and the top
 * bar counted only the autonomy loop's held findings, and the autonomy status
 * tool did the same, so a deploy or a drop an agent parked for approval was
 * visible only in the Review Queue on the Autonomy page, until it expired
 * unseen (OV-1, AUT-07, AUT-08). The briefing tool already counted both queues.
 *
 * Kept free of heavy imports: the health route and the top bar's poll read it.
 */

import { prisma } from '@/lib/db/prisma'

const waiting = (projectId: string) => ({
  projectId,
  status: 'pending',
  expiresAt: { gt: new Date() },
})

export async function countPendingAgentApprovals(projectId: string): Promise<number> {
  return prisma.agentApprovalRequest.count({ where: waiting(projectId) })
}

export async function listPendingAgentApprovals(projectId: string, take = 10) {
  const rows = await prisma.agentApprovalRequest.findMany({
    where: waiting(projectId),
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, tool: true, target: true, toolArgs: true, createdAt: true, expiresAt: true },
  })
  // A regional project's targets are kept in its region and read back here,
  // or left as their stand-ins when it cannot be read. The call is selected
  // only to tell which rows those are, and is not returned
  // (lib/mcp/approval-request-bodies.ts). Imported on use: only the count above
  // is read by the health route and the top bar's poll.
  const { withApprovalRequests } = await import('@/lib/mcp/approval-request-bodies')
  const shown = await withApprovalRequests(projectId, rows)
  return shown.map(({ toolArgs: _call, readable: _readable, ...row }) => row)
}
