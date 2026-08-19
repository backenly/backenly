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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
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
}

