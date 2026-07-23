export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { getUserApiKeyUsageStats } from '@/lib/services/apiKeyUsage'

/**
 * Get usage statistics for all API keys of the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request)
    
    const stats = await getUserApiKeyUsageStats(auth.userId)
    
    return NextResponse.json({ stats })
  } catch (error) {
    console.error('Get user API key usage error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch usage statistics' },
      { status: 500 }
    )
  }
}

