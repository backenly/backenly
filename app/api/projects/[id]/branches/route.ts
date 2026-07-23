export const dynamic = 'force-dynamic'

/**
 * Preview branches — list + create.
 *
 * GET  /api/projects/[id]/branches
 * POST /api/projects/[id]/branches   Body: { name: string }
 *
 * A branch is a full structural+data clone of the workspace schema —
 * effectively free on Backenly's multi-tenant architecture. Merge and
 * discard live on the [branchId] route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { createBranch, listBranches } from '@/lib/branches/engine'

export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  const branches = await listBranches(projectId)
  return NextResponse.json({ success: true, branches })
})

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.name) {
    return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 })
  }

  const result = await createBranch(projectId, user.userId, body.name)
  // Explicit extracts — this tsconfig doesn't narrow boolean discriminants.
  if (!result.ok) {
    const fail = result as Extract<typeof result, { ok: false }>
    return NextResponse.json({ success: false, error: fail.error }, { status: 422 })
  }
  const ok = result as Extract<typeof result, { ok: true }>
  return NextResponse.json({
    success: true,
    branch: ok.branch,
    tablesCloned: ok.tablesCloned,
  })
})
