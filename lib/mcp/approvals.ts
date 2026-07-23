/**
 * MCP approval escalation — destructive ops become approvable requests
 * instead of flat refusals.
 *
 * Flow:
 *   1. backend_chat over MCP hits the brain's destructive gate → the run ends
 *      blocked. The chat route calls `createApprovalRequest` with the danger
 *      details, and the agent receives { approval: { id, status: 'pending' } }.
 *   2. The human sees the request in the Review Queue (dashboard) and
 *      approves or rejects it.
 *   3. Approval re-runs the ORIGINAL message through the brain with
 *      destructiveConfirmed=true — the same resume path the dashboard chat
 *      uses — and records the outcome on the request row.
 *   4. The agent polls the `check_approval` MCP tool until status is
 *      executed / rejected / failed / expired.
 *
 * Safety invariants:
 *   • Approval authority is platform-JWT only (withProjectAccess) — a scoped
 *     agent key can create and poll requests but can NEVER decide one.
 *   • Requests expire (default 24h). Expired requests cannot be approved.
 *   • Execution happens server-side at decision time, by the approver's
 *     identity, with the standard audit trail.
 */

import { prisma } from '@/lib/db/prisma'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
const EXECUTE_CAP_MS = 90_000

export interface DangerInfo {
  tool: string
  target: string
  rowCount: number | null
  reversible: boolean
}

export async function createApprovalRequest(input: {
  projectId: string
  userId: string
  apiKeyId?: string
  message: string
  danger: DangerInfo
}) {
  const row = await prisma.agentApprovalRequest.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      message: input.message.slice(0, 4000),
      tool: input.danger.tool,
      target: input.danger.target.slice(0, 300),
      rowCount: input.danger.rowCount,
      reversible: input.danger.reversible,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    },
  })

  await prisma.auditLog.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      action: 'AGENT_APPROVAL_REQUESTED',
      type: 'mcp',
      details: JSON.stringify({
        approvalId: row.id,
        tool: input.danger.tool,
        target: input.danger.target,
        rowCount: input.danger.rowCount,
        at: new Date().toISOString(),
      }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return row
}

/** Lazily expire on read — no cron needed for correctness. */
function effectiveStatus(row: { status: string; expiresAt: Date }): string {
  if (row.status === 'pending' && row.expiresAt < new Date()) return 'expired'
  return row.status
}

/** Poll shape returned to the agent — never leaks approver identity. */
export async function getApprovalForProject(projectId: string, id: string) {
  const row = await prisma.agentApprovalRequest.findFirst({
    where: { id, projectId },
  })
  if (!row) return null
  return {
    id: row.id,
    status: effectiveStatus(row),
    tool: row.tool,
    target: row.target,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resultSummary: row.resultSummary,
  }
}

export async function listApprovals(projectId: string) {
  const rows = await prisma.agentApprovalRequest.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return rows.map((r) => ({
    id: r.id,
    status: effectiveStatus(r),
    tool: r.tool,
    target: r.target,
    rowCount: r.rowCount,
    reversible: r.reversible,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
    resultSummary: r.resultSummary,
  }))
}

export async function decideApproval(input: {
  projectId: string
  approvalId: string
  approverUserId: string
  decision: 'approve' | 'reject'
}): Promise<{ ok: boolean; status: string; error?: string; resultSummary?: string }> {
  const row = await prisma.agentApprovalRequest.findFirst({
    where: { id: input.approvalId, projectId: input.projectId },
  })
  if (!row) return { ok: false, status: 'missing', error: 'Approval request not found' }

  const current = effectiveStatus(row)
  if (current !== 'pending') {
    return { ok: false, status: current, error: `Request is ${current}, not pending` }
  }

  if (input.decision === 'reject') {
    await prisma.agentApprovalRequest.update({
      where: { id: row.id },
      data: { status: 'rejected', decidedBy: input.approverUserId, decidedAt: new Date() },
    })
    await auditDecision(input, row.tool, row.target, 'rejected')
    return { ok: true, status: 'rejected' }
  }

  // Claim atomically so a double-click / second tab cannot execute twice.
  const claimed = await prisma.agentApprovalRequest.updateMany({
    where: { id: row.id, status: 'pending' },
    data: { status: 'approved', decidedBy: input.approverUserId, decidedAt: new Date() },
  })
  if (claimed.count === 0) {
    const fresh = await prisma.agentApprovalRequest.findUnique({ where: { id: row.id } })
    return { ok: false, status: fresh?.status ?? 'unknown', error: 'Already decided elsewhere' }
  }
  await auditDecision(input, row.tool, row.target, 'approved')

  // Execute: replay the original message with destructive confirmation — the
  // exact resume path the dashboard confirmation card uses.
  let summary = ''
  let ok = false
  try {
    const events: BrainEvent[] = []
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Approved execution exceeded ${EXECUTE_CAP_MS}ms`)), EXECUTE_CAP_MS).unref?.()
    })
    const result = await Promise.race([
      runBrain(
        {
          projectId: input.projectId,
          userId: input.approverUserId,
          message: row.message,
          sessionToken: undefined,
          destructiveConfirmed: true,
        },
        (e) => events.push(e),
      ),
      timeout,
    ])
    ok = result.success
    summary = result.summary
  } catch (err: any) {
    ok = false
    summary = err?.message ?? 'Execution failed'
  }

  await prisma.agentApprovalRequest.update({
    where: { id: row.id },
    data: {
      status: ok ? 'executed' : 'failed',
      executedAt: new Date(),
      resultSummary: summary.slice(0, 2000),
    },
  })

  return { ok, status: ok ? 'executed' : 'failed', resultSummary: summary }
}

async function auditDecision(
  input: { projectId: string; approverUserId: string; approvalId: string },
  tool: string,
  target: string,
  decision: string,
) {
  await prisma.auditLog.create({
    data: {
      projectId: input.projectId,
      userId: input.approverUserId,
      action: decision === 'approved' ? 'AGENT_APPROVAL_GRANTED' : 'AGENT_APPROVAL_REJECTED',
      type: 'mcp',
      details: JSON.stringify({ approvalId: input.approvalId, tool, target, at: new Date().toISOString() }),
      timestamp: new Date(),
    },
  }).catch(() => {})
}
