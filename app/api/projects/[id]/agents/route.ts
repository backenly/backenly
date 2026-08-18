/**
 * Agent Orchestration API
 *
 * POST /api/projects/[id]/agents          — run all agents (security+perf+migration+repair+plan)
 * GET  /api/projects/[id]/agents          — return latest health findings from DB
 * POST /api/projects/[id]/agents?fix=auto — run agents + auto-apply Phase 1 fixes
 *
 * The POST endpoint is the on-demand trigger for the multi-agent system.
 * The background cron hits the same orchestrator on a 15-minute schedule.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { runAllAgents, executeAutoFixes } from '@/lib/ai/agent-orchestrator'
import { prisma } from '@/lib/db/prisma'

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const autoFix = request.nextUrl.searchParams.get('fix') === 'auto'

    const { orchestrator, plan } = await runAllAgents(validated.projectId)

    let appliedFixes: string[] = []
    if (autoFix) {
      appliedFixes = await executeAutoFixes(validated.projectId, plan)
    }

    return NextResponse.json({
      projectId: validated.projectId,
      ranAt: orchestrator.ranAt,
      summary: {
        totalFindings: orchestrator.totalFindings,
        criticalCount: orchestrator.criticalCount,
        autoFixedCount: orchestrator.autoFixedCount + appliedFixes.length,
        pendingApprovalCount: orchestrator.pendingApprovalCount,
      },
      ctoBrief: plan.ctoBrief,
      estimatedFixTime: plan.estimatedFixTime,
      executionPlan: plan.executionPlan.map(phase => ({
        name: phase.name,
        canAutoRun: phase.canAutoRun,
        actionCount: phase.actions.length,
        actions: phase.actions.map(a => ({
          id: a.id,
          agentType: a.agentType,
          severity: a.severity,
          title: a.title,
          description: a.description,
          location: a.location,
          fix: a.fix ? {
            description: a.fix.description,
            requiresApproval: a.fix.requiresApproval,
            reversible: a.fix.reversible,
            sql: a.fix.sql,
          } : null,
        })),
      })),
      topFindings: orchestrator.topFindings,
      appliedFixes,
      agentBreakdown: orchestrator.agentResults.map(r => ({
        agent: r.agentType,
        durationMs: r.durationMs,
        findings: r.findings.length,
        autoFixed: r.autoFixed.length,
        skipped: r.skipped,
      })),
    })
  })
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const findings = await prisma.healthFinding.findMany({
      where: {
        projectId: validated.projectId,
        status: { in: ['open', 'pending_approval'] },
      },
      orderBy: [
        { severity: 'asc' },
        { detectedAt: 'desc' },
      ],
      take: 50,
    })

    return NextResponse.json({
      projectId: validated.projectId,
      openCount: findings.length,
      criticalCount: findings.filter(f => f.severity === 'critical').length,
      findings: findings.map(f => ({
        id: f.id,
        type: f.type,
        severity: f.severity,
        details: f.details,
        status: f.status,
        detectedAt: f.detectedAt,
      })),
    })
  })
}
