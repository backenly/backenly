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
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { createBranch, listBranches } from '@/lib/branches/engine'

// Preview branches are a Backenly Cloud capability. On a self-hosted
// deployment the surface does not exist, so this answers 404 rather than 403:
// 403 would imply the feature is here and withheld.
const cloudOnly404 = () =>
  NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })


export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  if (!isCloudEdition()) return cloudOnly404()
  const branches = await listBranches(projectId)
  return NextResponse.json({ success: true, branches })
})

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  if (!isCloudEdition()) return cloudOnly404()
  let body: { name?: string; includeData?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.name) {
    return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 })
  }

  // Data copy is opt-in and stays opt-in through every caller. Defaulting it on
  // here would quietly undo the protective default: a branch is for testing a
  // schema change, and a full copy of production multiplies the blast radius of
  // whatever the experiment does. Supabase ships the same feature with the same
  // default, for the same stated reason.
  const result = await createBranch(projectId, user.userId, body.name, {
    includeData: body.includeData === true,
  })
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
