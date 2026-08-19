import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { sanitizeError } from '@/lib/errors/sanitize'
import { createExecutionContextFromRequest } from '@/lib/context/execution-context'
import { undoToGraph } from '@/lib/orchestration/graph-pointer'
import { reconcileWorkspaceToGraph } from '@/lib/orchestration/graph-reconciler'
import { recordRollbackMemory } from '@/lib/operational-memory/ledger'
import { prisma } from '@/lib/db'
import { getUserEntitlements } from '@/lib/billing'
import type { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

const QUOTA_DISABLED = process.env.DISABLE_QUOTA_ENFORCEMENT === 'true'

/**
 * POST /api/projects/[projectId]/restore
 *
 * Restore the backend to a specific previous state.
 * Requires Growth plan or higher (allowDeploymentRollback).
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const body = await request.json()
    const { graphId, sequenceNumber } = body
    
    console.log(`[Restore API] Received restore request for project ${params.id}, graphId: ${graphId}, seq: ${sequenceNumber}`)
    
    if (!graphId && !sequenceNumber) {
      return NextResponse.json(
        { 
          success: false,
          error: 'No version specified',
          message: 'Please provide graphId or sequenceNumber'
        }, 
        { status: 400 }
      )
    }

    // 1. Authenticate user
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        {
          success: false,
          error: 'Authentication required',
          message: 'Please log in to restore previous versions'
        },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // 2. Check plan entitlement (allowDeploymentRollback — Growth+)
    if (!QUOTA_DISABLED) {
      const entitlements = await getUserEntitlements(userId)
      if (!entitlements?.allowDeploymentRollback) {
        return NextResponse.json(
          {
            success: false,
            error: 'Deployment rollback is available on the Pro plan and higher.',
            code: 'PLAN_LIMIT_EXCEEDED',
            upgradeRequired: true,
            currentPlan: entitlements?.planName || 'FREE',
            requiredPlan: 'BUILDER',
          },
          { status: 403 }
        )
      }
    }

    // 3. Find target graph by ID or sequence number
    let targetGraph = null
    
    if (graphId) {
      targetGraph = await prisma.backendGraph.findFirst({
        where: {
          id: graphId,
          projectId,
        },
      })
    } else if (sequenceNumber) {
      targetGraph = await prisma.backendGraph.findFirst({
        where: {
          projectId,
          sequenceNumber,
        },
      })
    }

    if (!targetGraph) {
      return NextResponse.json(
        {
          success: false,
          error: 'Version not found',
          message: 'The selected version no longer exists'
        },
        { status: 404 }
      )
    }

    console.log(`[Restore API] Found graph ${targetGraph.id} (seq ${targetGraph.sequenceNumber})`)

    // Capture the pre-restore active graph for the memory record.
    const previousProject = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeGraphId: true },
    })

    // 3. Perform restore (pointer-based undo with optimistic locking)
    try {
      await undoToGraph(projectId, targetGraph.id)
    } catch (undoError: any) {
      // Handle undo conflicts gracefully
      if (undoError.message?.includes('UNDO_CONFLICT')) {
        return NextResponse.json(
          {
            success: false,
            error: 'Project was modified during restore. Please retry.',
          },
          { status: 409 }
        )
      }
      throw undoError
    }

    // 4. Make the restore real: create whatever this version's graph says
    // should exist but is currently missing (tables, columns, APIs, storage,
    // base auth). Additive only — never drops anything added since. Failures
    // here don't undo the pointer swap; they're surfaced in the response so
    // the UI can be honest about what came back and what needs manual review.
    const reconcile = await reconcileWorkspaceToGraph(
      projectId,
      targetGraph.graphData as unknown as BackendStateGraph,
    ).catch((err) => {
      console.error('[Restore API] Reconciliation failed:', err)
      return { restored: [], notRestored: [] }
    })

    await recordRollbackMemory({
      projectId,
      actorId: userId,
      summary: `Restored to version ${targetGraph.sequenceNumber}.`,
      reason: 'User rolled back to a previously recorded backend version.',
      beforeState: { graphId: previousProject?.activeGraphId ?? null },
      afterState: { graphId: targetGraph.id, sequenceNumber: targetGraph.sequenceNumber, reconcile },
      rollbackId: targetGraph.id,
    }).catch((err) => {
      console.error('[Restore API] Failed to record rollback memory:', err)
    })

    return NextResponse.json({
      success: true,
      message: 'Successfully restored to previous version',
      reconcile,
    })

  } catch (error) {
    console.error('[Restore API] Error:', error)
    const sanitized = sanitizeError(error)

    return NextResponse.json(sanitized, { status: 500 })
  }
}
