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
import { canAccessProject } from '@/lib/edition/guard'
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

    // getTimeline scopes its query by projectId, but nothing checked that the
    // CALLER may read that project. Execution history carries prompts, SQL and
    // error detail, so a cross-tenant read here is a disclosure of how somebody
    // else's backend is built and what it has been doing.
    // 404, so the endpoint is not an oracle for project ids.
    if (!authResult.userId || !(await canAccessProject(authResult.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
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
