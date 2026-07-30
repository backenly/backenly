/**
 * PHASE 10 — ADMIN DEBUG API
 * ===========================
 * GET /api/debug/[projectId]
 *
 * Returns a snapshot useful for diagnosing AI failures:
 *   - Last 10 per-message debug logs (mode, subBehavior, execution flags)
 *   - Last 10 executor-level action logs
 *   - Last build intent from the sticky store
 *   - Current project state snapshot (entity/API counts)
 *   - Execution stats (success rate, avg duration)
 *
 * Access: authenticated platform users who own the project.
 * Never exposed to end-users.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { getMessageDebugLogs } from '@/lib/ai/message-debug-logger'
import { getRecentExecutions, getExecutionStats } from '@/lib/observability/execution-logger'
import { prisma } from '@/lib/db/prisma'
import { countExposedResources } from '@/lib/api/exposed-resources'

export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated

    const [
      messageLogs,
      executionLogs,
      stats,
      stickyIntent,
      latestGraph,
      apiCount,
      functionCount,
    ] = await Promise.all([
      // Per-message Phase 10 debug logs
      getMessageDebugLogs(projectId, 10),

      // Per-action executor logs (existing observability)
      getRecentExecutions(projectId, 10),

      // 7-day success rate / avg duration
      getExecutionStats(projectId),

      // Last sticky build intent
      prisma.projectPreference.findFirst({
        where: { projectId, type: 'sticky_intent', key: 'last_build' },
        select: { value: true, updatedAt: true },
      }).catch(() => null),

      // Latest backend graph (project state snapshot)
      prisma.backendGraph.findFirst({
        where:   { projectId },
        orderBy: { sequenceNumber: 'desc' },
        select: {
          id: true,
          sequenceNumber: true,
          graphData: true,
          createdAt: true,
        },
      }).catch(() => null),

      // API count
      countExposedResources(projectId).catch(() => 0),

      // AI function count
      prisma.aiFunction.count({ where: { projectId } }).catch(() => 0),
    ])

    // Parse sticky intent value
    let lastBuildIntent: {
      intent: string
      intentType: string
      savedAt: string
      executed: boolean
    } | null = null
    if (stickyIntent?.value) {
      try {
        lastBuildIntent = JSON.parse(stickyIntent.value as string)
      } catch {
        lastBuildIntent = null
      }
    }

    // Summarise graph data without returning the full blob
    let stateSnapshot: {
      graphId: string
      version: number
      entityCount: number
      tableNames: string[]
      apiCount: number
      functionCount: number
      updatedAt: Date
    } | null = null

    if (latestGraph) {
      const gd = latestGraph.graphData as Record<string, any>
      const entities: Array<{ name?: string }> = Array.isArray(gd?.entities)
        ? gd.entities
        : Array.isArray(gd?.tables)
          ? gd.tables
          : []
      stateSnapshot = {
        graphId:     latestGraph.id,
        version:     latestGraph.sequenceNumber,
        entityCount: entities.length,
        tableNames:  entities.map(e => e.name ?? '').filter(Boolean),
        apiCount,
        functionCount,
        updatedAt:   latestGraph.createdAt,
      }
    }

    // Derive last-execution summary from message logs
    const lastExecution = messageLogs.find(l => l.executionTriggered) ?? null

    return NextResponse.json({
      projectId,
      // ── Phase 10: per-message debug logs ──────────────────────────────────
      messageLogs,
      // ── Executor-level action logs ─────────────────────────────────────────
      executionLogs,
      // ── Aggregated stats ───────────────────────────────────────────────────
      stats,
      // ── Sticky intent (last build context) ─────────────────────────────────
      lastBuildIntent: lastBuildIntent
        ? { ...lastBuildIntent, savedAt: stickyIntent?.updatedAt }
        : null,
      // ── Last execution (most recent message that triggered execution) ───────
      lastExecution,
      // ── Current project state snapshot ─────────────────────────────────────
      stateSnapshot,
    })
  })
}
