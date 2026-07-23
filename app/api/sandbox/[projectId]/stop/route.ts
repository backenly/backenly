export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { stopSandbox } from '@/lib/sandbox-runtime'

/**
 * POST /api/sandbox/[projectId]/stop
 * 
 * Stop sandbox runtime for project
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

    // Stop sandbox
    const stopped = await stopSandbox(projectId)

    return NextResponse.json({
      success: stopped,
      message: stopped ? 'Sandbox runtime stopped' : 'Sandbox was not running',
      projectId,
    })
  } catch (error: any) {
    console.error('Sandbox stop error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to stop sandbox',
      },
      { status: 500 }
    )
  }
}
