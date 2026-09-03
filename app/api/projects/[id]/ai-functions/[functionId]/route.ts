import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * PUT /api/projects/[id]/ai-functions/[functionId]
 * Toggle active/inactive status
 * Body: { status: 'active' | 'inactive' }
 */
export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ id: string; functionId: string }> }
) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!(await canAccessProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const body = await request.json()
    const { status } = body

    if (!['active', 'inactive'].includes(status)) {
      return NextResponse.json({ error: 'status must be active or inactive' }, { status: 400 })
    }

    const fn = await prisma.aiFunction.updateMany({
      where: { id: params.functionId, projectId: params.id },
      data: { status },
    })

    if (fn.count === 0) return NextResponse.json({ error: 'Function not found' }, { status: 404 })

    return NextResponse.json({ success: true, status })
  } catch (error: any) {
    console.error('[AI Functions] PUT error:', error)
    return NextResponse.json({ error: 'Failed to update function' }, { status: 500 })
  }
}

/**
 * DELETE /api/projects/[id]/ai-functions/[functionId]
 * Delete an AI function
 */
export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ id: string; functionId: string }> }
) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!(await canAccessProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    await prisma.aiFunction.deleteMany({
      where: { id: params.functionId, projectId: params.id },
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('[AI Functions] DELETE error:', error)
    return NextResponse.json({ error: 'Failed to delete function' }, { status: 500 })
  }
}
