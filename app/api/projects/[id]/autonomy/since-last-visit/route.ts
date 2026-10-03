/**
 * Autonomy "Since Last Visit" Summary
 * ===================================
 *
 * GET /api/projects/[id]/autonomy/since-last-visit?since=ISO
 *
 * Returns the aggregated "what Backenly did while you were away" payload that
 * powers the welcome-back banner. Same source data as the events feed but
 * shaped for a one-line summary plus the few most-impactful items.
 *
 * The client owns the cursor — it stores `last_seen_at` in localStorage on
 * dismiss / focus. We just count what happened after it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { AUTONOMOUS_AUDIT_ACTIONS } from '@/lib/autonomy/circuit-breaker'
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'

const MIN_SINCE_MS = 60 * 1000 // never look further forward than 1 min ago

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)
    const sinceParam = url.searchParams.get('since')

    // Without a client cursor, default to the last 24h — the "you've been away
    // for a day" experience, not an empty banner.
    let since: Date
    if (sinceParam) {
      const parsed = new Date(sinceParam)
      since = isNaN(+parsed) ? new Date(Date.now() - 24 * 60 * 60 * 1000) : parsed
    } else {
      since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    }

    // Clamp so a stale-tab "since=now+1m" never returns negative results.
    if (since.getTime() > Date.now() - MIN_SINCE_MS) {
      since = new Date(Date.now() - MIN_SINCE_MS)
    }

    const [autonomousFixes, escalations, rollbacks, samples] = await Promise.all([
      prisma.auditLog.count({
        where: {
          projectId: validated.projectId,
          timestamp: { gt: since },
          action: { in: AUTONOMOUS_AUDIT_ACTIONS as unknown as string[] },
        },
      }),
      prisma.auditLog.count({
        where: {
          projectId: validated.projectId,
          timestamp: { gt: since },
          action: 'HEALTH_FIX_ESCALATED',
        },
      }),
      prisma.auditLog.count({
        where: {
          projectId: validated.projectId,
          timestamp: { gt: since },
          action: { startsWith: 'ROLLBACK_' },
        },
      }),
      prisma.auditLog.findMany({
        where: {
          projectId: validated.projectId,
          timestamp: { gt: since },
          action: { in: AUTONOMOUS_AUDIT_ACTIONS as unknown as string[] },
        },
        orderBy: { timestamp: 'desc' },
        take: 5,
        select: { id: true, action: true, timestamp: true, details: true },
      }),
    ])

    const examples = samples.map(s => {
      let d: Record<string, any> = {}
      try {
        d = s.details ? JSON.parse(s.details) : {}
      } catch { /* ignore */ }
      const explained = explainAutonomyEvent(d)
      return {
        id: s.id,
        at: s.timestamp.toISOString(),
        what: explained.what,
        why: explained.why,
        full: explained.full,
        kind: explained.kind,
      }
    })

    // "Total" includes rollbacks — a rollback while the user was away is one
    // of the most important things to surface (it means Backenly applied a
    // fix that turned out to be wrong and reverted itself). Leaving it out of
    // the banner trigger was an MVP-grade omission.
    const total = autonomousFixes + escalations + rollbacks
    const parts: string[] = []
    if (autonomousFixes > 0) parts.push(`handled ${autonomousFixes} thing${autonomousFixes === 1 ? '' : 's'} for you`)
    if (escalations > 0)     parts.push(`flagged ${escalations} for your review`)
    if (rollbacks > 0)       parts.push(`rolled back ${rollbacks} change${rollbacks === 1 ? '' : 's'} that didn’t verify`)

    let headline: string
    if (total === 0) {
      headline = 'Backenly didn’t need to make any changes while you were away.'
    } else if (parts.length === 1) {
      headline = `Backenly ${parts[0]} while you were away.`
    } else if (parts.length === 2) {
      headline = `Backenly ${parts[0]} and ${parts[1]} while you were away.`
    } else {
      headline = `Backenly ${parts[0]}, ${parts[1]}, and ${parts[2]} while you were away.`
    }

    return NextResponse.json({
      projectId: validated.projectId,
      since: since.toISOString(),
      now: new Date().toISOString(),
      autonomousFixes,
      escalations,
      rollbacks,
      total,
      headline,
      examples,
      shouldShow: total > 0,
    })
  })
}
