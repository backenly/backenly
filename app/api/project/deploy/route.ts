export const dynamic = 'force-dynamic'

/**
 * POST /api/project/deploy
 *
 * Converts a sandbox project to production.
 *
 * Flow:
 *  1. Verify user owns the project
 *  2. Check user has BUILDER or SCALE subscription
 *  3. Verify plan allows deployment
 *  4. Clear expiresAt — project persists permanently
 *  5. Set environment = "production" + isDeployed = true
 *
 * Returns:
 *  200  { success: true, project: { id, name, environment, deployedAt } }
 *  400  { error: "LIMIT_EXCEEDED", message: "..." }
 *  401  Unauthenticated
 *  403  Project not owned by user
 *  404  Project not found
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { promoteSandboxToProduction } from '@/lib/projects/sandbox-lifecycle'
import { enforceDeployment } from '@/lib/entitlements/policy'
import { canWriteProject } from '@/lib/edition/guard'

export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const { projectId } = body

    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json(
        { error: 'MISSING_PROJECT_ID', message: 'projectId is required' },
        { status: 400 }
      )
    }

    const userId = user.userId

    // Check the caller may deploy this project
    if (!(await canWriteProject(userId, projectId))) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Project not found or access denied' },
        { status: 404 }
      )
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, expiresAt: true, isDeployed: true, environment: true },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Project not found or access denied' },
        { status: 404 }
      )
    }

    // Check plan allows deployment
    const deployCheck = await enforceDeployment(userId)
    if (deployCheck !== true) {
      return NextResponse.json(
        {
          error: 'LIMIT_EXCEEDED',
          message: deployCheck.message,
          upgradeRequired: true,
          requiredPlan: deployCheck.requiredPlan,
        },
        { status: 402 }
      )
    }

    // Execute the upgrade
    const result = await promoteSandboxToProduction(projectId, userId)

    if (!result.success) {
      // The commercial refusals used to be mapped here too. They are gone
      // because the lifecycle primitive no longer re-derives plan policy;
      // enforceDeployment above already answered that and returns its own 402.
      const statusCode = result.errorCode === 'ALREADY_PRODUCTION' ? 409 : 400

      return NextResponse.json(
        { error: result.errorCode ?? 'DEPLOY_FAILED', message: result.error },
        { status: statusCode }
      )
    }

    // Return updated project
    const updated = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, environment: true, deployedAt: true, isDeployed: true, expiresAt: true },
    })

    return NextResponse.json({
      success: true,
      message: 'Project deployed to production successfully.',
      project: updated,
    })
  } catch (error: any) {
    console.error('[Deploy] Error:', error)
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: error.message || 'Deployment failed' },
      { status: 500 }
    )
  }
})
