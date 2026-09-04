export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/auth/session'
import { prisma } from '@/lib/db'
import { canWriteProject } from '@/lib/edition/guard'

/**
 * POST /api/projects/[id]/sdk-test
 * Test SDK connection - verifies project exists and user has access
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const projectId = params.id

    // Verify project exists and user has access
    if (!(await canWriteProject(session.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Connection test successful
    return NextResponse.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
      },
      message: 'SDK connection verified',
    })
  } catch (error: any) {
    console.error('[SDK Test] Error:', error)
    return NextResponse.json(
      { error: 'Connection test failed' },
      { status: 500 }
    )
  }
}
