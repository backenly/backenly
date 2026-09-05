export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/operator?since=<ISO>
 *
 * Build-runtime observability for the Ops tab in /admin.
 * Returns: auto-fixes, repair loops, approval counts, blocked integrations,
 * mutation counts, top failed intents, domain breakdown, correction timeline.
 *
 * FOUNDER-ONLY — matches FOUNDER_EMAIL env var.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

export async function GET(request: NextRequest) {
  // Same founder/admin gate as every other /api/admin/* route (JWT for GET).
  const authError = await requireFounder(request)
  if (authError) return authError

  const url = new URL(request.url)
  const since = url.searchParams.get('since')
    ? new Date(url.searchParams.get('since')!)
    : new Date(Date.now() - 24 * 60 * 60 * 1000)

  try {
    const [
      autoFixEvents,
      pendingApprovals,
      appliedApprovals,
      dismissedApprovals,
      aiUsageToday,
      recentAuditLogs,
      deployedProjects,
      totalProjects,
    ] = await Promise.all([
      prisma.correctionEvent.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          correctionType: true,
          correctionDetail: true,
          domain: true,
          originalActionType: true,
          createdAt: true,
          projectId: true,
        },
      }),

      prisma.healthFinding.count({ where: { status: 'pending_approval' } }),
      prisma.healthFinding.count({ where: { status: 'applied' } }),
      prisma.healthFinding.count({ where: { status: 'dismissed' } }),

      prisma.userAiUsage.aggregate({
        _sum: { intentCount: true, tokenCount: true, apiRequestCount: true },
        where: { date: new Date().toISOString().slice(0, 7) },
      }),

      prisma.auditLog.findMany({
        where: { timestamp: { gte: since } },
        orderBy: { timestamp: 'desc' },
        take: 50,
        select: {
          id: true,
          action: true,
          type: true,
          timestamp: true,
          userId: true,
          userEmail: true,
          projectId: true,
        },
      }),

      prisma.project.count({ where: { isDeployed: true, expiresAt: null } }),
      prisma.project.count({ where: { expiresAt: null } }),
    ])

    // ── Derived metrics ────────────────────────────────────────────────────────

    const autoFixCount = autoFixEvents.filter(e => e.correctionType === 'AI_SELF_CORRECT').length
    const repairLoopCount = autoFixEvents.filter(e => e.correctionType === 'REPAIR_LOOP').length

    const intentFreq = new Map<string, number>()
    for (const e of autoFixEvents) {
      if (e.originalActionType) {
        intentFreq.set(e.originalActionType, (intentFreq.get(e.originalActionType) ?? 0) + 1)
      }
    }
    const topFailedIntents = [...intentFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }))

    const domainFreq = new Map<string, number>()
    for (const e of autoFixEvents) {
      if (e.domain) domainFreq.set(e.domain, (domainFreq.get(e.domain) ?? 0) + 1)
    }
    const domainBreakdown = [...domainFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([domain, count]) => ({ domain, count }))

    const blockedActions = recentAuditLogs.filter(
      l => l.action?.toLowerCase().includes('credential') || l.action?.toLowerCase().includes('blocked')
    )

    const mutationActions = ['CREATE_TABLE', 'ALTER_TABLE', 'DROP_TABLE', 'GENERATE_API', 'CREATE_BUCKET', 'DELETE_BUCKET']
    const mutationCount = recentAuditLogs.filter(l => mutationActions.includes(l.action ?? '')).length

    const hourBuckets: Record<string, number> = {}
    for (const e of autoFixEvents) {
      const h = new Date(e.createdAt).toISOString().slice(0, 13)
      hourBuckets[h] = (hourBuckets[h] ?? 0) + 1
    }
    const timeline = Object.entries(hourBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, count]) => ({ hour, count }))

    return NextResponse.json({
      window: { since: since.toISOString(), until: new Date().toISOString() },
      builds: {
        activeBuilds: 0,
        autoFixCount,
        repairLoopCount,
        correctionEventTotal: autoFixEvents.length,
      },
      approvals: {
        pending: pendingApprovals,
        applied: appliedApprovals,
        dismissed: dismissedApprovals,
      },
      aiUsage: {
        intentCount: aiUsageToday._sum.intentCount ?? 0,
        tokenCount: aiUsageToday._sum.tokenCount ?? 0,
        apiRequestCount: Number(aiUsageToday._sum.apiRequestCount ?? 0),
      },
      projects: { total: totalProjects, deployed: deployedProjects },
      mutations: { count: mutationCount, perDay: mutationCount },
      blockedIntegrations: {
        count: blockedActions.length,
        recent: blockedActions.slice(0, 5).map(l => ({
          action: l.action,
          projectId: l.projectId,
          timestamp: l.timestamp,
        })),
      },
      topFailedIntents,
      domainBreakdown,
      timeline,
      recentAuditLogs: recentAuditLogs.slice(0, 20),
      evaluatedAt: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error('[OperatorDashboard] Error:', err)
    return NextResponse.json({ error: 'Failed to load operator metrics' }, { status: 500 })
  }
}
