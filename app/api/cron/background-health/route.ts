/**
 * POST /api/cron/background-health — autonomous 15-minute health scan
 *
 * Targets ALL active projects (have at least one table, updated in last 30 days).
 * For each project runs the multi-agent monitor (security + performance + migration + repair),
 * then falls back to the legacy background-agent scan for any project that errors.
 *
 * Scheduled via:
 *   - node-cron in instrumentation.ts (self-hosted / Hetzner)
 *   - Manual trigger via CRON_SECRET for testing
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { runMonitoredHealthScan } from '@/lib/ai/background-monitor'
import { getFleetScheduler } from '@/lib/edition'

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()

  // Active projects: have at least one table and showed a sign of life in the
  // last 7 days. The RULE is still lib/autonomy/activity-gate.ts and is shared
  // with the in-process cron tick; the edition decides only the SET it runs
  // over, so a self-hosted deployment scans its own project rather than every
  // row that happens to be in its database.
  const targets = await getFleetScheduler().activeTargets({ windowDays: 7 })
  // Names are for the log lines only. See the comment in archive-cleanup for
  // why they are read back by id rather than carried by the seam.
  const names = new Map(
    (
      await prisma.project
        .findMany({ where: { id: { in: targets.map(t => t.id) } }, select: { id: true, name: true } })
        .catch(() => [])
    ).map(p => [p.id, p.name] as const),
  )
  const activeProjects = targets.map(t => ({ ...t, name: names.get(t.id) ?? t.id }))

  console.log(`[BackgroundHealth] Scanning ${activeProjects.length} active projects`)

  let scanned = 0
  let errors = 0

  // Process in batches of 10 to avoid DB overload
  const batches = chunk(activeProjects, 10)
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(p => runMonitoredHealthScan(p.id, p.userId ?? ''))
    )
    for (const outcome of results) {
      if (outcome.status === 'fulfilled') {
        scanned++
      } else {
        errors++
        console.warn('[BackgroundHealth] Scan error:', outcome.reason?.message ?? outcome.reason)
      }
    }
  }

  const durationMs = Date.now() - startedAt
  console.log(`[BackgroundHealth] Done — ${scanned} scanned, ${errors} errors, ${durationMs}ms`)

  return NextResponse.json({
    ok: true,
    scanned,
    errors,
    durationMs,
  })
}

// Support GET for direct browser/curl testing
export async function GET(request: NextRequest) {
  return POST(request)
}
