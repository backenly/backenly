/**
 * Serverless Warmup Cron Job
 * 
 * PROBLEM: Cold starts add latency to first request
 * SOLUTION: Periodic low-cost pings to keep functions warm
 * 
 * SCHEDULE: Every 5 minutes during active hours (8am-10pm UTC)
 * COST: ~$0.01/month (minimal invocations, fast execution)
 * 
 * PHILOSOPHY: Invisible optimization (users never experience cold starts)
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  warmupActiveProjects,
  clearExpiredCache,
  getWarmupStats,
} from '@/lib/services/serverless-warmup'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // 1 minute max

function verifyCronAuth(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return POST(request)
}

export async function POST(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    console.error('[Serverless Warmup] Unauthorized cron request')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {

    console.log('[Serverless Warmup] Starting warmup cycle...')

    const startTime = Date.now()

    // Step 1: Warmup active projects
    const warmupResult = await warmupActiveProjects()

    // Step 2: Clear expired cache entries
    const cleanupResult = clearExpiredCache()

    // Step 3: Get current statistics
    const stats = getWarmupStats()

    const duration = Date.now() - startTime

    console.log(
      `[Serverless Warmup] Complete in ${duration}ms: ` +
        `${warmupResult.warmedProjects} projects, ` +
        `${warmupResult.warmedApis} APIs, ` +
        `${warmupResult.cacheHits} cache hits`
    )

    return NextResponse.json({
      success: true,
      duration,
      warmup: {
        projects: warmupResult.warmedProjects,
        apis: warmupResult.warmedApis,
        cacheHits: warmupResult.cacheHits,
      },
      cleanup: {
        clearedPlans: cleanupResult.clearedPlans,
        clearedSchemas: cleanupResult.clearedSchemas,
      },
      stats: {
        cachedPlans: stats.executionPlans,
        cachedSchemas: stats.schemas,
        totalHits: stats.totalHits,
        avgHitsPerPlan: stats.avgHitsPerPlan,
      },
      message: `Warmed ${warmupResult.warmedProjects} projects with ${warmupResult.warmedApis} APIs`,
    })
  } catch (error: any) {
    console.error('[Serverless Warmup] Failed:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Warmup failed',
      },
      { status: 500 }
    )
  }
}
