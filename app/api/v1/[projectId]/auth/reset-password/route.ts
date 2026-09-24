export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { resetEndUserPassword } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/auth/reset-password
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * Body: { token, password }. Returns a fresh JWT on success so the user is
 * immediately signed in after resetting.
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
  let token: unknown
  let password: unknown
  try {
    const body = await request.json()
    token = body?.token
    password = body?.password
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Request body must be JSON with "token" and "password" fields.' } },
      { status: 400 }
    )
  }

  const result = await resetEndUserPassword(params.projectId, token, password)
  return NextResponse.json(result.body, { status: result.status })
}

export const POST = recordedV1(handlePOST)
