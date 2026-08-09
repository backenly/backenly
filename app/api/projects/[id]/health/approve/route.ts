export const dynamic = 'force-dynamic'

/**
 * HEALTH APPROVE / ROLLBACK
 * =========================
 * Pillar 4.3 — Approval queue endpoint
 * Pillar 4.4 — One-click rollback for every auto-fix
 *
 * POST   /api/projects/[id]/health/approve
 *   Body: { findingId: string }
 *   Executes the fix for a pending_approval finding with full audit trail.
 *
 * DELETE /api/projects/[id]/health/approve?findingId=<id>[&confirm=true]
 *   Reverts an auto_fixed finding to its recorded PRE-fix state via
 *   revertAutoFix (the engine owns the undo contract; this route only owns
 *   status transitions + audit). RLS-undo (a protection removal) returns 409
 *   requiresConfirmation until called with confirm=true.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { executeApprovedFix, revertAutoFix } from '@/lib/core/auto-fix-engine'
import { resolvePendingActionMemory } from '@/lib/operational-memory/ledger'

// ── POST — approve and execute ────────────────────────────────────────────────

export const POST = withProjectAccess(async (req: NextRequest, { user, project, projectId }) => {
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

  // Fetch and validate the finding belongs to this project. Status is checked
  // separately so approving from a second surface (dashboard Backend health vs
  // Review Queue) or a stale tab reports what actually happened instead of a
  // confusing 404.
  const finding = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId },
  })

  if (!finding) {
    return NextResponse.json(
      { success: false, error: 'Finding not found' },
      { status: 404 },
    )
  }

  if (finding.status === 'auto_fixed') {
    // Already applied — by autonomy, or by the same approval fired from the
    // other surface. Idempotent success, nothing to redo.
    return NextResponse.json({
      success: true,
      message: 'Already applied — this fix was completed. Nothing left to do.',
      findingId,
      alreadyApplied: true,
    })
  }

  if (finding.status === 'dismissed') {
    // 410, not 409 — clients auto-retry 409 (lock contention); a dismissed
    // finding will never become approvable by waiting.
    return NextResponse.json(
      { success: false, error: 'This finding was dismissed. Re-scan if you want it re-evaluated.' },
      { status: 410 },
    )
  }

  // Record the approval decision before touching anything
  await prisma.auditLog.create({
    data: {
      projectId,
      userId: user.userId,
      userEmail: user.email,
      action: 'HEALTH_FIX_APPROVED',
      type: 'health',
      details: JSON.stringify({ findingId, findingType: finding.type }),
      timestamp: new Date(),
    },
  })

  // Execute the fix (bypasses the classification gate — user already approved)
  const result = await executeApprovedFix(findingId, projectId)

  if (!result.success) {
    // Approval recorded but execution failed — leave as pending_approval
    await prisma.auditLog.create({
      data: {
        projectId,
        userId: user.userId,
        userEmail: user.email,
        action: 'HEALTH_FIX_EXECUTION_FAILED',
        type: 'health',
        details: JSON.stringify({ findingId, findingType: finding.type, error: result.message }),
        timestamp: new Date(),
      },
    })

    // Classify the error so the dashboard can show the right status code and
    // the user gets a helpful next-step rather than a 500.
    const lower = (result.message ?? '').toLowerCase()
    const isLockContention =
      lower.includes('in progress') ||
      lower.includes('another auto-fix') ||
      lower.includes('try again')
    const needsUserAction =
      lower.includes('needs your manual review') ||
      lower.includes('needs your api key')

    const statusCode = isLockContention ? 409 : needsUserAction ? 422 : 500
    return NextResponse.json({ success: false, error: result.message }, { status: statusCode })
  }

  // Persist the fixed state + rollback payload
  const details = (finding.details ?? {}) as Record<string, unknown>
  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status: 'auto_fixed',
      autoFixed: true,
      fixAppliedAt: new Date(),
      details: {
        ...details,
        rollbackData: {
          ...(result.rollbackData ?? {}),
          approvedBy: user.userId,
          approvedByEmail: user.email,
          approvedAt: new Date().toISOString(),
        },
      },
    },
  })

  await prisma.auditLog.create({
    data: {
      projectId,
      userId: user.userId,
      userEmail: user.email,
      action: 'HEALTH_FIX_EXECUTED',
      type: 'health',
      details: JSON.stringify({
        findingId,
        findingType: finding.type,
        message: result.message,
        snapshotId: result.snapshotId ?? null,
        // The statements the approved fix actually ran, captured at the driver
        // (lib/execution/sql-recorder.ts). The audit row outlives the finding,
        // so the record of what was executed belongs here as well as in
        // finding.details.rollbackData.
        statements: (result.rollbackData as Record<string, unknown> | undefined)?.statements ?? [],
        // Drives the ledger copy: only 'confirmed' may claim re-verification.
        verification: result.verification ?? 'unverified',
      }),
      timestamp: new Date(),
    },
  })

  // Reconcile the Memory timeline: flip the paired 'proposed' event to 'applied'
  // and record the human approval so the operational ledger reflects reality.
  await resolvePendingActionMemory({
    projectId,
    finding,
    decision: 'approved',
    actorId: user.userId,
  })

  // Record the resolution in fix history NOW — at the moment the user actually
  // approved and the fix actually ran. The observer used to write this at
  // detection time for pending_approval findings, fabricating "User resolved"
  // activity for actions that never happened; it no longer does.
  try {
    const { writeFixHistory, buildResolutionText } = await import('@/lib/memory/fix-history')
    await writeFixHistory(projectId, {
      findingType: finding.type as any,
      findingSeverity: finding.severity as any,
      status: 'auto_fixed',
      details,
      resolution: buildResolutionText(finding.type as any, details, false),
      automatic: false,
    })
  } catch { /* non-fatal — the audit log above is the durable record */ }

  return NextResponse.json({
    success: true,
    message: result.message,
    findingId,
    snapshotId: result.snapshotId ?? null,
  })
})

// ── DELETE — rollback an auto-fixed finding ───────────────────────────────────

export const DELETE = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  const { searchParams } = new URL(req.url)
  const findingId = searchParams.get('findingId')
  const confirmed = searchParams.get('confirm') === 'true'

  if (!findingId) {
    return NextResponse.json({ success: false, error: 'findingId query param is required' }, { status: 400 })
  }

  const finding = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId, status: 'auto_fixed' },
  })

  if (!finding) {
    return NextResponse.json(
      { success: false, error: 'Finding not found or not in auto_fixed state' },
      { status: 404 },
    )
  }

  // The engine owns the undo contract: pre-fix snapshot revert (indexes, FK
  // constraints, RLS policies, triggers), metadata inverses, RLS confirm gate,
  // and the honest refusal for legacy fixes recorded before the contract.
  const result = await revertAutoFix(findingId, projectId, { confirmed })

  if (!result.success) {
    return NextResponse.json(
      {
        success: false,
        error: result.message,
        requiresConfirmation: result.requiresConfirmation ?? false,
      },
      { status: result.requiresConfirmation ? 409 : 400 },
    )
  }

  // Reset the finding to open so the next health cycle re-detects it
  const details = (finding.details ?? {}) as Record<string, unknown>
  const { rollbackData: _removed, ...remainingDetails } = details as any
  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status: 'open',
      autoFixed: false,
      fixAppliedAt: null,
      details: {
        ...remainingDetails,
        rolledBackAt: new Date().toISOString(),
        rolledBackBy: user.userId,
      },
    },
  })

  await prisma.auditLog.create({
    data: {
      projectId,
      userId: user.userId,
      userEmail: user.email,
      action: 'HEALTH_FIX_ROLLED_BACK',
      type: 'health',
      details: JSON.stringify({
        findingId,
        findingType: finding.type,
        appliedSteps: result.appliedSteps ?? 0,
        message: result.message,
      }),
      timestamp: new Date(),
    },
  })

  return NextResponse.json({ success: true, message: result.message, findingId })
})
