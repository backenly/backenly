/**
 * Autonomy Events Feed
 * ====================
 *
 * GET /api/projects/[id]/autonomy/events?since=ISO
 *
 * Returns autonomous-fix events for this project since `since` (default: last
 * 60 seconds). Powers two surfaces:
 *
 *   • In-flow toasts ("Backenly added an index on created_at — your list API
 *     will sort by it") that pop up while a user is actively working in
 *     /database, /api-builder, /auth, etc.
 *   • The "while you were away" banner (same endpoint, longer window).
 *
 * Every row is rendered server-side through the single canonical "what because
 * why" copy module so every surface speaks the same words.
 *
 * Read-only. No mutation. No counter increments.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { AUTONOMOUS_AUDIT_ACTIONS } from '@/lib/autonomy/circuit-breaker'
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'

const MAX_LIMIT = 50

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)

    // `since` is the client's "I last saw events up to here" cursor. If absent,
    // default to a short trailing window so first-load polls cannot dump a
    // year's worth of audit history into a notification corner.
    const sinceParam = url.searchParams.get('since')
    let since: Date
    if (sinceParam) {
      const parsed = new Date(sinceParam)
      since = isNaN(+parsed) ? new Date(Date.now() - 60_000) : parsed
    } else {
      since = new Date(Date.now() - 60_000)
    }

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get('limit')) || 20),
    )

    const rows = await prisma.auditLog.findMany({
      where: {
        projectId: validated.projectId,
        timestamp: { gt: since },
        action: { in: AUTONOMOUS_AUDIT_ACTIONS as unknown as string[] },
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
      select: { id: true, action: true, timestamp: true, details: true },
    })

    const events = rows.map(r => {
      let d: Record<string, any> = {}
      try {
        d = r.details ? JSON.parse(r.details) : {}
      } catch { /* legacy free-text */ }
      const explained = explainAutonomyEvent(d)
      return {
        id: r.id,
        action: r.action,
        at: r.timestamp.toISOString(),
        what: explained.what,
        why: explained.why,
        full: explained.full,
        kind: explained.kind,
        // Source data — useful for downstream filters in the UI (e.g. "show
        // only the database section's events" by inspecting tableName).
        tableName: d.tableName ?? d.table ?? null,
      }
    })

    // The next-cursor is the newest row's timestamp the client just saw.
    // Returning `null` keeps the client's existing cursor unchanged.
    const nextCursor = events.length > 0 ? events[0].at : null

    return NextResponse.json({
      projectId: validated.projectId,
      since: since.toISOString(),
      nextCursor,
      events,
    })
  })
}
