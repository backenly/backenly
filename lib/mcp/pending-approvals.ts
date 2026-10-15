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
  return prisma.agentApprovalRequest.findMany({
    where: waiting(projectId),
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, tool: true, target: true, createdAt: true, expiresAt: true },
  })
}
