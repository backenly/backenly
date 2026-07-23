/**
 * Health Check API Endpoint
 * 
 * Provides runtime health status for:
 * - Load balancer health checks
 * - Monitoring systems
 * - Deployment verification
 * 
 * Returns 200 if healthy, 503 if unhealthy
 */

import { NextRequest, NextResponse } from 'next/server'
import { runHealthCheck } from '@/lib/db/startup-validation'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const health = await runHealthCheck()

    const statusCode = health.healthy ? 200 : 503
    
    return NextResponse.json(health, { 
      status: statusCode,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        healthy: false,
        checks: {},
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { 
        status: 503,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    )
  }
}
