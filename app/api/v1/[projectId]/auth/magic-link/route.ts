export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { requestMagicLink } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/auth/magic-link
 *
 * Emails an end user a one-time sign-in link. Thin wrapper: the flow lives in
 * lib/services/end-user-auth-flows.ts and is shared with the Express runtime.
 *
 * Served here, by the web service, because sending it needs the deployment's
 * email settings, which the web service holds and the runtime does not. With
 * no Next route, the catch-all forwarded it to the runtime on AWS, where a
 * project on Backenly's own email had its link logged and never sent.
 *
 * Body: { email }. Answers the same for addresses with and without an account.
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params

  // Per address the request came from, and per project, as forgot-password.
  const ip = clientIp(request)
  const limit = await consume(
    `v1:endUserMagicLink:${projectId}:${ip}`,
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

  // And per TARGET address: without it, rotating sources could mail one person
  // a sign-in link over and over. Answered as a sent link, so the limit says
  // nothing about whether the address has an account.
  const target = await consume(
    `v1:endUserMagicLink:target:${projectId}:${String(email ?? '').trim().toLowerCase().slice(0, 320)}`,
    AUTH_LIMITS.endUserRecover.ip.limit,
    AUTH_LIMITS.endUserRecover.ip.windowMs,
  )
  if (!target.allowed) {
    // The body requestMagicLink answers a request it sent a link for, exactly.
    return NextResponse.json({ data: { message: 'If that email is valid, a sign-in link has been sent.' } }, { status: 200 })
  }

  const result = await requestMagicLink(projectId, email)
  return NextResponse.json(result.body, { status: result.status })
}

export const POST = recordedV1(handlePOST)
