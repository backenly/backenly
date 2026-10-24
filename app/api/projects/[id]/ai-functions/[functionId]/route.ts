import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canAdministerProject, canWriteProject } from '@/lib/edition/guard'
import { governedChange } from '@/lib/changes/ledger'

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

    if (!(await canWriteProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const body = await request.json()
    const { status } = body

    if (!['active', 'inactive'].includes(status)) {
      return NextResponse.json({ error: 'status must be active or inactive' }, { status: 400 })
    }

    const existing = await prisma.aiFunction.findFirst({
      where: { id: params.functionId, projectId: params.id },
      select: { triggerType: true, name: true },
    })
    if (!existing) return NextResponse.json({ error: 'Function not found' }, { status: 404 })

    await governedChange(params.id, `Turn ${status === 'active' ? 'on' : 'off'} function ${existing.name}`, () => prisma.aiFunction.update({
      where: { id: params.functionId },
      data: { status },
    }), { actorUserId: auth.userId })

    // A row-event function going on or off changes what the database-level
    // capture must record.
    const { syncCaptureForFunctionChange } = await import('@/lib/webhooks/capture')
    await syncCaptureForFunctionChange(params.id, existing.triggerType)

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

    if (!(await canAdministerProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const existing = await prisma.aiFunction.findFirst({
      where: { id: params.functionId, projectId: params.id },
      select: { triggerType: true, name: true },
    })

    // Comes back, code and all, by restoring it (lib/changes/resources/functions.ts).
    await governedChange(params.id, `Delete function ${existing?.name ?? params.functionId}`, () => prisma.aiFunction.deleteMany({
      where: { id: params.functionId, projectId: params.id },
    }), { actorUserId: auth.userId })

    if (existing) {
      const { syncCaptureForFunctionChange } = await import('@/lib/webhooks/capture')
      await syncCaptureForFunctionChange(params.id, existing.triggerType)
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('[AI Functions] DELETE error:', error)
    return NextResponse.json({ error: 'Failed to delete function' }, { status: 500 })
  }
}
