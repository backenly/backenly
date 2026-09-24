export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { forgotEndUserPassword } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/auth/forgot-password
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * Body: { email }. Always 200 for unknown emails (no user enumeration).
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;

  // Throttled per IP AND per project. This surface had no rate limiting of any
  // kind, while the platform's own recovery routes are limited via AUTH_LIMITS.
  // Keyed on both so one project under attack cannot lock out recovery for a
  // different project behind the same egress address.
  const ip = clientIp(request)
  const limit = await consume(
    `v1:endUserRecover:${params.projectId}:${ip}`,
    AUTH_LIMITS.endUserRecover.ip.limit,
    AUTH_LIMITS.endUserRecover.ip.windowMs,
  )
  if (!limit.allowed) return throttledV1Response(limit, 'RATE_LIMITED')
  let email: unknown
  try {
    const body = await request.json()
    email = body?.email
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Request body must be JSON with an "email" field.' } },
      { status: 400 }
    )
  }

  // A second budget keyed on the TARGET address, not the requester.
  //
  // Without it this is an email bomb: one attacker, many addresses, and every
  // request sends mail to somebody who did not ask for it. The per-IP limit
  // caps the attacker's rate but not how often one victim can be mailed from
  // rotating sources.
  const targetLimit = await consume(
    `v1:endUserRecover:target:${params.projectId}:${String(email ?? '').trim().toLowerCase()}`,
    AUTH_LIMITS.endUserRecover.ip.limit,
    AUTH_LIMITS.endUserRecover.ip.windowMs,
  )
  if (!targetLimit.allowed) {
    // Still a 200-shaped answer. This route deliberately returns the same
    // response for known and unknown addresses, and a 429 that only appeared
    // for real accounts would undo that.
    return NextResponse.json({ success: true }, { status: 200 })
  }

  const result = await forgotEndUserPassword(params.projectId, email)
  return NextResponse.json(result.body, { status: result.status })
}

export const POST = recordedV1(handlePOST)
