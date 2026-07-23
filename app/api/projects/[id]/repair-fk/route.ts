export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { repairForeignKeysWithDetails } from '@/lib/ai/fk-repair'

/**
 * POST /api/projects/[id]/repair-fk
 *
 * Retroactively adds missing FK constraints to all tables in the project's
 * workspace schema using case-insensitive table name lookup.
 *
 * Safe to run multiple times (idempotent — skips existing constraints).
 */
export const POST = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  try {
    const result = await repairForeignKeysWithDetails(projectId)
    return NextResponse.json({
      success: true,
      repaired: result.repaired,
      failed: result.failed,
      message: result.summaryMessage,
      details: result.details,
    })
  } catch (error: any) {
    console.error('[repair-fk] Error:', error)
    return NextResponse.json(
      { success: false, error: error.message || 'FK repair failed' },
      { status: 500 }
    )
  }
})
