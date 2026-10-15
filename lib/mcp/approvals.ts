/**
 * MCP approval escalation — gated calls become approvable requests
 * instead of flat refusals.
 *
 * Flow:
 *   1. A call that needs a human (`needsApproval`: destructive, or an executor
 *      rated high-risk) is stopped before it runs — by the brain's gate under
 *      backend_chat, or by the MCP tool route for a typed call. The caller
 *      records it with `createApprovalRequest`: the exact tool and the exact
 *      arguments. The agent receives { approval: { id, status: 'pending' } }.
 *   2. The human sees the request in the Review Queue (dashboard) and
 *      approves or rejects it.
 *   3. Approval runs THAT call verbatim (`runApprovedCall`) — no model, no
 *      re-reading of the request text — and records the outcome on the row.
 *   4. The agent polls the `check_approval` MCP tool until status is
 *      executed / rejected / failed / expired.
 *
 * Safety invariants:
 *   • Approval authority is platform-JWT only (withProjectAccess) — a scoped
 *     agent key can create and poll requests but can NEVER decide one.
 *   • What executes is exactly what the human read: the recorded tool and
 *     arguments, never a re-interpretation of the request text. A request
 *     without an exact call cannot be executed at all: approving one closes
 *     it, unrun, with the reason.
 *   • Requests expire (default 24h). Expired requests cannot be approved.
 *   • A request executes at most once (atomic pending → approved claim).
 *   • Execution happens server-side at decision time, by the approver's
 *     identity, with the standard audit trail.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { dispatchTool, type ToolDispatchContext, type ToolResult } from '@/lib/ai/brain/tools'
import { withholdSecrets } from '@/lib/mcp/withhold-secrets'

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
  /**
   * The exact arguments for `danger.tool`. Approval runs this call verbatim,
   * so what executes is what the human read. Required: a request that cannot
   * name its exact call cannot be approved safely, so it must not be created.
   */
  toolArgs: Record<string, unknown>
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
      toolArgs: input.toolArgs as Prisma.InputJsonValue,
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

  // The owner is told. The request waits for them and expires, and it used to
  // appear only in the Review Queue, so one nobody looked for simply ran out
  // (AUT-08). Not awaited: a slow mail server must not hold the agent's answer.
  notifyOwnerOfRequest(row).catch(() => {})

  return row
}

/** One notice per burst of requests: see notifyOwnerOfRequest. */
const NOTICE_COALESCE_MS = 10 * 60 * 1000

async function notifyOwnerOfRequest(row: { id: string; projectId: string; tool: string; target: string; expiresAt: Date }) {
  const project = await prisma.project.findUnique({ where: { id: row.projectId }, select: { userId: true, name: true } })
  if (!project?.userId) return
  // An agent that parks ten calls in a minute sends one notice, not ten: the
  // Review Queue lists every request. A new notice goes out once the owner has
  // read the last one, or ten minutes after it.
  const recent = await prisma.platformNotification.findFirst({
    where: {
      userId: project.userId,
      type: 'approval_requested',
      readAt: null,
      createdAt: { gt: new Date(Date.now() - NOTICE_COALESCE_MS) },
      metadata: { path: ['projectId'], equals: row.projectId },
    },
    select: { id: true },
  })
  if (recent) return
  const { notifyApprovalRequested } = await import('@/lib/notifications/platform')
  await notifyApprovalRequested(project.userId, {
    projectId: row.projectId,
    projectName: project.name,
    approvalId: row.id,
    tool: row.tool,
    target: row.target,
    expiresAt: row.expiresAt,
  })
}

/**
 * Every status a request can carry. `approved` is the moment between the claim
 * and the outcome. `partial` is no longer written: it came from the replay path
 * that approval replaced, when one approval could run several changes. Older
 * rows still carry it, and check_approval reports a row as it was stored.
 */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'failed'
  | 'partial'

/**
 * Grace past EXECUTE_CAP_MS before an 'approved' row is presumed dead. The cap
 * bounds runApprovedCall itself, so a row still 'approved' this long after the
 * decision means the terminal update never ran — a crash or restart mid-run.
 */
const STUCK_APPROVED_GRACE_MS = 2 * 60 * 1000

const STUCK_APPROVED_SUMMARY =
  'Execution never reported back within its ten-minute cap — the server likely ' +
  'restarted mid-run. The outcome is unknown: the operation may have fully or ' +
  'partially applied. Check the change history before asking the agent to retry.'

/**
 * Lazily resolve what a row IS on read — no cron needed for correctness.
 * 'pending' past its TTL is expired. 'approved' is a moment, not a resting
 * state: decideApproval writes the terminal status when runApprovedCall
 * returns, so a row stuck there past cap+grace is reported as failed with an
 * honest summary instead of telling the agent to keep polling forever.
 */
function effectiveView(row: {
  status: string
  expiresAt: Date
  decidedAt: Date | null
  resultSummary: string | null
}): { status: string; resultSummary: string | null } {
  if (row.status === 'pending' && row.expiresAt < new Date()) {
    return { status: 'expired', resultSummary: row.resultSummary }
  }
  if (
    row.status === 'approved' &&
    row.decidedAt &&
    Date.now() - row.decidedAt.getTime() > EXECUTE_CAP_MS + STUCK_APPROVED_GRACE_MS
  ) {
    return { status: 'failed', resultSummary: row.resultSummary ?? STUCK_APPROVED_SUMMARY }
  }
  return { status: row.status, resultSummary: row.resultSummary }
}

/** Poll shape returned to the agent — never leaks approver identity. */
export async function getApprovalForProject(projectId: string, id: string) {
  const row = await prisma.agentApprovalRequest.findFirst({
    where: { id, projectId },
  })
  if (!row) return null
  const view = effectiveView(row)
  return {
    id: row.id,
    status: view.status,
    tool: row.tool,
    target: row.target,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resultSummary: view.resultSummary,
  }
}

/**
 * The other kind of parked request: an executor-gated medium/high action the
 * chat door queued as an `ai_action_pending` HealthFinding (Review Queue,
 * Autonomy page). check_approval resolves these too, so a parked action has
 * an id the agent can poll instead of vanishing from its point of view.
 */
export async function getParkedActionForProject(projectId: string, id: string) {
  const row = await prisma.healthFinding.findFirst({
    where: { id, projectId, type: 'ai_action_pending' },
  })
  if (!row) return null
  const details = (row.details as Record<string, unknown> | null) ?? {}
  const statusMap: Record<string, string> = {
    pending_approval: 'pending',
    applied: 'executed',
    auto_fixed: 'executed',
    dismissed: 'rejected',
    stale: 'expired',
  }
  return {
    id: row.id,
    kind: 'parked_action' as const,
    status: statusMap[row.status] ?? row.status,
    tool:
      typeof details.executorAction === 'string'
        ? details.executorAction
        : typeof details.title === 'string'
          ? details.title
          : row.type,
    target: typeof details.location === 'string' ? details.location : null,
    createdAt: row.detectedAt.toISOString(),
    resultSummary: null,
  }
}

export async function listApprovals(projectId: string) {
  const rows = await prisma.agentApprovalRequest.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return rows.map((r) => {
    const view = effectiveView(r)
    return {
      id: r.id,
      status: view.status,
      tool: r.tool,
      target: r.target,
      rowCount: r.rowCount,
      reversible: r.reversible,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      executedAt: r.executedAt?.toISOString() ?? null,
      resultSummary: view.resultSummary,
    }
  })
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

  const current = effectiveView(row).status
  if (current !== 'pending') {
    return { ok: false, status: current, error: `Request is ${current}, not pending` }
  }

  if (input.decision === 'reject') {
    await prisma.agentApprovalRequest.update({
      where: { id: row.id },
      data: { status: 'rejected', decidedBy: input.approverUserId, decidedAt: new Date() },
    })
    await auditDecision(input, row.tool, row.target, 'AGENT_APPROVAL_REJECTED')
    return { ok: true, status: 'rejected' }
  }

  // A request that does not name its exact call cannot be executed safely:
  // the only thing left to run would be the request's MESSAGE, and replaying a
  // message runs whatever the model chooses, not the operation the human read.
  // Such rows predate exact-call approvals. Close them, unrun, and say why.
  const exactArgs = row.toolArgs
  const isExact = !!exactArgs && typeof exactArgs === 'object' && !Array.isArray(exactArgs)
  if (!isExact) {
    const summary =
      'Not executed. This request was raised before approvals were bound to one exact operation, ' +
      'so approving it could not guarantee that what ran is what you read. Nothing was changed. ' +
      'Ask the agent to request the operation again; the new request will carry the exact call.'
    const closed = await prisma.agentApprovalRequest.updateMany({
      where: { id: row.id, status: 'pending' },
      data: {
        status: 'failed',
        decidedBy: input.approverUserId,
        decidedAt: new Date(),
        resultSummary: summary,
      },
    })
    if (closed.count === 0) {
      const fresh = await prisma.agentApprovalRequest.findUnique({ where: { id: row.id } })
      return { ok: false, status: fresh?.status ?? 'unknown', error: 'Already decided elsewhere' }
    }
    await auditDecision(input, row.tool, row.target, 'AGENT_APPROVAL_UNBOUND_REFUSED')
    return { ok: false, status: 'failed', resultSummary: summary }
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
  await auditDecision(input, row.tool, row.target, 'AGENT_APPROVAL_GRANTED')

  // The exact call, verbatim. The approver's identity carries the authority;
  // `destructiveConfirmed` tells the executor its own confirmation gate is
  // already satisfied for THIS call, which a human just read and approved.
  const outcome = await runApprovedCall(row.tool, exactArgs as Record<string, unknown>, {
    projectId: input.projectId,
    userId: input.approverUserId,
    sessionToken: undefined,
    destructiveConfirmed: true,
    createdThisTurn: new Set<string>(),
  })
  await prisma.agentApprovalRequest.update({
    where: { id: row.id },
    data: { status: outcome.status, executedAt: new Date(), resultSummary: storableResultSummary(outcome.summary) },
  })
  return { ok: outcome.status === 'executed', status: outcome.status, resultSummary: outcome.summary }
}

type ApprovalAuditAction =
  | 'AGENT_APPROVAL_GRANTED'
  | 'AGENT_APPROVAL_REJECTED'
  /** Approved, but the request named no exact call, so nothing was run. */
  | 'AGENT_APPROVAL_UNBOUND_REFUSED'

async function auditDecision(
  input: { projectId: string; approverUserId: string; approvalId: string },
  tool: string,
  target: string,
  action: ApprovalAuditAction,
) {
  await prisma.auditLog.create({
    data: {
      projectId: input.projectId,
      userId: input.approverUserId,
      action,
      type: 'mcp',
      details: JSON.stringify({ approvalId: input.approvalId, tool, target, at: new Date().toISOString() }),
      timestamp: new Date(),
    },
  }).catch(() => {})
}

/**
 * Run an approved exact call: the tool and arguments the human read, verbatim,
 * with destructive confirmation, and no model anywhere in the path.
 *
 * `executed` requires the tool to report success AND not to have stopped for a
 * further confirmation. An executor can answer `ok` while only returning its
 * own confirmation prompt (`needsUser`); counting that as executed would tell
 * the agent a deploy shipped when it did not.
 *
 * `dispatch` is injectable so this can be tested without a database; in
 * production it is the brain's own dispatcher.
 */
export async function runApprovedCall(
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext,
  dispatch: (name: string, args: Record<string, unknown>, ctx: ToolDispatchContext) => Promise<ToolResult> = dispatchTool,
  capMs: number = EXECUTE_CAP_MS,
): Promise<{ status: 'executed' | 'failed'; summary: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Approved execution exceeded ${Math.round(capMs / 1000)}s`)),
        capMs,
      )
      timer.unref?.()
    })
    const result = await Promise.race([dispatch(tool, args, ctx), timeout])
    if (result.ok && !result.needsUser) return { status: 'executed', summary: result.summary }
    if (result.ok) {
      return {
        status: 'failed',
        summary:
          `The approved call stopped for a further confirmation instead of running: ${result.summary}\n\n` +
          `Nothing was applied. Raise the request again once whatever it asks for is in place.`,
      }
    }
    // Not "nothing was applied": a deploy, a merge or a data migration can stop
    // part-way, and nothing here can tell which of its steps took effect.
    return {
      status: 'failed',
      summary:
        `${result.summary}\n\nThe approved call reported failure. Whether any part of it took effect ` +
        `is not known here, so read the current state before raising it again.`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'failed', summary: `${message}\n\nThe approved call did not complete. Read the current state before asking again.` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A result summary as it may be PERSISTED.
 *
 * `resultSummary` is served forever: `listApprovals` hands it to every project
 * member on the Review Queue, and `check_approval` hands it to the agent's key.
 * An executor summary can carry a credential — executeRotateKey prints the new
 * key under "copy now — shown once" — and storing that summary made "once"
 * mean "until the row is deleted". The live response to the approving admin
 * keeps the raw summary; what is stored never may.
 */
export function storableResultSummary(summary: string): string {
  return withholdSecrets(summary).slice(0, 2000)
}
