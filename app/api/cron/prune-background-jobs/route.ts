export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/cron/prune-background-jobs
 *
 * Deletes completed/failed BackgroundJob records older than 7 days.
 * Without this, the backgroundJob.count() query used for build-lock
 * budget checking degrades at scale as the table grows unboundedly.
 *
 * Schedule: daily (e.g. 03:00 UTC)
 * Auth: CRON_SECRET header
 */

import { NextRequest, NextResponse } from 'next/server'
import { isCronRequest } from '@/lib/security/cron-auth'
import { prisma } from '@/lib/db/prisma'

export async function POST(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago

    const { count } = await prisma.backgroundJob.deleteMany({
      where: {
        status:      { in: ['completed', 'failed'] },
        completedAt: { lt: cutoff },
      },
    })

    console.log(`[prune-background-jobs] Deleted ${count} stale BackgroundJob records`)
    return NextResponse.json({ ok: true, deleted: count, cutoff: cutoff.toISOString() })
  } catch (err: any) {
    console.error('[prune-background-jobs] Error:', err?.message)
    return NextResponse.json({ error: err?.message ?? 'Pruning failed' }, { status: 500 })
  }
}
