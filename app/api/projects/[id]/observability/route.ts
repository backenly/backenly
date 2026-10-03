/**
 * Runtime Observability API
 *
 * GET /api/projects/[id]/observability
 *   Returns the unified mutation + agent timeline for a project.
 *   Query params:
 *     ?limit=50           Max entries (default 100)
 *     ?types=agent_run,auto_fix_applied   Filter by event type
 *     ?since=2025-01-01   ISO date cutoff
 *     ?view=mutations     Shortcut: schema mutations only (snapshots + drift)
 *
 * The timeline joins: ExecutionLog + HealthFinding + AutonomousAction + WorkspaceSchemaSnapshot
 * Sorted descending. Everything that happened, in order.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { buildTimeline, buildMutationTimeline } from '@/lib/ai/execution-tracer'
import { getCacheStats } from '@/lib/ai/cost-governor'
import { prisma } from '@/lib/db/prisma'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const url = request.nextUrl
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 500)
    const typesParam = url.searchParams.get('types')
    const sinceParam = url.searchParams.get('since')
    const view = url.searchParams.get('view')

    // Shortcut: mutations-only view
    if (view === 'mutations') {
      const mutations = await buildMutationTimeline(validated.projectId, limit)
      return NextResponse.json({
        projectId: validated.projectId,
        view: 'mutations',
        count: mutations.length,
        mutations,
      })
    }

    const since = sinceParam ? new Date(sinceParam) : undefined
    const types = typesParam ? typesParam.split(',') : undefined

    const entries = await buildTimeline(validated.projectId, { limit, types, since })

    // Governance / cost summary — useful for debugging
    const [openFindings, recentActions] = await Promise.all([
      prisma.healthFinding.count({
        where: { projectId: validated.projectId, status: { in: ['open', 'pending_approval'] } },
      }),
      prisma.autonomousAction.count({
        where: {
          projectId: validated.projectId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ])

    const cache = getCacheStats()

    return NextResponse.json({
      projectId: validated.projectId,
      generatedAt: new Date().toISOString(),
      stats: {
        openFindings,
        actionsLast24h: recentActions,
        timelineEntries: entries.length,
        cacheSize: cache.size,
      },
      timeline: entries,
      hint: 'Use ?types=agent_run,auto_fix_applied,health_finding to filter. ?view=mutations for schema history.',
    })
  })
}
