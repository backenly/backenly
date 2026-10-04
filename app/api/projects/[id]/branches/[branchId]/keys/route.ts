export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/branches/[branchId]/keys   Body: { serviceRole?: boolean }
 *
 * Issue a key bound to a preview branch: the dashboard's half of the branch's
 * preview endpoint. The agent tools (create_branch / connect_branch) mint
 * through the same function, so a key issued here and one issued to an agent
 * are the same kind of key.
 *
 * Issuing a credential is administration, the same rule POST /api/api-keys
 * applies. The plaintext is in this response once and is never stored.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { canAdministerProject } from '@/lib/edition/guard'
import { mintPreviewKey, previewEndpoint } from '@/lib/branches/preview'
import { resolvePublicBaseUrl } from '@/lib/services/public-url'

function branchIdFrom(req: NextRequest): string {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  if (!isCloudEdition()) {
    return NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })
  }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ success: false, error: 'Only a project admin can issue keys.' }, { status: 403 })
  }

  let body: { serviceRole?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    // An empty body asks for the default: a client key.
  }

  const result = await mintPreviewKey(projectId, branchIdFrom(req), { serviceRole: body.serviceRole === true })
  if (!result.ok) {
    const fail = result as Extract<typeof result, { ok: false }>
    return NextResponse.json({ success: false, error: fail.error, code: fail.code }, { status: 404 })
  }
  const ok = result as Extract<typeof result, { ok: true }>
  return NextResponse.json({
    success: true,
    key: ok.minted.key,
    keyShownOnce: true,
    keyId: ok.minted.keyId,
    keyPrefix: ok.minted.keyPrefix,
    serviceRole: ok.minted.serviceRole,
    preview: previewEndpoint(projectId, ok.branch, resolvePublicBaseUrl(req)),
  }, { status: 201 })
})
