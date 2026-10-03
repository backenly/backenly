import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { canAccessProject } from '@/lib/edition/guard'
import { loadArchitecturalMemory } from '@/lib/architecture-memory'

/**
 * GET /api/projects/[id]/architecture-memory
 * Retrieve architectural memory for testing and debugging
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const sessionToken = request.cookies.get('auth-token')?.value
    const authHeader = request.headers.get('authorization')
    const token = sessionToken || authHeader?.replace('Bearer ', '')

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const decoded = await verifyToken(token)
    const callerId = decoded.userId
    const projectId = params.id

    // Ownership. verifyToken answers "who is this"; it does not answer "may
    // they read this project". The result was not even captured here, so the
    // project id from the path went straight through unchecked.
    // 404 rather than 403 so the endpoint is not an oracle for project ids.
    if (!(await canAccessProject(callerId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }


    const memory = await loadArchitecturalMemory(projectId)

    return NextResponse.json({
      success: true,
      memory,
    })
  } catch (error: any) {
    console.error('[Architecture Memory API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve memory' },
      { status: 500 }
    )
  }
}
