export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/account/autonomy-activity
 *
 * Account-wide autonomy activity for the current billing cycle (calendar month),
 * powering the Usage page "Autonomy runs" card + per-day chart (§5.2).
 *
 * Source of truth: AuditLog rows tagged `type: 'autonomy'` — the reconciler
 * writes one per tick (AUTONOMY_LIVE_RUN / AUTONOMY_SHADOW_DECISION / freeze /
 * escalation). We count real ticks across every project the user owns. No new
 * table, no synthetic data — if the loop hasn't run, the count is honestly 0.
 */
export const GET = withAuth(async (_request: NextRequest, { user }) => {
  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    // Projects owned by this account.
    const projects = await prisma.project.findMany({
      where: { userId: user.userId },
      select: { id: true },
    })
    const projectIds = projects.map((p) => p.id)

    if (projectIds.length === 0) {
      return NextResponse.json({ runsThisCycle: 0, perDay: buildEmptyDays(monthStart, now), cycleStart: monthStart.toISOString() })
    }

    // Autonomy ticks this cycle. Volume is small (cadence-gated), so we read the
    // timestamps and bucket in JS rather than reaching for raw date_trunc SQL.
    const rows = await prisma.auditLog.findMany({
      where: {
        projectId: { in: projectIds },
        type: 'autonomy',
        timestamp: { gte: monthStart },
      },
      select: { timestamp: true },
      take: 10_000,
    })

    const byDay = new Map<string, number>()
    for (const r of rows) {
      const key = r.timestamp.toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
      byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }

    const perDay = buildEmptyDays(monthStart, now).map((d) => ({
      date: d.date,
      count: byDay.get(d.date) ?? 0,
    }))

    return NextResponse.json({
      runsThisCycle: rows.length,
      perDay,
      cycleStart: monthStart.toISOString(),
    })
  } catch (error: any) {
    console.error('[Autonomy Activity]', error)
    return NextResponse.json({ error: error.message || 'Failed to load autonomy activity' }, { status: 500 })
  }
})

function buildEmptyDays(start: Date, end: Date): { date: string; count: number }[] {
  const days: { date: string; count: number }[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    days.push({ date: cursor.toISOString().slice(0, 10), count: 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}
