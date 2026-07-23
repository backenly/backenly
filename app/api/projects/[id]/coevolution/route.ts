// app/api/projects/[id]/coevolution/route.ts
/**
 * GET  /api/projects/[id]/coevolution  — analyse frontend usage gaps (read-only)
 * POST /api/projects/[id]/coevolution  — apply auto-approved proposals (GOVERNED)
 *
 * POST body: { apply?: boolean }
 *   apply=false (default) → dry-run, just returns the gap report
 *   apply=true            → runs applyAutoApprovedProposals under build lock
 *
 * All mutations go through runMutation():
 *   budget → lock → execute → audit → trace → UI sync → release
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import {
  analyzeCoevolutionGaps,
  applyAutoApprovedProposals,
} from '@/lib/ai/frontend-coevolution'
import { runMutation, mutationHttpStatus } from '@/lib/ai/build-runtime/mutate'

// ── GET — analysis only, no mutations ────────────────────────────────────────

export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async ({ projectId }) => {
    try {
      const report = await analyzeCoevolutionGaps(projectId)
      return NextResponse.json({ success: true, data: report })
    } catch (err: any) {
      console.error('[coevolution:GET] Error:', err?.message)
      return NextResponse.json(
        { success: false, error: 'Failed to analyse coevolution gaps' },
        { status: 500 },
      )
    }
  })
}

// ── POST — governed apply ─────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  return withProjectValidation<any>(request, async ({ projectId }) => {
    try {
      let apply = false
      try {
        const body = await request.json()
        if (typeof body?.apply === 'boolean') apply = body.apply
      } catch {
        // body is optional
      }

      // Analysis is always safe (read-only)
      const report = await analyzeCoevolutionGaps(projectId)

      if (!apply) {
        return NextResponse.json({ success: true, applied: false, data: report })
      }

      // Mutations go through the governance kernel
      const result = await runMutation(
        {
          projectId,
          kind:        'modify',
          action:      'coevolution_apply',
          auditAction: 'COEVOLUTION_AUTO_APPLY',
          // Coevolution only adds columns (additive) — no schema snapshot needed for rollback
          // since every change is an idempotent ADD COLUMN IF NOT EXISTS
          snapshotBefore: false,
        },
        () => applyAutoApprovedProposals(projectId, report),
      )

      if (!result.ok) {
        return NextResponse.json(
          { success: false, error: result.error ?? 'Coevolution apply failed' },
          { status: mutationHttpStatus(result) },
        )
      }

      const appliedFixes = result.data ?? []
      return NextResponse.json({
        success:      true,
        applied:      true,
        appliedCount: appliedFixes.length,
        appliedFixes,
        data:         report,
      })
    } catch (err: any) {
      console.error('[coevolution:POST] Error:', err?.message)
      return NextResponse.json(
        { success: false, error: 'Coevolution operation failed' },
        { status: 500 },
      )
    }
  })
}
