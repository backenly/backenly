export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { acceptInvite } from '@/lib/org'
import { z } from 'zod'

const AcceptSchema = z.object({ token: z.string().min(10).max(200) })

/**
 * POST /api/org/invites/accept — accept an org invite as the signed-in user
 * (§5.3). Validates status/expiry and that the invite email matches the
 * account, then adds the membership. Idempotent.
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  const body = await request.json().catch(() => ({}))
  const parsed = AcceptSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'A valid invite token is required.' }, { status: 400 })
  }

  const result = await acceptInvite(parsed.data.token, user.userId)
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  }
  return NextResponse.json({ success: true, data: { orgId: result.orgId, orgName: result.orgName } })
})
