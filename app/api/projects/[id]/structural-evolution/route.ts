/**
 * Structural evolution — see what should change shape, rehearse it, consent,
 * run it, undo it
 * ===========================================================================
 *
 * GET    /api/projects/[id]/structural-evolution[?table=]
 *          the analysis: proposals with their evidence, exact ladder, consent
 *          state and last run; concerns being watched
 * POST   /api/projects/[id]/structural-evolution  { action, ... }
 *          rehearse  { spec }               run the ladder on a copy, roll it
 *                                           back, return what happened
 *          approve   { spec, planVersion, reason? }
 *                                           consent to that exact version
 *          execute   { planId }             run (or resume) an approved ladder
 *          rollback  { planId }             undo it, losslessly or not at all
 * DELETE /api/projects/[id]/structural-evolution?approvalId=
 *          withdraw consent
 *
 * Not to be confused with `../evolution`, the long-horizon orchestrator's
 * model-written roadmap. This one is deterministic and acts: every decision is
 * made in lib/structural-evolution; this route authenticates, parses and
 * records. Auth is `withProjectValidation` — platform auth plus project
 * ownership — the same door the maintenance ladder's consent goes through.
 *
 * Refusals are 409, not 400 or 500: the request was well-formed and the world
 * said no — the plan moved, consent is missing, the satellite holds data its
 * parent does not. The caller's next step is to re-read, not to fix a payload.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import {
  analyzeStructuralEvolution,
  executeExtraction,
  grantEvolutionApproval,
  isGrantRefusal,
  isResolveRefusal,
  isRevokeRefusal,
  normaliseSpec,
  rehearseExtraction,
  resolveExtractionPlan,
  revokeEvolutionApproval,
  rollbackExtraction,
} from '@/lib/structural-evolution'

function audit(projectId: string, userId: string, action: string, details: Record<string, unknown>) {
  return prisma.auditLog
    .create({
      data: {
        projectId,
        userId,
        action,
        type: 'autonomy',
        details: JSON.stringify({ ...details, at: new Date().toISOString() }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})
}

export async function GET(request: NextRequest, _props: { params: Promise<{ id: string }> }) {
  return withProjectValidation<any>(request, async validated => {
    const url = new URL(request.url)
    const table = url.searchParams.get('table')?.trim()
    const report = await analyzeStructuralEvolution(validated.projectId, table ? { tables: [table] } : {})
    return NextResponse.json(report)
  })
}

export async function POST(request: NextRequest, _props: { params: Promise<{ id: string }> }) {
  return withProjectValidation<any>(request, async validated => {
    const { projectId, userId } = validated
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''

    switch (action) {
      case 'rehearse': {
        const spec = normaliseSpec(body.spec)
        if (!spec) return NextResponse.json({ error: 'spec { host, members[], satellite } is required' }, { status: 400 })
        const resolved = await resolveExtractionPlan(projectId, spec)
        if (isResolveRefusal(resolved)) return NextResponse.json({ error: resolved.refusal }, { status: 409 })
        if (resolved.plan.validity !== 'executable') {
          return NextResponse.json(
            { error: `the plan is ${resolved.plan.validity}: ${resolved.plan.blockedReasons.join('; ')}` },
            { status: 409 },
          )
        }
        const rehearsal = await rehearseExtraction(resolved.facts, resolved.plan.spec, resolved.plan.planId)
        return NextResponse.json({ planId: resolved.plan.planId, planVersion: resolved.plan.planVersion, rehearsal })
      }

      case 'approve': {
        const spec = normaliseSpec(body.spec)
        const planVersion = typeof body.planVersion === 'string' ? body.planVersion.trim() : ''
        if (!spec || !planVersion) {
          return NextResponse.json(
            {
              error:
                'spec and planVersion are required. Read GET /api/projects/{id}/structural-evolution first: consent binds to one exact version of one ladder.',
            },
            { status: 400 },
          )
        }
        const result = await grantEvolutionApproval({
          projectId,
          spec,
          planVersion,
          approvedBy: userId,
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
          resolve: resolveExtractionPlan,
        })
        if (isGrantRefusal(result)) {
          return NextResponse.json({ error: result.refusal, currentPlanVersion: result.currentPlanVersion }, { status: 409 })
        }
        await audit(projectId, userId, 'EVOLUTION_APPROVAL_GRANTED', {
          approvalId: result.approval.id,
          planId: result.plan.planId,
          planVersion: result.plan.planVersion,
          host: spec.host,
          satellite: spec.satellite,
          members: spec.members,
        })
        return NextResponse.json({ ok: true, approval: result.approval, planId: result.plan.planId })
      }

      case 'execute': {
        const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
        if (!planId) return NextResponse.json({ error: 'planId is required' }, { status: 400 })
        const outcome = await executeExtraction({ projectId, planId })
        await audit(projectId, userId, 'EVOLUTION_LADDER_RUN', {
          planId,
          planVersion: outcome.planVersion,
          status: outcome.status,
          haltReason: outcome.haltReason,
        })
        const status = outcome.status === 'refused' ? 409 : 200
        return NextResponse.json(outcome, { status })
      }

      case 'rollback': {
        const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
        if (!planId) return NextResponse.json({ error: 'planId is required' }, { status: 400 })
        const outcome = await rollbackExtraction({ projectId, planId, requestedBy: userId })
        // Deliberately not `ROLLBACK_*`: the trust scoreboard and the subsystem
        // harm signal count those as repairs that did not hold. An owner
        // reversing a restructuring is not one.
        await audit(projectId, userId, 'EVOLUTION_REVERSED', { planId, status: outcome.status, reason: outcome.reason })
        const status = ['refused', 'failed', 'in_flight_elsewhere'].includes(outcome.status) ? 409 : 200
        return NextResponse.json(outcome, { status })
      }

      default:
        return NextResponse.json({ error: 'action must be one of rehearse, approve, execute, rollback' }, { status: 400 })
    }
  })
}

export async function DELETE(request: NextRequest, _props: { params: Promise<{ id: string }> }) {
  return withProjectValidation<any>(request, async validated => {
    const approvalId = new URL(request.url).searchParams.get('approvalId')?.trim()
    if (!approvalId) return NextResponse.json({ error: 'approvalId is required' }, { status: 400 })
    const result = await revokeEvolutionApproval({
      projectId: validated.projectId,
      approvalId,
      revokedBy: validated.userId,
    })
    if (isRevokeRefusal(result)) return NextResponse.json({ error: result.refusal }, { status: 404 })
    await audit(validated.projectId, validated.userId, 'EVOLUTION_APPROVAL_REVOKED', { approvalId })
    return NextResponse.json({ ok: true, id: result.id })
  })
}
