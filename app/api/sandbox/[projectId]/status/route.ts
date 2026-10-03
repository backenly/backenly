export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { getSandboxStatus } from '@/lib/sandbox-runtime'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/sandbox/[projectId]/status
 * 
 * Get sandbox runtime status for project
 */
export async function GET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
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
    if (!(await canAccessProject(userId, projectId))) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      )
    }

    // Get sandbox status
    const status = getSandboxStatus(projectId)

    return NextResponse.json({
      success: true,
      ...status,
    })
  } catch (error: any) {
    console.error('Sandbox status error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to get sandbox status',
      },
      { status: 500 }
    )
  }
}
