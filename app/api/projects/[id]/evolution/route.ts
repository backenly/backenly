/**
 * Evolution API
 *
 * GET  /api/projects/[id]/evolution          — current evolution state (no LLM)
 * POST /api/projects/[id]/evolution/analyze  — trigger full LLM deep analysis
 *
 * The GET endpoint reads the stored EvolutionState from architecturalMemory.
 * It's read-only and fast — safe to poll from the UI.
 *
 * The POST endpoint runs analyzeProjectEvolution() (LLM-powered roadmap + scaling
 * risk analysis). Results are persisted; subsequent GETs reflect the new state.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { loadEvolutionState, analyzeProjectEvolution } from '@/lib/ai/long-horizon-orchestrator'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const state = await loadEvolutionState(validated.projectId)

    if (!state) {
      return NextResponse.json({
        projectId: validated.projectId,
        status: 'no_builds',
        message: 'No build history yet — run your first build to start tracking evolution.',
      })
    }

    const activeDebt = state.debtItems.filter(d => !d.resolvedAt)
    const urgentMilestones = state.scalingMilestones.filter(m => !m.reached && (m.urgency === 'now' || m.urgency === 'within_month'))
    const immediateRoadmap = state.roadmap.filter(r => !r.completedAt && r.phase === 'immediate')

    return NextResponse.json({
      projectId: validated.projectId,
      phase: {
        current: state.currentPhase.name,
        startedAt: state.currentPhase.startedAt,
        summary: state.currentPhase.summary,
        history: state.phases.map(p => ({
          name: p.name,
          startedAt: p.startedAt,
          completedAt: p.completedAt,
          entitiesAtStart: p.entitiesAtStart,
          entitiesAtEnd: p.entitiesAtEnd,
        })),
      },
      metrics: {
        buildsCount: state.buildsCount,
        firstBuildAt: state.firstBuildAt,
        lastAnalyzedAt: state.lastAnalyzedAt,
      },
      debt: {
        score: state.totalDebtScore,
        activeCount: activeDebt.length,
        criticalCount: activeDebt.filter(d => d.severity === 'critical').length,
        highCount: activeDebt.filter(d => d.severity === 'high').length,
        items: activeDebt.slice(0, 10).map(d => ({
          id: d.id,
          category: d.category,
          severity: d.severity,
          location: d.location,
          description: d.description,
          recommendation: d.recommendation,
          autoFixable: d.autoFixable,
          fix: d.fix,
        })),
      },
      scaling: {
        urgentCount: urgentMilestones.length,
        milestones: state.scalingMilestones
          .filter(m => !m.reached)
          .sort((a, b) => {
            const order = { now: 0, within_month: 1, within_quarter: 2, future: 3 }
            return order[a.urgency] - order[b.urgency]
          })
          .slice(0, 8)
          .map(m => ({
            id: m.id,
            type: m.type,
            trigger: m.trigger,
            currentEstimate: m.currentEstimate,
            recommendation: m.recommendation,
            urgency: m.urgency,
          })),
      },
      roadmap: {
        generatedAt: state.roadmapGeneratedAt,
        immediate: immediateRoadmap.slice(0, 5),
        upcoming: state.roadmap
          .filter(r => !r.completedAt && r.phase !== 'immediate')
          .sort((a, b) => b.priority - a.priority)
          .slice(0, 10),
      },
      entityDependencies: state.entityDependencies
        .filter(e => e.couplingScore >= 4)
        .sort((a, b) => b.couplingScore - a.couplingScore)
        .slice(0, 10),
    })
  })
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const result = await analyzeProjectEvolution(validated.projectId)

    const activeDebt = result.debtItems.filter(d => !d.resolvedAt)

    return NextResponse.json({
      projectId: validated.projectId,
      status: 'analyzed',
      analyzedAt: result.lastAnalyzedAt,
      phase: result.currentPhase.name,
      phaseSummary: result.currentPhase.summary,
      debtScore: result.totalDebtScore,
      activeDebtItems: activeDebt.length,
      roadmapItems: result.roadmap.filter(r => !r.completedAt).length,
      urgentScalingRisks: result.scalingMilestones.filter(m => !m.reached && m.urgency === 'now').length,
      roadmap: result.roadmap.filter(r => !r.completedAt).slice(0, 10),
      scalingRisks: result.scalingMilestones.filter(m => !m.reached).slice(0, 5),
    })
  })
}
