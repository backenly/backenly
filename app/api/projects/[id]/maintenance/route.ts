/**
 * Maintenance Ladder — read the proposal, grant consent, withdraw it
 * ===================================================================
 *
 * GET    /api/projects/[id]/maintenance   — the ladder awaiting a decision:
 *                                            diagnosis, every rung, its tier,
 *                                            what it can undo, and whether
 *                                            consent is already on file.
 * POST   /api/projects/[id]/maintenance   — grant consent for one plan version.
 * DELETE /api/projects/[id]/maintenance   — withdraw it.
 *
 * This route exists because `maintenance_approvals` shipped with a reader and
 * no writer. The scheduler asked for consent on every pass and nothing in the
 * product could give it, so a Tier-2 ladder could never run — the documented
 * activation was an operator hand-writing a row in psql. An autonomous system
 * whose safety rests on a human's approval has to let the human approve.
 *
 * Everything here delegates to `lib/autonomy/maintenance/approval.ts`, which is
 * the single authority: the same rebuild-and-compare runs whether consent
 * arrives from this route, the dashboard, or an MCP agent.
 *
 * Auth is `withProjectValidation` — platform auth plus project ownership — the
 * same contract as every other project-scoped route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import {
  describePendingLadder,
  grantMaintenanceApproval,
  revokeMaintenanceApproval,
  isLadderRefusal,
  isGrantRefusal,
  isRevokeRefusal,
} from '@/lib/autonomy/maintenance/approval'
import type { LadderAnswers } from '@/lib/autonomy/maintenance/approval'
import type { StepBinding } from '@/lib/autonomy/maintenance/execute'

export async function GET(
  request: NextRequest,
  _props: { params: Promise<{ id: string }> },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const ladder = await describePendingLadder({ projectId: validated.projectId })
    if (isLadderRefusal(ladder)) {
      // Not an error. "Nothing is wrong with this backend" is the answer this
      // endpoint gives most of the time, and a 404 would make a healthy project
      // look like a broken route.
      return NextResponse.json({ pending: false, reason: ladder.refusal })
    }
    return NextResponse.json({ pending: true, ladder })
  })
}

export async function POST(
  request: NextRequest,
  _props: { params: Promise<{ id: string }> },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const body = (await request.json().catch(() => ({}))) as {
      planVersion?: unknown
      bindings?: unknown
      answers?: unknown
      maxTier?: unknown
      reason?: unknown
    }

    const planVersion = typeof body.planVersion === 'string' ? body.planVersion.trim() : ''
    if (!planVersion) {
      return NextResponse.json(
        {
          error:
            'planVersion is required. Read GET /api/projects/{id}/maintenance first: consent is bound to one exact version of one ladder, so approving without naming it is not an approval anybody could give.',
        },
        { status: 400 },
      )
    }
    // Two doors onto one validation. The dashboard posts `answers` - the one
    // set of facts a person actually states about a ladder - and the server
    // fans them across the rungs. A script or an agent may post raw per-ordinal
    // `bindings` instead. Neither skips a check the other runs.
    const hasAnswers = typeof body.answers === 'object' && body.answers !== null
    const hasBindings = typeof body.bindings === 'object' && body.bindings !== null
    if (!hasAnswers && !hasBindings) {
      return NextResponse.json(
        {
          error:
            'answers or bindings is required. A rung cannot run until somebody says which column it operates on, so consent without that is not consent anybody could give.',
        },
        { status: 400 },
      )
    }

    const result = await grantMaintenanceApproval({
      projectId: validated.projectId,
      planVersion,
      approvedBy: validated.userId,
      ...(hasAnswers
        ? { answers: body.answers as LadderAnswers }
        : { bindings: body.bindings as Record<number, StepBinding> }),
      maxTier: typeof body.maxTier === 'number' ? body.maxTier : undefined,
      reason: typeof body.reason === 'string' ? body.reason : null,
    })

    if (isGrantRefusal(result)) {
      // 409, not 400. The request was well-formed; the world moved underneath
      // it, and the caller's next step is to re-read the plan rather than to
      // fix their payload.
      return NextResponse.json(
        { error: result.refusal, currentPlanVersion: result.currentPlanVersion },
        { status: 409 },
      )
    }

    await prisma.auditLog
      .create({
        data: {
          projectId: validated.projectId,
          userId: validated.userId,
          action: 'MAINTENANCE_APPROVAL_GRANTED',
          type: 'autonomy',
          details: JSON.stringify({
            approvalId: result.approval.id,
            planId: result.planId,
            planVersion: result.planVersion,
            maxTier: result.approval.maxTier,
            at: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      })
      .catch(() => {})

    return NextResponse.json({ ok: true, approval: result.approval })
  })
}

export async function DELETE(
  request: NextRequest,
  _props: { params: Promise<{ id: string }> },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)
    const approvalId = url.searchParams.get('approvalId')?.trim()
    if (!approvalId) {
      return NextResponse.json({ error: 'approvalId is required' }, { status: 400 })
    }

    const result = await revokeMaintenanceApproval({
      projectId: validated.projectId,
      approvalId,
      revokedBy: validated.userId,
    })
    if (isRevokeRefusal(result)) {
      return NextResponse.json({ error: result.refusal }, { status: 404 })
    }

    await prisma.auditLog
      .create({
        data: {
          projectId: validated.projectId,
          userId: validated.userId,
          action: 'MAINTENANCE_APPROVAL_REVOKED',
          type: 'autonomy',
          details: JSON.stringify({ approvalId, at: new Date().toISOString() }),
          timestamp: new Date(),
        },
      })
      .catch(() => {})

    return NextResponse.json({ ok: true, approvalId })
  })
}
