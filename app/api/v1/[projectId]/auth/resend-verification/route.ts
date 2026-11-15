export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { requestEmailVerification } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/auth/resend-verification
 *
 * Emails an end user their email-verification link again. Thin wrapper: the
 * flow lives in lib/services/end-user-auth-flows.ts and is shared with the
 * Express runtime.
 *
 * Served here, by the web service, because sending it needs the deployment's
 * email settings, which the web service holds and the runtime does not. With
 * no Next route, the catch-all forwarded it to the runtime on AWS, where a
 * project on Backenly's own email had the link logged and never sent.
 *
 * Body: { email }. Answers the same for addresses with and without an account.
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params

  // Per address the request came from, and per project, as forgot-password.
  const ip = clientIp(request)
  const limit = await consume(
    `v1:endUserResendVerify:${projectId}:${ip}`,
    AUTH_LIMITS.endUserRecover.ip.limit,
    AUTH_LIMITS.endUserRecover.ip.windowMs,
  )
  if (!limit.allowed) return throttledV1Response(limit, 'RATE_LIMITED')

  let email: unknown
  try {
    email = (await request.json())?.email
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Request body must be JSON with an "email" field.' } },
      { status: 400 },
    )
  }

  // And per TARGET address, so rotating sources cannot mail one person over and
  // over. Answered as the flow answers, so the limit says nothing about whether
  // the address has an account.
  const target = await consume(
    `v1:endUserResendVerify:target:${projectId}:${String(email ?? '').trim().toLowerCase().slice(0, 320)}`,
    AUTH_LIMITS.endUserRecover.ip.limit,
    AUTH_LIMITS.endUserRecover.ip.windowMs,
  )
  if (!target.allowed) {
    // The body requestEmailVerification answers for any address, exactly.
    return NextResponse.json({ data: { message: 'If an account with that email exists, a verification link has been sent.' } }, { status: 200 })
  }

  const result = await requestEmailVerification(projectId, email)
  return NextResponse.json(result.body, { status: result.status })
}

export const POST = recordedV1(handlePOST)
