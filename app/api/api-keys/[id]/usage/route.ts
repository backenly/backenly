export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { getApiKeyUsageStats } from '@/lib/services/apiKeyUsage'
import { prisma } from '@/lib/db/postgres'

/**
 * Get usage statistics for an API key
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth(request)

    // Verify the API key belongs to the user
    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
      },
    })

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const startDate = searchParams.get('startDate')
      ? new Date(searchParams.get('startDate')!)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Default: last 7 days
    const endDate = searchParams.get('endDate')
      ? new Date(searchParams.get('endDate')!)
      : new Date()

    const stats = await getApiKeyUsageStats(params.id, startDate, endDate)

    // Get current rate limit status
    const now = new Date()
    const resetAt = apiKey.resetAt || new Date(now.getTime() + apiKey.rateLimitWindow * 1000)
    const isReset = resetAt < now
    const currentCount = isReset ? 0 : apiKey.requestCount

    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        rateLimit: apiKey.rateLimit,
        rateLimitWindow: apiKey.rateLimitWindow,
        currentCount,
        resetAt,
      },
      usage: stats,
      period: {
        startDate,
        endDate,
      },
    })
  } catch (error) {
    console.error('Get API key usage error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch usage statistics' },
      { status: 500 }
    )
  }
}
