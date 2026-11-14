/**
 * GET /api/cron/daily-backup — daily workspace backup runner
 * Called by Vercel Cron (see vercel.json) once per day at 02:05 UTC.
 * For self-hosted/Hetzner, instrumentation.ts calls runDailyBackups() directly.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { isCronRequest } from '@/lib/security/cron-auth'
import { runDailyBackups } from '@/lib/services/workspace-backup'

export async function GET(request: NextRequest) {
  if (!isCronRequest(request, { query: true })) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runDailyBackups()
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error('[DailyBackup] Error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
