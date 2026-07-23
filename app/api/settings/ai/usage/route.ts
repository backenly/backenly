export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAiUsageStats } from '@/lib/services/aiConfig'
import { authenticateRequest } from '@/lib/auth/middleware'

// GET /api/settings/ai/usage - Get AI usage statistics
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const searchParams = request.nextUrl.searchParams
    const projectId = searchParams.get('projectId')
    const period = (searchParams.get('period') || 'month') as 'month' | 'all'

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }

    const stats = await getAiUsageStats(projectId, period)

    // Convert BigInt to string for JSON serialization
    return NextResponse.json({
      totalCalls: stats.totalCalls,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
      byModel: stats.byModel,
      usage: stats.usage.map(u => ({
        id: u.id,
        model: u.model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        totalTokens: u.totalTokens,
        cost: u.cost,
        endpoint: u.endpoint,
        metadata: u.metadata,
        createdAt: u.createdAt.toISOString(),
      })),
    })
  } catch (error: any) {
    console.error('Failed to get AI usage stats:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get AI usage stats' },
      { status: 500 }
    )
  }
}

