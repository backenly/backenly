export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { provisionWorkspaceDatabase } from '@/lib/services/databaseProvisioning'
import { withAuth } from '@/lib/auth/route-protection'

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  projectId: z.string().uuid(),
  userId: z.string().uuid().optional(), // Make userId optional
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiBaseUrl: z.string().url().optional().nullable(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
})

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

/**
 * GET /api/workspaces - List all workspaces
 * 🔒 Protected: Requires authentication, scoped to user's projects
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const projectId = searchParams.get('projectId')

    // Build where clause - always filter by user's projects
    const where: any = {
      project: {
        userId: user.userId, // Security: Only show workspaces from user's projects
      },
    }
    if (projectId) where.projectId = projectId

    const workspaces = await prisma.workspace.findMany({
      where,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
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
      orderBy: {
        updatedAt: 'desc',
      },
    })

    return NextResponse.json({
      success: true,
      data: workspaces,
      count: workspaces.length,
    })
  } catch (error: any) {
    console.error('Error fetching workspaces:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch workspaces',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

/**
 * POST /api/workspaces - Create a new workspace
 * 🔒 Protected: Requires authentication and project ownership
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  // Hoisted so the catch block can resolve the existing workspace on a
  // unique-constraint conflict (P2002) without re-parsing the request.
  let projectIdForConflict: string | undefined
  try {
    const body = await request.json()
    const validatedData = createWorkspaceSchema.parse(body)
    projectIdForConflict = validatedData.projectId

    // Security: Verify user owns the project
    const project = await prisma.project.findFirst({
      where: {
        id: validatedData.projectId,
        userId: user.userId,
      },
    });

    if (!project) {
      return NextResponse.json(
        {
          success: false,
          error: 'Project not found or access denied',
        },
        { status: 403 }
      );
    }

    const workspace = await prisma.workspace.create({
      data: {
        name: validatedData.name,
        description: validatedData.description,
        projectId: validatedData.projectId,
        userId: validatedData.userId,
        environment: validatedData.environment || 'development',
        apiBaseUrl: validatedData.apiBaseUrl,
        status: validatedData.status || 'active',
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            environment: true,
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

    // Automatically provision databases for the workspace (Option 1: Shared infrastructure)
    // This makes Backenly a true BaaS - no manual database setup required!
    try {
      const provisionResult = await provisionWorkspaceDatabase(workspace.id, validatedData.projectId)
      if (!provisionResult.success) {
        console.error('Database provisioning failed:', provisionResult.error)
        // Don't fail workspace creation - databases can be provisioned later
        // But log the error for monitoring
      }
    } catch (error: any) {
      console.error('Error during database provisioning:', error)
      // Continue - workspace is created, databases can be provisioned later
    }

    return NextResponse.json(
      {
        success: true,
        data: workspace,
      },
      { status: 201 }
    )
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

    // One workspace per project is now a DB invariant (@@unique([projectId])).
    // A concurrent create — or a retry — hits P2002 instead of inserting a
    // duplicate. Resolve idempotently by returning the existing workspace.
    if (error?.code === 'P2002' && projectIdForConflict) {
      const existing = await prisma.workspace.findFirst({
        where: { projectId: projectIdForConflict },
        include: {
          project: { select: { id: true, name: true, environment: true } },
          user: { select: { id: true, email: true, name: true } },
        },
      })
      if (existing) {
        return NextResponse.json({ success: true, data: existing }, { status: 200 })
      }
    }

    console.error('Error creating workspace:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to create workspace',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

