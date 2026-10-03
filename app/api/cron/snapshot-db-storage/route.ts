/**
 * POST /api/cron/snapshot-db-storage
 *
 * Periodically measures actual PostgreSQL bytes for every project a
 * maintenance pass covers, and writes the result into
 * ProjectUsage.dbStorageUsedMb for the current month. WHICH projects those are
 * is an edition question answered by FleetScheduler, not by this route. That
 * field powers:
 *   - the storage gate in lib/quota/kernel.enforceDbStorage
 *   - the "PostgreSQL" meter shown on /app/settings (billing)
 *
 * Without this cron, dbStorageUsedMb only refreshes as a side-effect of AI
 * schema mutations, so end-user row inserts via the SDK never update the
 * displayed value. Scheduled hourly in vercel.json.
 *
 * Security: requires CRON_SECRET header.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { snapshotScheduledDbStorage } from '@/lib/usage/db-storage'

function verifyCronAuth(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

async function run(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  try {
    await snapshotScheduledDbStorage()
    return NextResponse.json({
      success: true,
      durationMs: Date.now() - startedAt,
    })
  } catch (error: any) {
    console.error('[Cron snapshot-db-storage] Failed:', error)
    return NextResponse.json(
      { success: false, error: error?.message ?? 'snapshot failed' },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  return run(request)
}

export async function POST(request: NextRequest) {
  return run(request)
}
