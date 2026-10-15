export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/route-protection'
import { deleteProjectCompletely } from '@/lib/projects/delete'
import { canAccessProject, canAdministerProject, canWriteProject } from '@/lib/edition/guard'
import { getProjectQuota } from '@/lib/services/storageQuota'

// Usage figures (storageUsed, apiRequests, activeUsers, ...) are measured by the
// server and are deliberately NOT accepted here. They used to be, which let any
// project writer set storageUsed to 0 and upload past the plan's quota. Zod
// strips unknown keys, so a client that still sends them is ignored, not refused.
const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiUrlDev: z.string().url().optional().nullable(),
  apiUrlStaging: z.string().url().optional().nullable(),
  apiUrlProd: z.string().url().optional().nullable(),
})

// The response is the client's Project type (lib/api/projects.ts), BUILT FROM
// AN EXPLICIT SELECT — never a spread of the raw row. The raw row carries the
// project's end-user JWT signing secret (jwtSecret, frequently plaintext),
// the domain verification token and other internals, and this route answers
// to every VIEWER: spreading the row handed each of them the key that signs
// any end user's identity. The secret must not even leave the database layer.
const PROJECT_RESPONSE_SELECT = {
  id: true,
  name: true,
  description: true,
  userId: true,
  projectStatus: true,
  deployedAt: true,
  environment: true,
  apiUrlDev: true,
  apiUrlStaging: true,
  apiUrlProd: true,
  apiRequests: true,
  avgLatency: true,
  errorCount: true,
  storageUsed: true,
  maxFileSize: true,
  maxFilesPerBucket: true,
  activeUsers: true,
  lastMetricsUpdate: true,
  createdAt: true,
  updatedAt: true,
  pausedAt: true,
  _count: { select: { tables: true, workspaces: true } },
} as const

type ProjectResponseRow = {
  storageUsed: bigint
  maxFileSize: bigint
  apiRequests: number
  avgLatency: number
  errorCount: number
  activeUsers: number
  lastMetricsUpdate: Date | null
  _count: { tables: number; workspaces: number }
} & Record<string, unknown>

async function serializeProject(project: ProjectResponseRow, projectId: string) {
  const { _count, ...fields } = project
  return {
    ...fields,
    storageUsed: Number(project.storageUsed),
    // The plan's effective cap, not the unused Project.storageLimit column.
    storageLimit: Number((await getProjectQuota(projectId)).limit),
    maxFileSize: Number(project.maxFileSize),
    metrics: {
      totalFunctions: 0, // Functions feature removed
      totalTables: _count.tables,
      totalWorkspaces: _count.workspaces,
      apiRequests: project.apiRequests,
      avgLatency: project.avgLatency,
      errorCount: project.errorCount,
      storageUsed: Number(project.storageUsed),
      activeUsers: project.activeUsers,
      lastMetricsUpdate: project.lastMetricsUpdate,
    },
  }
}

// GET /api/projects/[id] - Get a single project
export const GET = withAuth(async (
  request: NextRequest,
  { user }
) => {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/')
  const projectId = pathParts[pathParts.length - 1]

  try {
    // Authorize first, then fetch. The fetch below deliberately carries no
    // userId predicate: re-adding one would restore owner-only access after the
    // organization-aware check has already granted it, which is the exact
    // defect this migration exists to remove.
    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json(
        {
          success: false,
          error: 'Project not found or access denied',
        },
        { status: 404 }
      )
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: PROJECT_RESPONSE_SELECT,
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

    return NextResponse.json({
      success: true,
      data: await serializeProject(project, projectId),
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
    if (!(await canWriteProject(user.userId, projectId))) {
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

    const project = await prisma.project.update({
      where: { id: projectId },
      data: updateData,
      select: PROJECT_RESPONSE_SELECT,
    })

    return NextResponse.json({
      success: true,
      data: await serializeProject(project, projectId),
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
    // ADMIN, and the single most consequential widening in this migration:
    // deleting a project was owner-only and is now reachable by an organization
    // ADMIN or OWNER. It is irreversible and takes the workspace schemas,
    // backups and storage objects with it, so it is held a full rank above an
    // ordinary write and a DEVELOPER cannot reach it. Covered by a dedicated
    // role matrix in __tests__/auth/project-delete-authorization.test.ts.
    //
    // The 404 is kept for a denial as well as a miss, so refusing to delete
    // does not confirm to a stranger that the project exists.
    if (!(await canAdministerProject(user.userId, projectId))) {
      return NextResponse.json(
        {
          success: false,
          error: 'Project not found or access denied',
        },
        { status: 404 }
      )
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
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

