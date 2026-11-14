import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'
import { runnerRefusal } from '@/lib/services/ai-functions/reply'
import { canWriteProject } from '@/lib/edition/guard'

/**
 * POST /api/projects/[id]/ai-functions/[functionId]/run
 * Manually trigger an AI function (test run from dashboard)
 * Body: { event?: Record<string, any> }  — optional test event payload
 */
export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string; functionId: string }> }
) {
  const params = await props.params;
  try {
    const auth = await authenticateRequest(request)
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!(await canWriteProject(auth.userId, params.id))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const fn = await prisma.aiFunction.findFirst({
      where: { id: params.functionId, projectId: params.id },
    })
    if (!fn) return NextResponse.json({ error: 'Function not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const testEvent = body.event || {}

    // No status write here. The old pre-run `status: 'active'` flip silently
    // re-enabled functions the owner had switched OFF — clicking Test run on
    // a disabled function turned it back on for every public surface before
    // a single line executed. The executor owns status: it refuses
    // deliberately disabled functions, and a successful run already clears
    // 'error' on its own.

    // testRun: the caller may change the project, so the runner treats the run
    // as the project's admin (without handing the function a key or a token).
    // Auth-gated endpoints exercise their real logic instead of dead-ending in
    // 401/403 on every dashboard test.
    const result = await executeAiFunction(params.functionId, params.id, {
      type: 'manual',
      data: testEvent,
    }, {
      testRun: true,
      serviceRole: true,
    })

    // Turned away by the function runner: the same 503 and code as every
    // other route a function is called by, with the result kept for the
    // dashboard to show.
    const refusal = runnerRefusal(result)
    if (refusal) {
      const response = NextResponse.json(
        { error: refusal.error, code: refusal.code, ...(refusal.retryAfter ? { retryAfter: refusal.retryAfter } : {}), result },
        { status: refusal.status },
      )
      if (refusal.retryAfter) response.headers.set('Retry-After', String(refusal.retryAfter))
      return response
    }

    return NextResponse.json({ result })
  } catch (error: any) {
    console.error('[AI Functions] run error:', error)
    return NextResponse.json({ error: 'Failed to run function' }, { status: 500 })
  }
}
