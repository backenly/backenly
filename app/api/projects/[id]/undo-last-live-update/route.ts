/**
 * POST /api/projects/:id/undo-last-live-update
 * 
 * Undo the last live mutation for a LIVE project
 * Uses graph pointer architecture - simple pointer swap to previous graph
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { undoToGraph, getPreviousGraphId, isProjectLive } from '@/lib/orchestration/graph-pointer'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'

/**
 * Undo the last live mutation for a LIVE project.
 *
 * ── This route had NO authentication at all ─────────────────────────────────
 *
 * It took a project id from the path, confirmed the project was live, and
 * rolled its deployment back to the previous graph. Anyone who could reach the
 * server and knew or guessed a project id could roll back somebody else's live
 * backend. There was no session check, no ownership check, and no UI calling
 * it, which is why nothing ever noticed.
 *
 * Found by the route-authorization sweep. It is the third destructive route in
 * this family with the same defect, and the most severe: the other two at least
 * required a session.
 *
 * `canAdministerProject`, not `canAccessProject`: rolling back a live
 * deployment is not something a read-only collaborator should be able to do.
 */
export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = await params

  try {
    // Ownership first, before anything reads or writes project state.
    // 404 rather than 403 so the endpoint is not an oracle for project ids.
    if (!(await canAdministerProject(user.userId, projectId))) {
      return NextResponse.json(
        { success: false, message: 'Project not found' },
        { status: 404 },
      )
    }

    // 1. Verify project is LIVE
    const isLive = await isProjectLive(projectId)

    if (!isLive) {
      return NextResponse.json(
        { success: false, message: 'Can only undo updates on LIVE projects' },
        { status: 400 }
      )
    }

    // 2. Find previous graph
    const previousGraphId = await getPreviousGraphId(projectId)

    if (!previousGraphId) {
      return NextResponse.json(
        { success: false, message: 'No previous version to undo to' },
        { status: 404 }
      )
    }

    // 3. ATOMIC UNDO - Just swap pointer back to previous graph
    console.log('[Undo Last Live Update] Swapping pointer to previous graph:', previousGraphId)
    await undoToGraph(projectId, previousGraphId)
    console.log('[Undo Last Live Update] ✅ Undo complete')

    // 4. Mark the latest intent as rolled back (for audit trail)
    const lastIntent = await prisma.intentLog.findFirst({
      where: {
        projectId,
        liveMutation: true,
        rolledBack: false,
      },
      orderBy: { timestamp: 'desc' },
    })

    if (lastIntent) {
      await prisma.intentLog.update({
        where: { id: lastIntent.id },
        data: {
          rolledBack: true,
          rolledBackAt: new Date(),
        },
      })
    }

    return NextResponse.json({
      success: true,
      message: 'Live backend update undone successfully',
    })
  } catch (error: any) {
    console.error('[Undo Last Live Update] Error:', error)

    return NextResponse.json(
      {
        success: false,
        message: 'Failed to undo update',
        error: error.message,
      },
      { status: 500 }
    )
  }
})
