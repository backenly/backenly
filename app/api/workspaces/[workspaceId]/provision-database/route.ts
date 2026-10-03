export const dynamic = 'force-dynamic'

/**
 * API endpoint to manually provision databases for a workspace
 * 
 * POST /api/workspaces/[id]/provision-database
 * 
 * This endpoint allows manual database provisioning for existing workspaces
 * or re-provisioning if something went wrong.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { provisionWorkspaceDatabase } from '@/lib/services/databaseProvisioning'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'


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
export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    // Keyed by the folder segment, [workspaceId]. It was read as `id` before,
    // which Next never supplied, so this was undefined at runtime (#9).
    const { workspaceId: id } = await params

    // Get workspace
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        name: true,
        databaseProvisioned: true,
      },
    })

    if (!workspace) {
      return NextResponse.json(
        {
          success: false,
          error: 'Workspace not found',
        },
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

    // Provision databases
    const result = await provisionWorkspaceDatabase(workspace.id, workspace.projectId)

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Failed to provision databases',
        },
        { status: 500 }
      )
    }

    return NextResponse.json(
      {
        success: true,
        message: 'Databases provisioned successfully',
        data: {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          postgresSchema: result.postgresSchema,
          mongodbDatabase: result.mongodbDatabase,
        },
      },
      { status: 200 }
    )
  } catch (error: any) {
    console.error('Error provisioning databases:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to provision databases',
        message: error.message,
      },
      { status: 500 }
    )
  }
})

