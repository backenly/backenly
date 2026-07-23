/**
 * GET /api/cron/daily-backup — daily workspace backup runner
 * Called by Vercel Cron (see vercel.json) once per day at 02:05 UTC.
 * For self-hosted/Hetzner, instrumentation.ts calls runDailyBackups() directly.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runDailyBackups } from '@/lib/services/workspace-backup'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (expectedSecret && secret !== expectedSecret) {
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
