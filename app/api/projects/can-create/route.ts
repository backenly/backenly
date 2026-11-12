export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getProjectLifecycle } from '@/lib/edition'
import { noEntitlements } from '@/lib/entitlements/policy'
import { ProjectCreationUnsupportedError } from '@/lib/projects/provision'
import { projectCreationVerdict, type CreationVerdict } from '@/lib/projects/creation-verdict'

/**
 * GET /api/projects/can-create?orgId= - Whether a project can be created here
 * 🔒 Protected: Requires authentication
 *
 * Asked before the console opens the New project form, so a plan limit is
 * said before anyone fills it in. Production QA (2026-11-09): on Free the
 * limit came back only after the name and region were chosen.
 *
 * The answer is the one POST /api/projects gives (lib/projects/creation-verdict.ts).
 * The POST still decides, and also refuses in maintenance mode and for an
 * account that must verify its email first; it says why when it does.
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  // One deployment, one project: nothing to ask of a plan.
  if (getProjectLifecycle().edition === 'single-tenant') {
    const unsupported = new ProjectCreationUnsupportedError()
    return NextResponse.json({ allowed: false, error: unsupported.message, code: unsupported.code })
  }

  const organizationId = request.nextUrl?.searchParams.get('orgId') || null
  const verdict = await projectCreationVerdict(user.userId, organizationId, { initialize: false })
  if (verdict.allowed) return NextResponse.json({ allowed: true })

  // This tsconfig does not narrow on a boolean discriminant.
  const { allowed: _allowed, status: _status, ...refusal } = verdict as Extract<CreationVerdict, { allowed: false }>
  // An account that has not created a project yet may have no entitlements:
  // creating gives it them before the limit is read, so that is no refusal.
  if (refusal.currentPlan === noEntitlements().currentPlan) return NextResponse.json({ allowed: true })
  return NextResponse.json({ allowed: false, ...refusal })
})
