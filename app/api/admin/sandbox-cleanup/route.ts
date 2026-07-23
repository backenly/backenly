export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/sandbox-cleanup
 *
 * Trigger expired sandbox cleanup via HTTP.
 * Protected by CRON_SECRET environment variable.
 *
 * Use with:
 *   - Vercel Cron Jobs (set Authorization header)
 *   - External cron services (BetterUptime, EasyCron, etc.)
 *   - Hetzner server systemd timer
 *
 * Example cron (every hour):
 *   curl -X POST https://backenly.com/api/admin/sandbox-cleanup \
 *     -H "Authorization: Bearer $CRON_SECRET"
 */

import { NextRequest, NextResponse } from 'next/server'
import { cleanupExpiredSandboxes } from '@/lib/billing/sandbox'

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.error('[SandboxCleanup] CRON_SECRET not configured')
    return NextResponse.json({ error: 'Cron not configured' }, { status: 500 })
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const start = Date.now()
    const result = await cleanupExpiredSandboxes()
    const durationMs = Date.now() - start

    console.log(`[SandboxCleanup] Done: deleted=${result.deleted} errors=${result.errors.length} duration=${durationMs}ms`)

    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      errors: result.errors,
      durationMs,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('[SandboxCleanup] Fatal error:', error)
    return NextResponse.json(
      { error: 'CLEANUP_FAILED', message: error.message },
      { status: 500 }
    )
  }
}
