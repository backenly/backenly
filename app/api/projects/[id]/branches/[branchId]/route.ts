export const dynamic = 'force-dynamic'

/**
 * Preview branch operations.
 *
 * GET    /api/projects/[id]/branches/[branchId]        → schema diff vs main
 * POST   /api/projects/[id]/branches/[branchId]        → merge (additive auto,
 *                                                        the rest as review items)
 * DELETE /api/projects/[id]/branches/[branchId]        → discard (drops the clone)
 *
 * Explicit Extract<> casts throughout — this tsconfig doesn't narrow boolean
 * discriminants, so `if (!r.ok)` alone doesn't typecheck the branches.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { diffBranch, mergeBranch, discardBranch } from '@/lib/branches/engine'

function branchIdFrom(req: NextRequest): string {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export const GET = withProjectAccess(async (req: NextRequest, { projectId }) => {
  const result = await diffBranch(projectId, branchIdFrom(req))
  if (!result.ok) {
    const fail = result as Extract<typeof result, { ok: false }>
    return NextResponse.json({ success: false, error: fail.error }, { status: 404 })
  }
  const ok = result as Extract<typeof result, { ok: true }>
  return NextResponse.json({ success: true, branch: ok.branch, diff: ok.diff })
})

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  const result = await mergeBranch(projectId, user.userId, branchIdFrom(req))
  if (!result.ok) {
    const fail = result as Extract<typeof result, { ok: false }>
    return NextResponse.json({ success: false, error: fail.error }, { status: 404 })
  }
  const ok = result as Extract<typeof result, { ok: true }>
  return NextResponse.json({
    success: true,
    branch: ok.branch,
    applied: ok.applied,
    review: ok.review,
    fullyMerged: ok.fullyMerged,
  })
})

export const DELETE = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  const result = await discardBranch(projectId, user.userId, branchIdFrom(req))
  if (!result.ok) {
    const fail = result as Extract<typeof result, { ok: false }>
    return NextResponse.json({ success: false, error: fail.error }, { status: 404 })
  }
  return NextResponse.json({ success: true })
})
