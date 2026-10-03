export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { setupWorkspaceDatabaseFromSchema } from '@/lib/services/workspaceDatabaseSetup'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db'

/**
 * POST /api/workspaces/[id]/setup-database
 * Manually trigger database setup from Prisma schema for a workspace
 */

/**
 * ── This route had NO authentication ────────────────────────────────────────
 *
 * It took a workspace id from the path and provisioned/rebuilt that workspace's
 * database. No session, no ownership check, and no UI calling it. Anyone able
 * to reach the server and name a workspace could act on it.
 *
 * Found by the route-authorization sweep. A workspace belongs to a project, so
 * the check is: resolve the workspace, then ask whether this caller may
 * administer its project. Resolving FIRST and authorizing SECOND is safe here
 * because the lookup reveals nothing to the caller - a failed authorization
 * returns 404 either way, so the endpoint is not an oracle for workspace ids.
 */
export const POST = withAuth(async (request: NextRequest, { user, params: routeParams }) => {
  const params = await routeParams
  try {
    const workspaceId = params.workspaceId
    
    // Fetch workspace to get projectId
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { 
        id: true, 
        projectId: true, 
        name: true,
        postgresSchema: true,
        mongodbDatabase: true,
      },
    })

    if (!workspace) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 }
      )
    }

    // The authorization this route never had. A workspace belongs to a
    // project, so "may this caller administer that project" is the question.
    // 404, matching the not-found answer above, so the two are indistinguishable
    // and the endpoint cannot be used to discover which workspaces exist.
    if (!(await canAdministerProject(user.userId, workspace.projectId))) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 },
      )
    }


    console.log(`🚀 Manually setting up database for workspace ${workspace.name} (${workspaceId})...`)

    const result = await setupWorkspaceDatabaseFromSchema(
      workspace.projectId,
      workspace.id
    )

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Database setup complete for workspace ${workspace.name}`,
        data: {
          postgresSchema: result.postgresSchema,
          mongodbDatabase: result.mongodbDatabase,
          tablesCreated: result.tablesCreated || [],
          collectionsCreated: result.collectionsCreated || [],
        },
      })
    } else {
      return NextResponse.json(
        { 
          success: false, 
          error: result.error || 'Failed to setup database',
          details: result,
        },
        { status: 500 }
      )
    }
  } catch (error: any) {
    console.error('Error setting up database:', error)
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
})

