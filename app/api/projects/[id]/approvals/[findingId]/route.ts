/**
 * Single-finding approval actions
 *
 * GET    /api/projects/[id]/approvals/[findingId]  — preview the fix (SQL, impact, reversibility)
 * POST   /api/projects/[id]/approvals/[findingId]  — apply this fix (GOVERNED via build lock)
 * DELETE /api/projects/[id]/approvals/[findingId]  — dismiss without applying
 *
 * POST goes through runMutation() to prevent concurrent builds from racing
 * with approval execution on the same project schema.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { applyApproval, dismissFinding, getApprovalPreview } from '@/lib/ai/approval-manager'
import { runMutation, mutationHttpStatus } from '@/lib/ai/build-runtime/mutate'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string; findingId: string }> }
) {
  const params = await props.params;
  return withProjectValidation<any>(request, async (validated) => {
    const preview = await getApprovalPreview(validated.projectId, params.findingId)
    if (!preview) {
      return NextResponse.json({ error: 'Finding not found or already resolved.' }, { status: 404 })
    }
    return NextResponse.json(preview)
  })
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string; findingId: string }> }
) {
  const params = await props.params;
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated

    const result = await runMutation(
      {
        projectId,
        kind:        'modify',
        action:      `apply_approval_${params.findingId.slice(0, 8)}`,
        auditAction: 'APPROVAL_APPLY',
        // applyApproval already takes its own pre-fix snapshot internally;
        // no second snapshot needed here.
        snapshotBefore: false,
      },
      () => applyApproval(projectId, params.findingId),
    )

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? 'Failed to apply approval' },
        { status: mutationHttpStatus(result) },
      )
    }

    const applyResult = result.data!
    return NextResponse.json(applyResult, { status: applyResult.success ? 200 : 422 })
  })
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ id: string; findingId: string }> }
) {
  const params = await props.params;
  return withProjectValidation<any>(request, async (validated) => {
    await dismissFinding(validated.projectId, params.findingId)
    return NextResponse.json({ ok: true, findingId: params.findingId, status: 'dismissed' })
  })
}
