/**
 * GET /api/cron/autonomy — run the autonomy reconciler across active projects
 *
 * Scheduled every minute by:
 *   - node-cron in instrumentation.ts (self-hosted / Hetzner — the real path)
 *   - Vercel Cron via vercel.json (optional, for Vercel deployments)
 *
 * Also callable ad-hoc with the CRON_SECRET header/query param for ops:
 *   curl -H "x-cron-secret: $CRON_SECRET" https://backenly.com/api/cron/autonomy
 *
 * The per-project dispatcher (runReconciler) already gates by:
 *   - FLAGS.ENABLE_AUTONOMY_RECONCILER (master switch)
 *   - the owner's autonomy dial (OFF → shadow only)
 *   - the circuit breaker + change-freeze during incidents
 *
 * So this route does no policy work — it just enumerates active projects and
 * fans out, with per-project failure isolation and a small concurrency cap.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { runReconciler } from '@/lib/autonomy/reconciler'
import { diagnoseEscalatedFindings } from '@/lib/autonomy/escalation-diagnosis'
import { FLAGS } from '@/lib/config/flags'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'

const CONCURRENCY = 5

export async function GET(request: NextRequest) {
  const secret =
    request.headers.get('x-cron-secret') ||
    request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!FLAGS.ENABLE_AUTONOMY_RECONCILER) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'ENABLE_AUTONOMY_RECONCILER is disabled at the platform level.',
    })
  }

  const startedAt = Date.now()

  const activeProjects = await prisma.project
    .findMany({
      // Shared with the in-process node-cron tick so the two schedulers cannot
      // disagree about which projects get healed. See lib/autonomy/activity-gate.ts.
      where: activeProjectsWhere(),
      select: { id: true },
    })
    .catch(() => [])

  let attempted = 0
  let applied = 0
  let escalated = 0
  let deferred = 0
  let frozen = 0
  const errors: string[] = []

  let diagnosed = 0

  for (let i = 0; i < activeProjects.length; i += CONCURRENCY) {
    const batch = activeProjects.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(p => runReconciler(p.id)))
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'rejected') {
        errors.push(`${batch[j].id}: ${String(r.reason?.message ?? r.reason)}`)
        continue
      }
      const v = r.value
      if (!v) continue
      if ('applied' in v) {
        attempted += v.attempted
        applied += v.applied
        escalated += v.escalated
        deferred += v.deferred
        if (v.frozen) frozen++
      }
    }

    // Tier B — senior-engineer pass over whatever this batch escalated: write
    // a grounded diagnosis onto findings waiting for a human. Words only,
    // never mutations; capped per project per tick; failure-isolated.
    const diag = await Promise.allSettled(
      batch.map(p => diagnoseEscalatedFindings(p.id)),
    )
    for (const d of diag) {
      if (d.status === 'fulfilled') diagnosed += d.value
    }
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    projectsScanned: activeProjects.length,
    attempted,
    applied,
    escalated,
    deferred,
    frozen,
    diagnosed,
    errors: errors.slice(0, 10),
  })
}
