import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { canAccessProject } from '@/lib/edition/guard'
import { getProjectMonthlyCost, getRecentUsage, estimateCost } from '@/lib/ai/cost-tracker'

/**
 * GET /api/projects/[id]/ai-cost
 * Returns LLM usage and cost for the current month.
 * Used by the billing dashboard to show real AI spend.
 *
 * Query params:
 *   ?recent=true  — also include last 20 individual calls
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
      || request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

    const { searchParams } = new URL(request.url)
    const includeRecent = searchParams.get('recent') === 'true'

    const [monthlyCost, recentUsage] = await Promise.all([
      getProjectMonthlyCost(projectId),
      includeRecent ? getRecentUsage(projectId, 20) : Promise.resolve([]),
    ])

    return NextResponse.json({
      success: true,
      ...monthlyCost,
      recentCalls: recentUsage,
    })
  } catch (error: any) {
    console.error('[AI Cost API] Error:', error)
    return NextResponse.json({ error: 'Failed to get cost data' }, { status: 500 })
  }
}
