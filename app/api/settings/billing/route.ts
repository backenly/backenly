export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getBillingUsage } from '@/lib/services/billing'
import { authenticateRequest } from '@/lib/auth/middleware'

// GET /api/settings/billing - Get billing usage data
export async function GET(request: NextRequest) {
  console.log('🔄 [API/Billing] Request received')
  
  try {
    const auth = await authenticateRequest(request)
    console.log('🔒 [API/Billing] Auth result:', { authenticated: auth.authenticated, userId: auth.userId })
    
    if (!auth.authenticated || !auth.userId) {
      console.error('❌ [API/Billing] Unauthorized access attempt')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const searchParams = request.nextUrl.searchParams
    const projectId = searchParams.get('projectId')
    console.log('📝 [API/Billing] ProjectId from query:', projectId)

    if (!projectId) {
      console.error('❌ [API/Billing] Missing projectId parameter')
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }

    console.log('🔄 [API/Billing] Fetching usage for project:', projectId)
    const usage = await getBillingUsage(projectId)
    console.log('✅ [API/Billing] Usage fetched successfully:', {
      apiRequests: usage.apiRequests.count,
      aiCalls: usage.aiCalls.count,
      storageUsed: usage.storage.used.toString(),
    })

    // Convert BigInt to string for JSON serialization
    return NextResponse.json({
      apiRequests: {
        count: usage.apiRequests.count,
        changePercent: usage.apiRequests.changePercent,
      },
      storage: {
        used: usage.storage.used.toString(),
        limit: usage.storage.limit.toString(),
      },
      aiCalls: {
        count: usage.aiCalls.count,
        limit: usage.aiCalls.limit,
        cost: usage.aiCalls.cost,
      },
      monthlyEstimate: usage.monthlyEstimate,
    })
  } catch (error: any) {
    console.error('❌ [API/Billing] Failed to get billing usage:', error)
    console.error('Error stack:', error.stack)
    return NextResponse.json(
      { error: error.message || 'Failed to get billing usage' },
      { status: 500 }
    )
  }
}

