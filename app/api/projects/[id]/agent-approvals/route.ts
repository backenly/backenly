export const dynamic = 'force-dynamic'

/**
 * Agent approval requests — the human side of MCP destructive-op escalation.
 *
 * GET  /api/projects/[id]/agent-approvals
 *   List requests (newest first) for the Review Queue.
 *
 * POST /api/projects/[id]/agent-approvals
 *   Body: { approvalId: string, decision: 'approve' | 'reject' }
 *   Approving executes the parked operation immediately (brain replay with
 *   destructiveConfirmed=true) and returns the outcome.
 *
 * Auth: platform JWT + project ownership (withProjectAccess). Scoped agent
 * keys can create and poll requests over MCP but can never decide them —
 * that asymmetry IS the safety model.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { listApprovals, decideApproval } from '@/lib/mcp/approvals'

export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  const approvals = await listApprovals(projectId)
  return NextResponse.json({ success: true, approvals })
})

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  let body: { approvalId?: string; decision?: string }
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
  })

  if (!result.ok && result.status === 'missing') {
    return NextResponse.json({ success: false, error: result.error }, { status: 404 })
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
