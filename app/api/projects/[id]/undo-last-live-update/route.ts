/**
 * POST /api/projects/:id/undo-last-live-update
 * 
 * Undo the last live mutation for a LIVE project
 * Uses graph pointer architecture - simple pointer swap to previous graph
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { undoToGraph, getPreviousGraphId, isProjectLive } from '@/lib/orchestration/graph-pointer'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const projectId = params.id

  try {
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
}
