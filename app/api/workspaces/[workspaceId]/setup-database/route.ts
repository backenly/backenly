export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { setupWorkspaceDatabaseFromSchema } from '@/lib/services/workspaceDatabaseSetup'
import { prisma } from '@/lib/db'

/**
 * POST /api/workspaces/[id]/setup-database
 * Manually trigger database setup from Prisma schema for a workspace
 */
export async function POST(request: NextRequest, props: { params: Promise<{ workspaceId: string }> }) {
  const params = await props.params;
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
}

