/**
 * Autonomy Trust + Control API
 *
 * GET   /api/projects/[id]/autonomy   — trust scoreboard, activity feed,
 *                                        approval inbox, and the loop's
 *                                        current shadow decision.
 * PATCH /api/projects/[id]/autonomy   — set the project's autonomy dial
 *                                        ({ level: OFF|CONSERVATIVE|BALANCED|AGGRESSIVE }).
 *
 * GET is read-only. PATCH only changes an owner setting — it never executes an
 * autonomous action. Both are gated by platform auth + project ownership via
 * withProjectValidation (same contract as every other project-scoped route).
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { buildTrustReport } from '@/lib/autonomy/trust-report'
import {
  clampToPlan,
  coerceAutonomyLevel,
  getProjectAutonomyCap,
} from '@/lib/autonomy/autonomy-level'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)
    const windowDays = Math.max(
      1,
      Math.min(90, Number(url.searchParams.get('windowDays')) || 30),
    )
    const report = await buildTrustReport(validated.projectId, windowDays)
    return NextResponse.json(report)
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    const requested = coerceAutonomyLevel((body as { level?: unknown }).level)

    if (!requested) {
      return NextResponse.json(
        {
          error:
            'Invalid level. Use one of: OFF, CONSERVATIVE, BALANCED, AGGRESSIVE.',
        },
        { status: 400 },
      )
    }

    // Clamp to the plan cap at WRITE time. Previously the read path silently
    // clamped, so a Free user picking AGGRESSIVE saw the UI say "Active" while
    // the loop ran at CONSERVATIVE — the system lied. Now the dial only
    // persists what the plan actually allows; the UI and the runtime agree.
    const cap = await getProjectAutonomyCap(validated.projectId)
    const level = clampToPlan(requested, cap)
    const clamped = level !== requested

    await prisma.project.update({
      where: { id: validated.projectId },
      data: { autonomyLevel: level },
    })

    // Audit the EFFECTIVE level. If the request was clamped, record both so the
    // history shows the attempt and why it landed lower.
    await prisma.auditLog.create({
      data: {
        projectId: validated.projectId,
        userId: validated.userId,
        action: 'AUTONOMY_LEVEL_CHANGED',
        type: 'autonomy',
        details: JSON.stringify({
          level,
          ...(clamped ? { requested, cap, clampedByPlan: true } : {}),
          at: new Date().toISOString(),
        }),
        timestamp: new Date(),
      },
    }).catch(() => {})

    return NextResponse.json({ ok: true, level, cap, requested, clamped })
  })
}
