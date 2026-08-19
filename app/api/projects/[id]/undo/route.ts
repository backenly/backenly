import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { logErrorInternal } from '@/lib/errors/sanitize'
import { getPreviousGraphId, undoToGraph } from '@/lib/orchestration/graph-pointer'
import { generateTraceId } from '@/lib/utils'

/**
 * POST /api/projects/[projectId]/undo
 * 
 * Undo the last change made to the backend.
 * 
 * GRAPH-FIRST ARCHITECTURE:
 * - Source of truth is BackendGraph table, not intent logs
 * - Uses sequenceNumber for deterministic ordering
 * - Intent logs are observational only, never authoritative
 * 
 * GUARANTEE: "Undo any change. Nothing breaks. Ever."
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const traceId = generateTraceId()

  try {
    // 1. Authenticate user
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        {
          error: 'Authentication required. Please log in again.',
          traceId,
          code: 'AUTH_REQUIRED',
        },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    console.log(`[Undo API] Starting undo operation for project ${projectId}, traceId: ${traceId}`)

    // 2. GRAPH-FIRST: Check if there's a previous graph version
    // Source of truth is BackendGraph, not intent logs
    const previousGraphId = await getPreviousGraphId(projectId)
    
    if (!previousGraphId) {
      console.log(`[Undo API] No previous graph found for project ${projectId}`)
      return NextResponse.json(
        {
          error: 'Nothing to undo',
          message: 'This is the initial version of your backend. No changes to undo yet.',
          traceId,
          code: 'NO_PREVIOUS_STATE',
        },
        { status: 400 }
      )
    }

    console.log(`[Undo API] Found previous graph: ${previousGraphId}`)

    // 3. Execute undo via atomic pointer swap
    try {
      await undoToGraph(projectId, previousGraphId)
      
      console.log(`[Undo API] ✅ Undo complete, swapped to graph: ${previousGraphId}`)

      return NextResponse.json({
        success: true,
        message: 'Change undone successfully',
        traceId,
      })

    } catch (rollbackError: any) {
      // Handle undo conflicts gracefully
      if (rollbackError.message?.includes('UNDO_CONFLICT')) {
        return NextResponse.json(
          {
            error: 'Project was modified during undo',
            message: 'Another change happened at the same time. Please try again.',
            traceId,
            code: 'CONCURRENT_MODIFICATION',
            recovery: ['Wait a moment and try again'],
          },
          { status: 409 }
        )
      }
      
      // Log internally and return detailed error
      console.error(`[Undo API] Undo execution threw error:`, rollbackError)
      
      logErrorInternal(rollbackError, {
        projectId,
        userId,
        action: 'undo',
        traceId,
      })

      return NextResponse.json(
        {
          error: 'Undo failed unexpectedly',
          message: 'An unexpected error occurred during undo. Your backend is unchanged.',
          traceId,
          code: 'ROLLBACK_EXCEPTION',
          details: {
            error: rollbackError.message,
          },
          recovery: [
            'Wait a moment and try again',
            'Check the project status in Inspector',
            'Contact support with trace ID: ' + traceId,
          ],
        },
        { status: 500 }
      )
    }

  } catch (error: any) {
    // Top-level error handler
    console.error(`[Undo API] Top-level error:`, error)
    
    logErrorInternal(error, {
      projectId: params.id,
      action: 'undo',
      traceId,
    })

    return NextResponse.json(
      {
        error: 'Undo request failed',
        message: 'Something went wrong processing your undo request. Your backend is unchanged.',
        traceId,
        code: 'REQUEST_FAILED',
        details: {
          error: error.message,
        },
        recovery: [
          'Try refreshing the page',
          'Check your internet connection',
          'Contact support with trace ID: ' + traceId,
        ],
      },
      { status: 500 }
    )
  }
}
