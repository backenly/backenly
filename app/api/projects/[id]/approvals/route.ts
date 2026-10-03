/**
 * Approvals API — Trust Layer
 *
 * GET    /api/projects/[id]/approvals              — list pending approvals with previews
 * POST   /api/projects/[id]/approvals/:findingId   — approve (apply) a finding
 * DELETE /api/projects/[id]/approvals/:findingId   — dismiss a finding
 *
 * Every approval shows: exact SQL, affected tables, change type, reversibility warning.
 * Every approval creates a schema snapshot (rollback point) before applying.
 * "You approved it. Here is exactly what changed. One click to undo."
 *
 * Rollback: POST /api/projects/[id]/approvals/:findingId/rollback
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { getPendingApprovals, applyApproval, dismissFinding, rollbackFix } from '@/lib/ai/approval-manager'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const previews = await getPendingApprovals(validated.projectId)

    return NextResponse.json({
      projectId: validated.projectId,
      pendingCount: previews.length,
      approvals: previews,
      hint: previews.length > 0
        ? `POST /api/projects/${validated.projectId}/approvals/{findingId} to apply a fix.`
        : 'No pending approvals — backend is clean.',
    })
  })
}
