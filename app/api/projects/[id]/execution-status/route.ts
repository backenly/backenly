export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[projectId]/execution-status
 * 
 * Fallback polling endpoint for SSE failures
 * Used when Server-Sent Events fail on serverless infrastructure
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Authenticate
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'AUTH_REQUIRED' },
        { status: 401 }
      )
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Verify project ownership
    if (!(await canAccessProject(userId, projectId))) {
      return NextResponse.json(
        { error: 'Project not found', code: 'PROJECT_NOT_FOUND' },
        { status: 404 }
      )
    }

    // Get latest execution from audit logs
    const latestExecution = await prisma.auditLog.findFirst({
      where: {
        projectId,
        type: 'ai_execution',
        action: 'BACKEND_GENERATION',
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 1,
    })

    if (!latestExecution) {
      return NextResponse.json({
        status: 'idle',
        message: 'No recent executions',
      })
    }

    // Check if execution is recent (within last 30 seconds)
    const executionAge = Date.now() - latestExecution.timestamp.getTime()
    const isRecent = executionAge < 30000

    // Extract structured artifacts from metadata if available
    const metadata = latestExecution.metadata as any
    const structuredArtifacts = metadata?.structuredArtifacts || {
      plan: [],
      entities: [],
      apis: [],
      auth: [],
      storage: [],
      integrations: []
    }

    return NextResponse.json({
      status: isRecent ? 'complete' : 'idle',
      message: latestExecution.details,
      timestamp: latestExecution.timestamp,
      executionAge: Math.floor(executionAge / 1000) + 's ago',
      structuredArtifacts,
      changes: metadata?.changes || [],
      timeline: metadata?.timeline,
    })

  } catch (error: any) {
    console.error('[Execution Status] Error:', error)
    
    return NextResponse.json(
      {
        error: 'Failed to get execution status',
        code: 'EXECUTION_STATUS_ERROR',
        message: error.message,
      },
      { status: 500 }
    )
  }
}
