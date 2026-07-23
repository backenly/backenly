/**
 * Metrics API Endpoint
 * 
 * Provides runtime metrics for monitoring systems:
 * - Mutation counts (total, success, failure, refusal)
 * - Latency statistics (average, p95)
 * - Error rates
 * - Refusal reasons breakdown
 * 
 * Protected: Should require admin/auth in production
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMetrics } from '@/lib/observability'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // TODO: Add authentication check for production
  // const authHeader = request.headers.get('authorization')
  // if (!isAuthorized(authHeader)) {
  //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // }
  
  try {
    const metrics = getMetrics()
    
    return NextResponse.json({
      timestamp: new Date().toISOString(),
      ...metrics,
    }, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Type': 'application/json',
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to retrieve metrics',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { 
        status: 500,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    )
  }
}
