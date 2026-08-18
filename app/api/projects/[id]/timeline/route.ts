export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'
import { getUserEntitlements } from '@/lib/billing'

const QUOTA_DISABLED = process.env.DISABLE_QUOTA_ENFORCEMENT === 'true'

/**
 * GET /api/projects/[projectId]/timeline
 *
 * Returns timeline derived from BackendGraph history.
 * History depth is gated by plan:
 *   FREE / STARTER : no history (returns empty)
 *   GROWTH         : last 30 versions
 *   PRO            : full history (unlimited)
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Authenticate
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Verify project access
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, activeGraphId: true },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // ── Plan-based history limit ──────────────────────────────────────────────
    // maxDeploymentHistory: 0 = none, N = last N, null = unlimited
    let historyLimit: number | null = null // null = unlimited

    if (!QUOTA_DISABLED) {
      const entitlements = await getUserEntitlements(userId)
      const maxHistory = entitlements?.maxDeploymentHistory ?? 0

      if (maxHistory === 0) {
        // FREE / STARTER: no version history
        return NextResponse.json({
          success: true,
          timeline: [],
          totalVersions: 0,
          currentVersion: 0,
        })
      }

      historyLimit = maxHistory // null means unlimited
    }

    // ── Fetch graph versions ─────────────────────────────────────────────────
    // When limited, fetch newest-first then reverse so diffs are chronological
    const graphs = await prisma.backendGraph.findMany({
      where: { projectId },
      orderBy: { sequenceNumber: historyLimit !== null ? 'desc' : 'asc' },
      ...(historyLimit !== null ? { take: historyLimit } : {}),
      select: {
        id: true,
        sequenceNumber: true,
        createdAt: true,
        intentId: true,
        graphData: true,
      },
    })

    if (historyLimit !== null) graphs.reverse()

    // Build timeline entries from graph diffs
    const timeline = []

    for (let i = 0; i < graphs.length; i++) {
      const graph = graphs[i]
      const prevGraph = i > 0 ? graphs[i - 1] : null

      // Mark initial empty state as non-restorable
      if (i === 0 && Object.keys((graph.graphData as any)?.entities || {}).length === 0) {
        timeline.push({
          id: graph.id,
          sequenceNumber: graph.sequenceNumber,
          message: 'Project created',
          details: ['Initial backend state'],
          createdAt: graph.createdAt.toISOString(),
          canRestore: false,
          isActive: project.activeGraphId === graph.id,
          changeCount: 0,
        })
        continue
      }

      // Calculate diff from previous graph
      const currentEntities = Object.keys((graph.graphData as any)?.entities || {})
      const prevEntities = prevGraph
        ? Object.keys((prevGraph.graphData as any)?.entities || {})
        : []

      const addedEntities = currentEntities.filter(e => !prevEntities.includes(e))
      const removedEntities = prevEntities.filter(e => !currentEntities.includes(e))

      let message = 'Backend updated'
      const details: string[] = []

      if (addedEntities.length > 0) {
        message = `${addedEntities.length} table${addedEntities.length > 1 ? 's' : ''} added`
        addedEntities.forEach(e => details.push(`Added: ${e}`))
      }

      if (removedEntities.length > 0) {
        message = `${removedEntities.length} table${removedEntities.length > 1 ? 's' : ''} removed`
        removedEntities.forEach(e => details.push(`Removed: ${e}`))
      }

      const currentApis = Object.keys((graph.graphData as any)?.apis || {})
      const prevApis = prevGraph
        ? Object.keys((prevGraph.graphData as any)?.apis || {})
        : []
      const addedApis = currentApis.filter(a => !prevApis.includes(a))

      if (addedApis.length > 0) {
        details.push(`${addedApis.length} API endpoint${addedApis.length > 1 ? 's' : ''} created`)
      }

      const currentAuth = (graph.graphData as any)?.auth
      const prevAuth = prevGraph ? (prevGraph.graphData as any)?.auth : null
      if (currentAuth?.providers && Object.keys(currentAuth.providers).length > 0) {
        if (!prevAuth?.providers || Object.keys(prevAuth.providers).length === 0) {
          details.push('Authentication enabled')
        }
      }

      timeline.push({
        id: graph.id,
        sequenceNumber: graph.sequenceNumber,
        message,
        details: details.length > 0 ? details : ['Configuration updated'],
        createdAt: graph.createdAt.toISOString(),
        canRestore: true, // all non-initial versions are restorable
        isActive: project.activeGraphId === graph.id,
        changeCount: addedEntities.length + removedEntities.length + addedApis.length,
      })
    }

    // Return in reverse chronological order (newest first)
    return NextResponse.json({
      success: true,
      timeline: timeline.reverse(),
      totalVersions: graphs.length,
      currentVersion: graphs.find(g => g.id === project.activeGraphId)?.sequenceNumber || 0,
    })

  } catch (error) {
    console.error('[Timeline API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to load timeline' },
      { status: 500 }
    )
  }
}
