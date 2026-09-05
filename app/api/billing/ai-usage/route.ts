export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getTodayAiUsage } from '@/lib/billing'
import { checkAiIntentLimit } from '@/lib/entitlements/policy'

/**
 * GET /api/billing/ai-usage - Get AI usage for today
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const [usage, limitStatus] = await Promise.all([
      getTodayAiUsage(user.userId),
      checkAiIntentLimit(user.userId)
    ])

    return NextResponse.json({
      usedToday: usage.count,
      tokensUsed: usage.tokens,
      limit: limitStatus.limit,
      remaining: limitStatus.remaining,
      resetAt: limitStatus.resetAt.toISOString(),
      allowed: limitStatus.allowed
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to get AI usage' },
      { status: 500 }
    )
  }
})
