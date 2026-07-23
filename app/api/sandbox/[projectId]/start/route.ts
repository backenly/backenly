export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { startSandbox } from '@/lib/sandbox-runtime'

/**
 * POST /api/sandbox/[projectId]/start
 * 
 * Start sandbox runtime for project
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    // Authenticate user session
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Unauthorized - Please log in' },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.projectId

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: userId,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      )
    }

    // Start sandbox
    const port = await startSandbox(projectId)

    return NextResponse.json({
      success: true,
      message: 'Sandbox runtime started',
      port,
      projectId,
    })
  } catch (error: any) {
    console.error('Sandbox start error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to start sandbox',
      },
      { status: 500 }
    )
  }
}
