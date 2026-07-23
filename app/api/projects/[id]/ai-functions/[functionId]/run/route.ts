import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

/**
 * POST /api/projects/[id]/ai-functions/[functionId]/run
 * Manually trigger an AI function (test run from dashboard)
 * Body: { event?: Record<string, any> }  — optional test event payload
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; functionId: string } }
) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const project = await prisma.project.findFirst({
      where: { id: params.id, userId: auth.userId },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const fn = await prisma.aiFunction.findFirst({
      where: { id: params.functionId, projectId: params.id },
    })
    if (!fn) return NextResponse.json({ error: 'Function not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const testEvent = body.event || {}

    // Re-activate for manual run even if in error state
    await prisma.aiFunction.update({
      where: { id: params.functionId },
      data: { status: 'active' },
    })

    // testRun: the caller is the authenticated project OWNER, so the runner
    // injects the project's admin key + a short-lived project-scoped admin
    // token. Auth-gated endpoints exercise their real logic instead of
    // dead-ending in 401/403 on every dashboard test.
    const result = await executeAiFunction(params.functionId, params.id, {
      type: 'manual',
      data: testEvent,
    }, {
      testRun: true,
      serviceRole: true,
    })

    return NextResponse.json({ result })
  } catch (error: any) {
    console.error('[AI Functions] run error:', error)
    return NextResponse.json({ error: 'Failed to run function' }, { status: 500 })
  }
}
