export const dynamic = 'force-dynamic'

/**
 * ON-DEMAND GOVERNED FIX  (IA restructure §6.2)
 * =========================================================
 * POST /api/projects/[id]/health/fix
 *   Body: { findingId: string }
 *
 * Backs the Overview advisor's "Let Backenly fix it" button for an *open*
 * finding. This does NOT force-execute — it runs the exact same governed path
 * the autonomous reconciler uses (`runAutoFix`), so the classification gate
 * still decides the outcome:
 *
 *   • auto            → applied now (within guardrails), reversible, receipted
 *   • pending_approval → routed to the review queue (approval-gated change)
 *   • notify_only      → needs the user (e.g. a missing credential)
 *
 * Contrast with /health/approve, which is the *second* click: it force-executes
 * a finding the user has already been shown in the review queue. Here the user
 * is asking the operator to take the first governed step from Overview.
 *
 * The clipboard path ("Hand to my agent") needs no endpoint — it's a pure copy.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { runAutoFix } from '@/lib/core/auto-fix-engine'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  let body: { findingId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { findingId } = body
  if (!findingId) {
    return NextResponse.json({ success: false, error: 'findingId is required' }, { status: 400 })
  }

  // The finding must belong to this project and still be open — a
  // pending_approval finding goes through /health/approve, not here.
  const finding = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId },
    select: { id: true, type: true, severity: true, status: true },
  })

  if (!finding) {
    return NextResponse.json({ success: false, error: 'Finding not found' }, { status: 404 })
  }

  if (finding.status === 'pending_approval') {
    // Already prepared and waiting — the caller should approve it instead.
    return NextResponse.json(
      { success: false, error: 'This change is already prepared and waiting in the review queue.', outcome: 'pending_approval' },
      { status: 409 },
    )
  }

  if (finding.status !== 'open') {
    return NextResponse.json(
      { success: false, error: `Nothing to do — finding is already ${finding.status.replace(/_/g, ' ')}.`, outcome: finding.status },
      { status: 409 },
    )
  }

  // Record the human-initiated request before touching anything, so History
  // shows who asked — even when the governed outcome is "routed to review".
  await prisma.auditLog.create({
    data: {
      projectId,
      userId: user.userId,
      userEmail: user.email,
      action: 'HEALTH_FIX_REQUESTED',
      type: 'health',
      details: JSON.stringify({ findingId, findingType: finding.type, from: 'overview_advisor' }),
      timestamp: new Date(),
    },
  }).catch(() => { /* audit is best-effort; never block the fix on it */ })

  try {
    const result = await runAutoFix(findingId, projectId)

    // Map the engine outcome to a user-facing message the advisor row renders.
    const outcome = result.outcome
    const message =
      outcome === 'auto_fixed'
        ? (result.message || 'Fixed and verified — receipt in History.')
        : outcome === 'pending_approval'
          ? (result.message || 'Prepared and sent to your review queue for approval.')
          : (result.message || 'This one needs you — see the details.')

    return NextResponse.json({ success: true, outcome, message, findingId })
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: sanitizeDiagnostic(err) || 'Fix could not be started' },
      { status: 500 },
    )
  }
})
