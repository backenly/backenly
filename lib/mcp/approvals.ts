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

/**
 * Wall-clock budget for executing an APPROVED operation.
 *
 * ── Why this is not the interactive 90s ──────────────────────────────────────
 *
 * It was, and that was wrong on both sides of the trade. The 90s cap on
 * `/api/mcp/chat` exists because an MCP host blocks on a tool call and must not
 * hang — it is a latency budget for a caller that is waiting.
 *
 * Nobody is waiting here. A human already read the operation, decided it was
 * safe, and clicked approve; the agent polls `check_approval` asynchronously.
 * Reusing the interactive cap meant a multi-step destructive plan could burn the
 * most expensive step in the whole system — human review — and then fail with
 * "Approved execution exceeded 90000ms" (defect #7). Post-approval work is
 * exactly the work that deserves room to finish.
 *
 * Ten minutes is chosen to be longer than any plan we have measured while still
 * bounded, so a genuinely stuck run cannot hold the row in `approved` forever.
 */
const EXECUTE_CAP_MS = 10 * 60 * 1000

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
  //
  // ── `executed` must mean "and here is what changed" ─────────────────────────
  //
  // The status was derived from `result.success` alone, so it carried no
  // information about what actually happened to the schema. Two failure modes
  // followed, in opposite directions (defect #8):
  //
  //   • `executed` on a run that succeeded overall while doing something OTHER
  //     than what was asked — the report saw owner-only auto RLS recorded as a
  //     successful custom-policy application.
  //   • `failed` on a run that had already APPLIED part of its plan before
  //     stopping — "Approved but execution failed" on a request that had removed
  //     the old policies and re-applied some of them.
  //
  // In both cases the truth was in the event stream and was thrown away. The
  // events are now scanned for mutations that landed, a `partial` status is
  // recorded when some did and the run still failed, and the applied list is
  // written into the summary the agent polls. An agent that knows three of five
  // steps landed can finish the job; one told only "failed" replays the whole
  // thing.
  const events: BrainEvent[] = []
  let summary = ''
  let ok = false
  let timedOut = false
  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        timedOut = true
        reject(new Error(`Approved execution exceeded ${Math.round(EXECUTE_CAP_MS / 1000)}s`))
      }, EXECUTE_CAP_MS).unref?.()
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
    // Approval replay runs the brain again — a second full model loop on our
    // key — so it is charged like any other turn. Without this, escalating a
    // destructive request through the Review Queue would be a free way to spend
    // our OpenAI budget. Fire-and-forget: never fail an applied change on a
    // billing write. (Same timeout gap as the chat route: a run that exceeds
    // EXECUTE_CAP_MS burns tokens this branch never sees.)
    const { chargeAiCredits } = await import('@/lib/billing')
    chargeAiCredits(input.approverUserId, result.tokensUsed).catch(() => {})
  } catch (err: any) {
    ok = false
    summary = err?.message ?? 'Execution failed'
  }

  const applied = appliedMutations(events)

  // `partial` is a distinct terminal status, not a flavour of failed. A caller
  // that sees `failed` may safely assume nothing changed; on a partial run that
  // assumption is false and acting on it double-applies.
  const status = ok ? 'executed' : applied.length > 0 ? 'partial' : 'failed'

  const detail =
    status === 'executed'
      ? summary
      : status === 'partial'
        ? `${summary}\n\n⚠️ PARTIALLY APPLIED — ${applied.length} change(s) DID take effect before the run ` +
          `stopped: ${applied.join('; ')}.\nDo NOT replay the original request; verify the current state with ` +
          `get_table_schema / read_backend_state and ask for only what is still missing.` +
          (timedOut ? `\nThe run hit its ${Math.round(EXECUTE_CAP_MS / 1000)}s execution budget.` : '')
        : `${summary}\n\nNothing was applied — the backend is in the state it was before approval.`

  await prisma.agentApprovalRequest.update({
    where: { id: row.id },
    data: {
      status,
      executedAt: new Date(),
      resultSummary: detail.slice(0, 2000),
    },
  })

  return { ok, status, resultSummary: detail }
}

/**
 * Mutations from a brain run that actually landed.
 *
 * Read-only tools are excluded by prefix rather than by an allowlist of writers,
 * so a tool added later is treated as a mutation until proven otherwise — the
 * safe direction for a function whose job is to warn that something changed.
 */
const NON_MUTATION_TOOL = /^(read_backend_state|get_|list_|check_|run_query|run_test|finish|answer_question|propose_plan|ask_user)/

function appliedMutations(events: BrainEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.type !== 'tool_done') continue
    const tool = (e as any).tool as string | undefined
    if (!tool || NON_MUTATION_TOOL.test(tool)) continue
    out.push((e as any).title || tool)
  }
  return out
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
