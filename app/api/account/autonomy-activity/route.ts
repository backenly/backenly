export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { accountForCaller } from '@/lib/entitlements'
import { accountProjectsWhere } from '@/lib/usage/account'

/**
 * GET /api/account/autonomy-activity?orgId=
 *
 * How many self-healing checks ran this billing cycle (the calendar month, in
 * UTC) across every project of a billing account, per day, and when the last
 * one ran. The account is the caller's own, or (on Cloud) the organization
 * named by ?orgId=, which must be one the caller belongs to. The Usage page
 * shows it as one row: checks this cycle, the last check, never metered.
 *
 *   { runsThisCycle, perDay: [{ date: 'YYYY-MM-DD', count }], cycleStart, lastAt }
 *
 * A check is an AUTONOMY_TICK audit row: the reconciler writes exactly one at
 * the top of every pass over a project (lib/autonomy/reconciler.ts), before any
 * per-mode work, so it counts passes and nothing else. The other autonomy rows
 * (live runs, shadow decisions, freezes) are outcomes of a pass, and counting
 * them too would count some passes twice.
 *
 * Counted in the database. This used to read up to 10,000 rows, unordered, and
 * report how many it got: every watched project writes about 1,440 ticks a day,
 * so one project reached the cap in about a week and the total then stuck at
 * 10,000 while the per-day split showed whichever rows came back. One grouped
 * count is bounded to the cycle (audit_logs has single-column indexes on
 * projectId and timestamp, no composite one) and returns at most one row per
 * day however many checks ran.
 *
 * `lastAt` is the newest check this cycle, or null when none has run since the
 * cycle began; nothing older is looked up, for the same index reason.
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const account = await accountForCaller(user.userId, request.nextUrl?.searchParams.get('orgId'))
    if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const now = new Date()
    const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const nextCycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

    const projects = await prisma.project.findMany({
      where: accountProjectsWhere(account),
      select: { id: true },
    })
    const projectIds = projects.map((p) => p.id)

    const counts = projectIds.length ? await countChecksByDay(projectIds, cycleStart, nextCycleStart) : []
    const byDay = new Map(counts.map((row) => [row.day, Number(row.count)]))
    const perDay = buildEmptyDays(cycleStart, now).map((d) => ({ date: d.date, count: byDay.get(d.date) ?? 0 }))
    const lastAt = counts.reduce<Date | null>((latest, row) => {
      const at = row.lastAt ? new Date(row.lastAt) : null
      return at && (!latest || at > latest) ? at : latest
    }, null)

    return NextResponse.json({
      runsThisCycle: counts.reduce((sum, row) => sum + Number(row.count), 0),
      perDay,
      cycleStart: cycleStart.toISOString(),
      lastAt: lastAt ? lastAt.toISOString() : null,
    })
  } catch (error: any) {
    console.error('[Autonomy Activity]', error)
    return NextResponse.json({ error: error.message || 'Failed to load autonomy activity' }, { status: 500 })
  }
})

interface DayCount {
  /** YYYY-MM-DD, in UTC. */
  day: string
  count: number | bigint
  /** The day's newest check, as an ISO instant in UTC. */
  lastAt: string | null
}

/**
 * Checks per UTC day in [from, to), with the newest check of each day.
 *
 * audit_logs.timestamp is `timestamp without time zone` holding UTC (Prisma's
 * convention), so the bounds are converted to UTC explicitly rather than by
 * the session's zone, and the day and the instant are formatted in the query,
 * as lib/usage/alerts.ts does, so no driver has to guess a zone either.
 */
function countChecksByDay(projectIds: string[], from: Date, to: Date): Promise<DayCount[]> {
  return prisma.$queryRaw<DayCount[]>`
    SELECT to_char("timestamp", 'YYYY-MM-DD') AS "day",
           COUNT(*)::int AS "count",
           to_char(MAX("timestamp"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastAt"
      FROM "audit_logs"
     WHERE "projectId" = ANY(${projectIds}::text[])
       AND "action" = 'AUTONOMY_TICK'
       AND "timestamp" >= (${from}::timestamptz AT TIME ZONE 'UTC')
       AND "timestamp" < (${to}::timestamptz AT TIME ZONE 'UTC')
     GROUP BY 1
     ORDER BY 1`
}

function buildEmptyDays(start: Date, end: Date): { date: string; count: number }[] {
  const days: { date: string; count: number }[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    days.push({ date: cursor.toISOString().slice(0, 10), count: 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}
