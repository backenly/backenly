export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runDailyGraceCheck } from '@/lib/billing/grace'

/**
 * GET /api/cron/grace-check
 * Daily cron job to process expired grace periods
 * 
 * This endpoint should be called by a scheduler (e.g., Vercel Cron, GitHub Actions)
 * Requires CRON_SECRET for authorization
 */
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization')
    const expectedSecret = process.env.CRON_SECRET

    if (!expectedSecret) {
      return NextResponse.json(
        { error: 'CRON_SECRET not configured' },
        { status: 500 }
      )
    }

    if (authHeader !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Run grace check
    const result = await runDailyGraceCheck()

    return NextResponse.json({
      success: true,
      processed: result.processed,
      errors: result.errors,
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    console.error('[Cron Grace Check] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Cron job failed' },
      { status: 500 }
    )
  }
}
