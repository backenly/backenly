export const dynamic = 'force-dynamic'

/**
 * Preview branches — list + create.
 *
 * GET  /api/projects/[id]/branches
 * POST /api/projects/[id]/branches   Body: { name: string, includeData?: boolean }
 *
 * A branch is a structural clone of the workspace schema, with rows only when
 * includeData is asked for, and is effectively free on Backenly's
 * multi-tenant architecture. Merge and discard live on the [branchId] route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { createBranch, listBranches } from '@/lib/branches/engine'
import {
  previewAgentInstructions,
  previewCurl,
  previewEndpoint,
  previewSdkSnippet,
} from '@/lib/branches/preview'
import { resolvePublicBaseUrl } from '@/lib/services/public-url'

// Preview branches are a Backenly Cloud capability. On a self-hosted
// deployment the surface does not exist, so this answers 404 rather than 403:
// 403 would imply the feature is here and withheld.
const cloudOnly404 = () =>
  NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })


export const GET = withProjectAccess(async (req: NextRequest, { projectId }) => {
  if (!isCloudEdition()) return cloudOnly404()
  const branches = await listBranches(projectId)
  const origin = resolvePublicBaseUrl(req)
  // Every active branch comes with its preview endpoint, so the panel can show
  // where to point an app without a second round trip. The snippets name the
  // key's slot rather than carrying a key: a key is shown once, when issued.
  return NextResponse.json({
    success: true,
    branches: branches.map(b => {
      if (b.status !== 'active') return b
      const endpoint = previewEndpoint(projectId, b, origin)
      return {
        ...b,
        preview: {
          ...endpoint,
          // The dashboard reads the spec with its own session, not an MCP key.
          openapiUrl: `/api/projects/${projectId}/openapi?branchId=${b.id}`,
          curl: previewCurl(endpoint),
          sdk: previewSdkSnippet(projectId),
          instructions: previewAgentInstructions(endpoint),
        },
      }
    }),
  })
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
