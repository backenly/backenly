/**
 * GET /api/cron/workspace-observer — run the workspace health observer
 *
 * Scheduled every 6 hours via:
 *   - Vercel Cron (vercel.json)
 *   - node-cron in instrumentation.ts (self-hosted / Hetzner)
 *
 * Also callable ad-hoc by passing the CRON_SECRET header/query param.
 * The observer scans every active deployed project for health issues,
 * auto-fixes safe ones, queues risky ones, and writes HealthFinding records.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runWorkspaceObserver } from '@/lib/services/workspace-observer'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()

  try {
    const result = await runWorkspaceObserver()

    const totalFindings = result.results.reduce((s, r) => s + r.findingsDetected, 0)
    const totalAutoFixed = result.results.reduce((s, r) => s + r.autoFixed, 0)
    const totalPending = result.results.reduce((s, r) => s + r.pendingApproval, 0)
    const totalCritical = result.results.reduce((s, r) => s + r.critical, 0)

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      projectsScanned: result.processed,
      totalFindings,
      totalAutoFixed,
      totalPendingApproval: totalPending,
      totalCritical,
      topLevelErrors: result.errors,
    })
  } catch (error: any) {
    console.error('[WorkspaceObserver] Fatal error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
