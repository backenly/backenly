import { NextRequest, NextResponse } from 'next/server'
import { cleanupAllProjectGraphs } from '@/lib/orchestration/graph-cleanup'

/**
 * POST /api/cron/cleanup-graphs
 * 
 * Automated graph retention cleanup
 * Should be called by Vercel Cron or external scheduler
 * 
 * Security: Verify cron secret to prevent unauthorized access
 */
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    console.log('[Cron] Starting graph cleanup...')

    const stats = await cleanupAllProjectGraphs()

    return NextResponse.json({
      success: true,
      ...stats,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('[Cron] Graph cleanup failed:', error)

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Cleanup failed',
      },
      { status: 500 }
    )
  }
}
