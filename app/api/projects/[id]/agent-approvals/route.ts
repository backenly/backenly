export const dynamic = 'force-dynamic'

/**
 * Agent approval requests — the human side of MCP destructive-op escalation.
 *
 * GET  /api/projects/[id]/agent-approvals
 *   List requests (newest first) for the Review Queue.
 *
 * POST /api/projects/[id]/agent-approvals
 *   Body: { approvalId: string, decision: 'approve' | 'reject', shownDigest?: string }
 *   Approving executes the parked operation immediately — the exact tool and
 *   arguments recorded on the request, verbatim, with no model involved — and
 *   returns the outcome. A request without an exact call is closed unrun.
 *   `shownDigest` is the listed request's own, sent back with an approval: a
 *   regional project's request runs only with it, and only while it still
 *   matches (409 otherwise, nothing run, the request still waiting). 503 when
 *   the project's region, which keeps the request's call, cannot be reached:
 *   nothing ran, and the request is still waiting.
 *
 * Auth: platform JWT + project ownership (withProjectAccess). Scoped agent
 * keys can create and poll requests over MCP but can never decide them —
 * that asymmetry IS the safety model.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { listApprovals, decideApproval } from '@/lib/mcp/approvals'

export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  const approvals = await listApprovals(projectId)
  return NextResponse.json({ success: true, approvals })
})

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  // ADMIN: a request only parks here because its tool is destructive or
  // executor-rated high risk, and approving one executes it immediately with
  // the recorded arguments. Membership alone let an organization VIEWER be the
  // "human approval" the whole safety model hinges on.
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json(
      { success: false, error: 'Project not found or access denied', code: 'PROJECT_ROLE_INSUFFICIENT' },
      { status: 403 },
    )
  }

  let body: { approvalId?: string; decision?: string; shownDigest?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { approvalId, decision } = body
  if (!approvalId || (decision !== 'approve' && decision !== 'reject')) {
    return NextResponse.json(
      { success: false, error: 'approvalId and decision (approve|reject) are required' },
      { status: 400 },
    )
  }

  const result = await decideApproval({
    projectId,
    approvalId,
    approverUserId: user.userId,
    decision,
    shownDigest: typeof body.shownDigest === 'string' ? body.shownDigest : undefined,
  })

  if (!result.ok && result.status === 'missing') {
    return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  }
  if (!result.ok && result.status === 'forbidden') {
    return NextResponse.json({ success: false, error: result.error }, { status: 403 })
  }
  if (result.regionUnavailable) {
    // The project's region, which keeps the request's exact call, could not be
    // reached: nothing ran, and the request is still waiting to be approved again.
    return NextResponse.json(
      { success: false, error: result.error, status: result.status, retryable: true },
      { status: 503 },
    )
  }
  if (!result.ok && result.error && result.status !== 'failed') {
    // Already decided / expired — tell the truth, not a 500.
    return NextResponse.json(
      { success: false, error: result.error, status: result.status },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success: result.ok,
    status: result.status,
    resultSummary: result.resultSummary ?? null,
  })
})
