export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/route-protection'
import { deleteProjectCompletely } from '@/lib/projects/delete'
import { canAccessProject } from '@/lib/edition/guard'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiUrlDev: z.string().url().optional().nullable(),
  apiUrlStaging: z.string().url().optional().nullable(),
  apiUrlProd: z.string().url().optional().nullable(),
  // Metrics update
  apiRequests: z.number().int().min(0).optional(),
  avgLatency: z.number().int().min(0).optional(),
  errorCount: z.number().int().min(0).optional(),
  storageUsed: z.number().int().min(0).optional(),
  activeUsers: z.number().int().min(0).optional(),
})

// GET /api/projects/[id] - Get a single project
export const GET = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const projectId = pathParts[pathParts.length - 1]

  try {
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        userId: user.userId 
      },
      include: {
        // functions: true, // Commented out - functions feature removed
        tables: true,
        workspaces: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        {
          success: false,
          error: 'Project not found or access denied',
        },
        { status: 404 }
      )
    }

    // Serialize BigInt to number for JSON response
    const serializedProject = {
      ...project,
      storageUsed: Number(project.storageUsed),
      storageLimit: Number(project.storageLimit),
      maxFileSize: Number(project.maxFileSize),
      maxFilesPerBucket: project.maxFilesPerBucket, // Already Int, not BigInt
      metrics: {
        totalFunctions: 0, // Functions feature removed
        totalTables: project.tables.length,
        totalWorkspaces: project.workspaces.length,
        apiRequests: project.apiRequests,
        avgLatency: project.avgLatency,
        errorCount: project.errorCount,
        storageUsed: Number(project.storageUsed),
        activeUsers: project.activeUsers,
        lastMetricsUpdate: project.lastMetricsUpdate,
      },
    }

    return NextResponse.json({
      success: true,
      data: serializedProject,
    })
  } catch (error: any) {
    console.error('Error fetching project:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch project',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

// PUT /api/projects/[id] - Update a project
export const PUT = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const projectId = pathParts[pathParts.length - 1]

  try {
    const body = await request.json()
    const validatedData = updateProjectSchema.parse(body)

    // Check if project exists and user owns it
    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json(
        {
          success: false,
          error: 'Project not found or access denied',
        },
        { status: 404 }
      )
    }

    // Prepare update data
    const updateData: any = {}
    if (validatedData.name !== undefined) updateData.name = validatedData.name
    if (validatedData.description !== undefined) updateData.description = validatedData.description
    if (validatedData.environment !== undefined) updateData.environment = validatedData.environment
    if (validatedData.apiUrlDev !== undefined) updateData.apiUrlDev = validatedData.apiUrlDev
    if (validatedData.apiUrlStaging !== undefined) updateData.apiUrlStaging = validatedData.apiUrlStaging
    if (validatedData.apiUrlProd !== undefined) updateData.apiUrlProd = validatedData.apiUrlProd
    
    // Update metrics if provided
    if (validatedData.apiRequests !== undefined) updateData.apiRequests = validatedData.apiRequests
    if (validatedData.avgLatency !== undefined) updateData.avgLatency = validatedData.avgLatency
    if (validatedData.errorCount !== undefined) updateData.errorCount = validatedData.errorCount
    if (validatedData.storageUsed !== undefined) updateData.storageUsed = BigInt(validatedData.storageUsed)
    if (validatedData.activeUsers !== undefined) updateData.activeUsers = validatedData.activeUsers
    
    // Update lastMetricsUpdate if any metric was updated
    if (Object.keys(validatedData).some(key => ['apiRequests', 'avgLatency', 'errorCount', 'storageUsed', 'activeUsers'].includes(key))) {
      updateData.lastMetricsUpdate = new Date()
    }

    const project = await prisma.project.update({
      where: { id: projectId },
      data: updateData,
      include: {
        // functions: true, // Commented out - functions feature removed
        tables: true,
        workspaces: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })

    // Serialize BigInt to number for JSON response
    const serializedProject = {
      ...project,
      storageUsed: Number(project.storageUsed),
      storageLimit: Number(project.storageLimit),
      maxFileSize: Number(project.maxFileSize),
      maxFilesPerBucket: project.maxFilesPerBucket, // Already Int, not BigInt
      metrics: {
        totalFunctions: 0, // Functions feature removed
        totalTables: project.tables.length,
        totalWorkspaces: project.workspaces.length,
        apiRequests: project.apiRequests,
        avgLatency: project.avgLatency,
        errorCount: project.errorCount,
        storageUsed: Number(project.storageUsed),
        activeUsers: project.activeUsers,
        lastMetricsUpdate: project.lastMetricsUpdate,
      },
    }

    return NextResponse.json({
      success: true,
      data: serializedProject,
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

    console.error('Error updating project:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update project',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

// DELETE /api/projects/[id] - Delete a project
export const DELETE = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const projectId = pathParts[pathParts.length - 1]

  try {
    const project = await prisma.project.findFirst({
      where: { 
        id: projectId,
        userId: user.userId 
      },
    })

    if (!project) {
      return NextResponse.json(
        {
          success: false,
          error: 'Project not found or access denied',
        },
        { status: 404 }
      )
    }

    // Drops every schema this project owns and deletes its rows in one
    // transaction, then removes its backups and storage objects. Previously
    // this was a bare `prisma.project.delete`, which left workspace_<id> and
    // every branch schema resident with nothing pointing at them.
    await deleteProjectCompletely(projectId)

    return NextResponse.json({
      success: true,
      message: 'Project deleted successfully',
    })
  } catch (error: any) {
    console.error('Error deleting project:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete project',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

