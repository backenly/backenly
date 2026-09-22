export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { assertSignupAllowed, SignupSlotTakenError } from '@/lib/platform-controls'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { EMAIL_CODE_REJECTED_MESSAGE, normalizeEmail, verifyEmailCode } from '@/lib/auth/email-code'
import { parsePendingSignup } from '@/lib/auth/signup/pending'
import { AccountAlreadyExistsError, completeEmailSignup } from '@/lib/auth/signup/complete-email-signup'

const schema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().min(1, 'Enter the code from the email').max(32),
})

/**
 * POST /api/auth/register/verify
 *
 * The second half of email signup. The address is proven by the code mailed
 * to it by POST /api/auth/register, and only then does the account exist.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const { limit, windowMs } = AUTH_LIMITS.emailCode.verify.ip
  const rl = await consume(`email-code:verify:ip:${ip}`, limit, windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  try {
    const parsed = schema.parse(await request.json())
    const email = normalizeEmail(parsed.email)

    const result = await verifyEmailCode('signup', email, parsed.code)
    if (!result.ok) {
      return NextResponse.json({ error: EMAIL_CODE_REJECTED_MESSAGE, code: 'CODE_REJECTED' }, { status: 400 })
    }

    const pending = parsePendingSignup(result.payload)
    if (!pending) {
      console.error('[auth] signup code verified but its pending signup was unreadable')
      return NextResponse.json({ error: EMAIL_CODE_REJECTED_MESSAGE, code: 'CODE_REJECTED' }, { status: 400 })
    }

    // Asked again, because up to ten minutes have passed since the register
    // route asked: a founder kill switch or a blocklist entry added in the
    // meantime must still stop this account. The trust verdict stays the one
    // reached then; only whether signup is allowed at all is re-decided.
    const guard = await assertSignupAllowed(email, pending.ip)
    if (!guard.ok) {
      return NextResponse.json({ error: guard.reason }, { status: guard.status })
    }

    return await completeEmailSignup({ email, ...pending, emailVerified: true })
  } catch (error) {
    if (error instanceof SignupSlotTakenError) {
      return NextResponse.json({ error: error.guard.reason }, { status: error.guard.status })
    }
    if (error instanceof AccountAlreadyExistsError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 })
    }
    console.error('Signup verification error:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'Failed to create the account' }, { status: 500 })
  }
}
