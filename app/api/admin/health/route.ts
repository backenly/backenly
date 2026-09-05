export const dynamic = 'force-dynamic'

/**
 * OPERATOR HEALTH ENDPOINT
 * =========================
 * Track E — Provides a real-time operational health snapshot for operators.
 *
 * GET /api/admin/health
 *   → Full health snapshot including stuck executions, failed webhooks,
 *     repeated self-healing failures, and readiness block clusters.
 *
 * Restricted to the founder/admin account (FOUNDER_EMAIL env var).
 * Returns structured data suitable for dashboards or alerts.
 *
 * Response shape:
 * {
 *   ok: boolean,           // false if any concerning signals exist
 *   snapshot: OperatorHealthSnapshot,
 *   signals: SignalSummary  // quick glance for on-call
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { getOperatorHealthSnapshot } from '@/lib/ai/stuck-execution-detector'

export async function GET(request: NextRequest) {
  // Same founder/admin gate as every other /api/admin/* route (JWT for GET).
  const authError = await requireFounder(request)
  if (authError) return authError

  try {
    const snapshot = await getOperatorHealthSnapshot()

    const { summary } = snapshot

    // "ok" = no active signals requiring immediate operator attention
    const ok =
      summary.stuckCount === 0 &&
      summary.abandonedCount === 0 &&
      summary.repeatedHealingFailureCount === 0 &&
      summary.webhookFailureProjectCount === 0

    // Human-readable signal summary for on-call dashboards
    const signals: string[] = []

    if (summary.stuckCount > 0) {
      signals.push(`${summary.stuckCount} stuck execution(s) — may need manual intervention`)
    }
    if (summary.abandonedCount > 0) {
      signals.push(`${summary.abandonedCount} abandoned execution(s) — user may need to retry`)
    }
    if (summary.webhookFailureProjectCount > 0) {
      signals.push(`${summary.webhookFailureProjectCount} project(s) with recent webhook signature failures`)
    }
    if (summary.repeatedHealingFailureCount > 0) {
      signals.push(`${summary.repeatedHealingFailureCount} action type(s) failing repeatedly despite self-healing`)
    }

    if (signals.length === 0) {
      signals.push('All systems operating normally')
    }

    return NextResponse.json({
      ok,
      signals,
      snapshot,
      // Quick reference for alert routing
      stuckExecutionProjectIds: snapshot.stuckExecutions.map(e => e.projectId),
      webhookFailureProjectIds: snapshot.failedWebhookClusters.map(e => e.projectId),
    })
  } catch (err: any) {
    console.error('[AdminHealth]', err)
    return NextResponse.json(
      { error: 'Health check failed', detail: err.message },
      { status: 500 }
    )
  }
}
