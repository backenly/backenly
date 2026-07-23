export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { deprovisionWorkspaceDatabase } from '@/lib/services/databaseProvisioning'
import { withAuth } from '@/lib/auth/route-protection'

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiBaseUrl: z.string().url().optional().nullable(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  totalFiles: z.number().int().min(0).optional(),
  totalRoutes: z.number().int().min(0).optional(),
  totalFunctions: z.number().int().min(0).optional(),
})

// GET /api/workspaces/[id] - Get a single workspace
export const GET = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const workspaceId = pathParts[pathParts.length - 1]

  try {
    // Find workspace with project ownership check
    const workspace = await prisma.workspace.findFirst({
      where: { 
        id: workspaceId,
        project: {
          userId: user.userId
        }
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
            apiUrlDev: true,
            apiUrlStaging: true,
            apiUrlProd: true,
          },
        },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })

    if (!workspace) {
      return NextResponse.json(
        {
          success: false,
          error: 'Workspace not found or access denied',
        },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      data: workspace,
    })
  } catch (error: any) {
    console.error('Error fetching workspace:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch workspace',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

// PUT /api/workspaces/[id] - Update a workspace
export const PUT = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const workspaceId = pathParts[pathParts.length - 1]

  try {
    const body = await request.json()
    const validatedData = updateWorkspaceSchema.parse(body)

    // Check if workspace exists and user has access
    const existing = await prisma.workspace.findFirst({
      where: { 
        id: workspaceId,
        project: {
          userId: user.userId
        }
      },
    })

    if (!existing) {
      return NextResponse.json(
        {
          success: false,
          error: 'Workspace not found or access denied',
        },
        { status: 404 }
      )
    }

    // Prepare update data
    const updateData: any = {}
    if (validatedData.name !== undefined) updateData.name = validatedData.name
    if (validatedData.description !== undefined) updateData.description = validatedData.description
    if (validatedData.environment !== undefined) updateData.environment = validatedData.environment
    if (validatedData.apiBaseUrl !== undefined) updateData.apiBaseUrl = validatedData.apiBaseUrl
    if (validatedData.status !== undefined) updateData.status = validatedData.status
    if (validatedData.totalFiles !== undefined) updateData.totalFiles = validatedData.totalFiles
    if (validatedData.totalRoutes !== undefined) updateData.totalRoutes = validatedData.totalRoutes
    if (validatedData.totalFunctions !== undefined) updateData.totalFunctions = validatedData.totalFunctions
    
    // Update lastActivity if stats were updated
    if (Object.keys(validatedData).some(key => ['totalFiles', 'totalRoutes', 'totalFunctions'].includes(key))) {
      updateData.lastActivity = new Date()
    }

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: updateData,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
            apiUrlDev: true,
            apiUrlStaging: true,
            apiUrlProd: true,
          },
        },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })

    return NextResponse.json({
      success: true,
      data: workspace,
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          details: error.errors,
        },
        { status: 400 }
      )
    }

    console.error('Error updating workspace:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update workspace',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

// DELETE /api/workspaces/[id] - Delete a workspace
export const DELETE = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const workspaceId = pathParts[pathParts.length - 1]

  try {
    const workspace = await prisma.workspace.findFirst({
      where: { 
        id: workspaceId,
        project: {
          userId: user.userId
        }
      },
      select: {
        id: true,
        projectId: true,
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

    // Deprovision databases before deleting workspace
    // This will drop the PostgreSQL schema and MongoDB database
    if (workspace.databaseProvisioned) {
      try {
        const deprovisionResult = await deprovisionWorkspaceDatabase(workspace.id, workspace.projectId)
        if (!deprovisionResult.success) {
          console.error('Database deprovisioning failed:', deprovisionResult.error)
          // Continue with workspace deletion anyway - databases can be cleaned up manually
        }
      } catch (error: any) {
        console.error('Error during database deprovisioning:', error)
        // Continue with workspace deletion anyway
      }
    }

    await prisma.workspace.delete({
      where: { id: workspaceId },
    })

    return NextResponse.json({
      success: true,
      message: 'Workspace deleted successfully',
    })
  } catch (error: any) {
    console.error('Error deleting workspace:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete workspace',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

