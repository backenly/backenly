import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
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

    await verifyToken(token)
    const projectId = params.id

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
