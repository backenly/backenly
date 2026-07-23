/**
 * POST /api/projects/[id]/approvals/[findingId]/rollback
 *
 * Reverses a previously applied fix by restoring the schema snapshot
 * taken immediately before the fix was applied.
 *
 * "You approved it. One click to undo."
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { rollbackFix } from '@/lib/ai/approval-manager'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; findingId: string } },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const result = await rollbackFix(validated.projectId, params.findingId)
    return NextResponse.json(result, { status: result.success ? 200 : 422 })
  })
}
