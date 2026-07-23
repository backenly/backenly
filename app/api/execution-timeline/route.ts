export const dynamic = 'force-dynamic'

/**
 * EXECUTION TIMELINE API
 * ======================
 * Operator endpoint to query the persistent execution timeline.
 *
 * GET /api/execution-timeline?projectId=&limit=50
 *   → Recent timeline entries for a project (newest first)
 *
 * GET /api/execution-timeline?projectId=&executionId=
 *   → All entries for a single execution run + aggregated summary
 *
 * Requires platform authentication (JWT).
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { getTimeline, getExecutionSummary } from '@/lib/ai/execution-timeline'
import { ERROR_TAXONOMY } from '@/lib/errors/taxonomy'

export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)
    if (!authResult.authenticated) {
      return NextResponse.json({ error: authResult.error ?? 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const projectId   = searchParams.get('projectId')
    const executionId = searchParams.get('executionId') ?? undefined
    const limit       = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200)

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }

    const [entries, summary] = await Promise.all([
      getTimeline(projectId, limit, executionId),
      executionId ? getExecutionSummary(projectId, executionId) : Promise.resolve(null),
    ])

    return NextResponse.json({
      entries,
      summary,
      // Expose taxonomy reference so callers can render labels without extra requests
      taxonomyReference: Object.fromEntries(
        Object.entries(ERROR_TAXONOMY).map(([code, entry]) => [
          code,
          {
            label:            entry.label,
            description:      entry.description,
            recoverable:      entry.recoverable,
            operatorGuidance: entry.operatorGuidance,
          },
        ])
      ),
    })
  } catch (err: any) {
    console.error('[ExecutionTimeline API]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
