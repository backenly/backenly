import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { getProjectMonthlyCost, getRecentUsage, estimateCost } from '@/lib/ai/cost-tracker'

/**
 * GET /api/projects/[id]/ai-cost
 * Returns LLM usage and cost for the current month.
 * Used by the billing dashboard to show real AI spend.
 *
 * Query params:
 *   ?recent=true  — also include last 20 individual calls
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const token = request.cookies.get('auth-token')?.value
      || request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await verifyToken(token)

    const projectId = params.id
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
