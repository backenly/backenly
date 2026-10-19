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
 *   • A restore (`revert_schema_change`) is parked with Backenly's own
 *     measurement of what it would set aside, whatever arguments the door that
 *     asked passed: the person approves what was measured, never an agent's
 *     own counts (createApprovalRequest).
 *   • Requests expire (default 24h). Expired requests cannot be approved.
 *   • A request executes at most once (atomic pending → approved claim).
 *   • Execution happens server-side at decision time, by the approver's
 *     identity, with the standard audit trail.
 *   • A project kept in another region keeps a request's words and exact call
 *     in that region (lib/mcp/approval-request-bodies.ts). Approval reads the
 *     call back from there and runs it only when the approval carries the
 *     digest of what its card showed; it runs nothing when it cannot read it.
 */

import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { NOT_QUOTED, quotesKeptHere } from '@/lib/data-plane/residency'
import { dispatchTool, type ToolDispatchContext, type ToolResult } from '@/lib/ai/brain/tools'
import type { RestoreRequest } from '@/lib/changes/recovery'
import {
  forgetApprovalRequests,
  keepApprovalRequest,
  matchesShown,
  requestAsKept,
  shownDigest,
  withApprovalRequests,
} from '@/lib/mcp/approval-request-bodies'
import { withholdSecrets } from '@/lib/mcp/withhold-secrets'
import { withHeldActions } from '@/lib/operational-memory/held-action-targets'

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

/** A restore that cannot happen is refused when asked for, and nothing is queued. */
export class RestoreRequestRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RestoreRequestRefusedError'
  }
}

/** Backenly's own measurement of the restore a request names, taken now. */
async function measuredRestore(projectId: string, args: Record<string, unknown>): Promise<RestoreRequest> {
  const { describeRestoreRequest } = await import('@/lib/changes/recovery')
  const d = await describeRestoreRequest(projectId, String(args.changeId ?? '').trim())
  if (!d.ok) {
    const refused = d as Extract<typeof d, { ok: false }>
    throw new RestoreRequestRefusedError(refused.status, refused.code, refused.error)
  }
  const { target, rowCount, toolArgs } = d as Extract<typeof d, { ok: true }>
  return { target, rowCount, toolArgs }
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
   * A restore's are replaced by its measurement (`restore`).
   */
  toolArgs: Record<string, unknown>
  /**
   * For a restore: Backenly's measurement of it, when the caller has just taken
   * one (describeRestoreRequest, or a recovery escalating what it measured).
   * Built by Backenly's code only, never from an agent's arguments. Left out,
   * it is measured here.
   */
  restore?: RestoreRequest
}) {
  // A restore is parked with what Backenly measured it would do, whichever door
  // asked: a brain run's parked call carries the model's own arguments, counts
  // of what to set aside included, and those never reach the request. One that
  // cannot happen throws RestoreRequestRefusedError, and nothing is queued.
  let danger = input.danger
  let toolArgs = input.toolArgs
  if (danger.tool === 'revert_schema_change') {
    const restore = input.restore ?? (await measuredRestore(input.projectId, input.toolArgs))
    danger = { ...danger, target: restore.target, rowCount: restore.rowCount, reversible: true }
    toolArgs = { ...restore.toolArgs }
  }

  // The request's words, its target and its exact call are what the approver
  // reads and what approval runs. A project kept in another region keeps them
  // there, written first under the id the row then takes, and the row keeps the
  // tool, a stand-in for the target and the call's shape
  // (lib/mcp/approval-request-bodies.ts). When the region cannot be written no
  // row is, and this throws: nothing is queued.
  const id = randomUUID()
  const quote = await quotesKeptHere(input.projectId)
  const request = {
    message: input.message.slice(0, 4000),
    target: danger.target.slice(0, 300),
    toolArgs,
  }
  const stored = quote ? request : await keepApprovalRequest(input.projectId, id, danger.tool, request)
  const row = await prisma.agentApprovalRequest
    .create({
      data: {
        id,
        projectId: input.projectId,
        userId: input.userId,
        apiKeyId: input.apiKeyId ?? null,
        message: stored.message,
        tool: danger.tool,
        target: stored.target,
        rowCount: danger.rowCount,
        reversible: danger.reversible,
        toolArgs: stored.toolArgs as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    })
    .catch(async (err: unknown) => {
      // A record kept in the region lasts as long as its row, so one whose row
      // could not be written goes again. Nothing is queued either way.
      if (!quote) await forgetApprovalRequests([{ id, projectId: input.projectId }]).catch(() => [])
      throw err
    })

  // The audit copy of the target is left out for a project kept in another
  // region, where it can name a row or a file (lib/data-plane/residency.ts).
  await prisma.auditLog.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      action: 'AGENT_APPROVAL_REQUESTED',
      type: 'mcp',
      details: JSON.stringify({
        approvalId: row.id,
        tool: danger.tool,
        ...(quote ? { target: danger.target } : {}),
        rowCount: danger.rowCount,
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
    // The action only for a project kept in another region: the target can
    // name a row or a file, and the request keeps it (lib/data-plane/residency.ts).
    target: (await quotesKeptHere(row.projectId)) ? row.target : null,
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
  const found = await prisma.agentApprovalRequest.findFirst({
    where: { id, projectId },
  })
  if (!found) return null
  // A regional project's request keeps its target in its region, read back for
  // the agent that made it; when the region cannot be read, the row's stand-in
  // and `readable: false` (lib/mcp/approval-request-bodies.ts).
  const [row] = await withApprovalRequests(projectId, [found])
  const view = effectiveView(row)
  return {
    id: row.id,
    status: view.status,
    tool: row.tool,
    target: row.target,
    readable: row.readable,
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
  const found = await prisma.healthFinding.findFirst({
    where: { id, projectId, type: 'ai_action_pending' },
  })
  if (!found) return null
  // A regional project's parked action keeps its target in its region, read
  // back for the agent that asked for it; when the region cannot be read the
  // target is not given, rather than its stand-in
  // (lib/operational-memory/held-action-targets.ts).
  const [row] = await withHeldActions(projectId, [found])
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
    target: typeof details.location === 'string' && details.keptInRegion !== true ? details.location : null,
    createdAt: row.detectedAt.toISOString(),
    resultSummary: null,
  }
}

export async function listApprovals(projectId: string) {
  const found = await prisma.agentApprovalRequest.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  // A regional project's requests keep their words and targets in its region,
  // read back for the approver; when the region cannot be read, the rows as
  // stored and `readable: false` (lib/mcp/approval-request-bodies.ts).
  const rows = await withApprovalRequests(projectId, found)
  return rows.map((r) => {
    const view = effectiveView(r)
    return {
      id: r.id,
      status: view.status,
      tool: r.tool,
      target: r.target,
      // Who asked: a coding agent's key, or Backenly itself (a change that failed
      // its checks and could not be recovered without a person).
      requestedBy: r.apiKeyId ? ('agent' as const) : ('backenly' as const),
      // The change a restore request is about, so the inbox can link to it.
      changeId: r.tool === 'revert_schema_change' ? ((r.toolArgs as { changeId?: string } | null)?.changeId ?? null) : null,
      rowCount: r.rowCount,
      reversible: r.reversible,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      executedAt: r.executedAt?.toISOString() ?? null,
      resultSummary: view.resultSummary,
      /** False when the card can show only stand-ins: its request cannot be approved from it. */
      readable: r.readable,
      /** What an approval of this card sends back (decideApproval's shownDigest). */
      shownDigest: view.status === 'pending' && r.readable ? digestOf(r) : null,
    }
  })
}

/** The digest of a request as a card shows it, or null when none can be made. */
function digestOf(row: { id: string; tool: string; message: string; target: string; toolArgs: unknown }): string | null {
  try {
    return shownDigest(row.id, row.tool, row)
  } catch {
    return null
  }
}

export async function decideApproval(input: {
  projectId: string
  approvalId: string
  approverUserId: string
  decision: 'approve' | 'reject'
  /**
   * The digest of the request as its card showed it (listApprovals'
   * `shownDigest`). Required to approve a regional project's request, whose
   * card is read from its region; checked for any request whenever it is given.
   */
  shownDigest?: string
}): Promise<{
  ok: boolean
  status: string
  error?: string
  resultSummary?: string
  /** The project's region, which keeps the request's call, could not be reached: nothing ran, and it is still waiting. */
  regionUnavailable?: boolean
}> {
  const row = await prisma.agentApprovalRequest.findFirst({
    where: { id: input.approvalId, projectId: input.projectId },
  })
  if (!row) return { ok: false, status: 'missing', error: 'Approval request not found' }

  const current = effectiveView(row).status
  if (current !== 'pending') {
    return { ok: false, status: current, error: `Request is ${current}, not pending` }
  }

  // A restore rewrites production, so deciding one takes the same authority as
  // running one from the console: admin rights on the project, not access.
  // Declining one is a decision too (it keeps a change that failed its checks),
  // so it takes the same.
  if (row.tool === 'revert_schema_change') {
    const { canAdministerProject } = await import('@/lib/edition/guard')
    if (!(await canAdministerProject(input.approverUserId, input.projectId))) {
      return { ok: false, status: 'forbidden', error: 'Only a project admin can decide whether to restore a previous state.' }
    }
  }

  if (input.decision === 'reject') {
    await prisma.agentApprovalRequest.update({
      where: { id: row.id },
      data: { status: 'rejected', decidedBy: input.approverUserId, decidedAt: new Date() },
    })
    await auditDecision(input, row.tool, row.target, 'AGENT_APPROVAL_REJECTED')
    // Declining to restore a change that failed its checks is a decision to
    // keep it. A no-op for a change that was not waiting on one (an agent
    // asking to restore a healthy change, say).
    if (row.tool === 'revert_schema_change') {
      const changeId = (row.toolArgs as { changeId?: string } | null)?.changeId
      if (changeId) {
        const { keepChange } = await import('@/lib/changes/recovery')
        await keepChange(input.projectId, changeId, input.approverUserId, { via: 'approval' }).catch(() => {})
      }
    }
    return { ok: true, status: 'rejected' }
  }

  // The request as it would run: its row, or the record its project's region
  // keeps, where a regional project's request keeps its words and exact call
  // and its row only their shape (lib/mcp/approval-request-bodies.ts). Read
  // before the request is claimed, and never replaced by that shape. A region
  // that cannot be reached decides nothing: the request keeps waiting, to be
  // approved again once the region answers. A region that answers without the
  // call closes the request unrun, and the agent asking again makes a new
  // request whose call can be read.
  const read = await requestAsKept(input.projectId, row)
  if ('unreadable' in read) {
    if (read.unreadable === 'unreachable') {
      return { ok: false, status: 'pending', error: REGION_UNREACHABLE, regionUnavailable: true }
    }
    return closeUnrun(input, row, CALL_MISSING_SUMMARY, 'AGENT_APPROVAL_UNREADABLE_REFUSED')
  }

  // What runs is what the approver was shown. A regional project's card is
  // read from its region, so its approval must carry the digest of what that
  // card showed: one that does not, or that the request no longer matches,
  // runs nothing, and the request keeps waiting for an approval that does.
  const boundToCard = read.keptInRegion || input.shownDigest !== undefined
  if (boundToCard && !matchesShown(input.shownDigest, row.id, row.tool, read.request)) {
    return { ok: false, status: 'pending', error: NOT_AS_SHOWN }
  }
  const exactArgs = read.request.toolArgs

  // A request that does not name its exact call cannot be executed safely:
  // the only thing left to run would be the request's MESSAGE, and replaying a
  // message runs whatever the model chooses, not the operation the human read.
  // Such rows predate exact-call approvals. Close them, unrun, and say why.
  const isExact = !!exactArgs && typeof exactArgs === 'object' && !Array.isArray(exactArgs)
  if (!isExact) return closeUnrun(input, row, UNBOUND_SUMMARY, 'AGENT_APPROVAL_UNBOUND_REFUSED')

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
  // Every change it makes to production is recorded as the approver's decision
  // on the requester's call (lib/changes/attribution.ts), so the change history
  // can say both.
  const { withChangeAttribution } = await import('@/lib/changes/attribution')
  const outcome = await withChangeAttribution(
    { source: 'approval', actorUserId: input.approverUserId, apiKeyId: row.apiKeyId },
    () => runApprovedCall(row.tool, exactArgs as Record<string, unknown>, {
      projectId: input.projectId,
      userId: input.approverUserId,
      sessionToken: undefined,
      destructiveConfirmed: true,
      createdThisTurn: new Set<string>(),
    }),
  )
  // The approver gets the full result now. What is stored for later readers is
  // the status alone for a project kept in another region, whose result can
  // quote its rows (lib/data-plane/residency.ts).
  const stored = (await quotesKeptHere(input.projectId)) ? storableResultSummary(outcome.summary) : NOT_QUOTED
  await prisma.agentApprovalRequest.update({
    where: { id: row.id },
    data: { status: outcome.status, executedAt: new Date(), resultSummary: stored },
  })
  return { ok: outcome.status === 'executed', status: outcome.status, resultSummary: outcome.summary }
}

const UNBOUND_SUMMARY =
  'Not executed. This request was raised before approvals were bound to one exact operation, ' +
  'so approving it could not guarantee that what ran is what you read. Nothing was changed. ' +
  'Ask the agent to request the operation again; the new request will carry the exact call.'

const ASK_AGAIN =
  'Ask your agent to make the change again: it will be held again, as a new request, for your approval.'

/** Why an approval that did not match what its card showed ran nothing. */
const NOT_AS_SHOWN =
  'Not run. This approval does not match the request as it is kept now, so nothing was changed and the ' +
  'request is still waiting. Refresh the Review Queue, review it and approve it again.'

/** Why an approval ran nothing while the region keeping the request's call could not be reached. */
const REGION_UNREACHABLE =
  'Not run. This request’s exact call is kept in the project’s region, which could not be reached, so nothing ' +
  'was changed and the request is still waiting. Approve it again once the region answers.'

/** Why an approved request closed unrun when its region answered without its call. */
const CALL_MISSING_SUMMARY =
  'Not executed. This request’s exact call was not found in the project’s region, so nothing was changed. ' +
  ASK_AGAIN

/**
 * Close an approved request without running anything, and say why. It is never
 * claimed: the request goes from pending to failed, so it is not marked
 * approved and nothing can run it. The summary is the platform's own words.
 */
async function closeUnrun(
  input: { projectId: string; approvalId: string; approverUserId: string },
  row: { id: string; tool: string; target: string },
  summary: string,
  action: ApprovalAuditAction,
): Promise<{ ok: boolean; status: string; error?: string; resultSummary?: string }> {
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
  await auditDecision(input, row.tool, row.target, action)
  return { ok: false, status: 'failed', resultSummary: summary }
}

type ApprovalAuditAction =
  | 'AGENT_APPROVAL_GRANTED'
  | 'AGENT_APPROVAL_REJECTED'
  /** Approved, but the request named no exact call, so nothing was run. */
  | 'AGENT_APPROVAL_UNBOUND_REFUSED'
  /** Approved, but the project's region, which keeps its exact call, had no record of it, so nothing was run. */
  | 'AGENT_APPROVAL_UNREADABLE_REFUSED'

async function auditDecision(
  input: { projectId: string; approverUserId: string; approvalId: string },
  tool: string,
  target: string,
  action: ApprovalAuditAction,
) {
  // No copy of the target for a project kept in another region, where the
  // request's own record keeps it (lib/data-plane/residency.ts).
  const quote = await quotesKeptHere(input.projectId)
  await prisma.auditLog.create({
    data: {
      projectId: input.projectId,
      userId: input.approverUserId,
      action,
      type: 'mcp',
      details: JSON.stringify({ approvalId: input.approvalId, tool, ...(quote ? { target } : {}), at: new Date().toISOString() }),
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
