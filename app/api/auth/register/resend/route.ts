export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sendSignupCodeEmail } from '@/lib/auth/email'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { normalizeEmail, reissueEmailCode, throttleEmailCodeSend } from '@/lib/auth/email-code'
import {
  deliverPlatformEmail,
  EmailDeliveryUnavailableError,
  emailUnavailableBody,
  platformEmailConfigured,
} from '@/lib/email/platform-delivery'

const schema = z.object({
  email: z.string().email('Invalid email address'),
})

/**
 * POST /api/auth/register/resend
 *
 * A fresh code for a signup already started. It carries only the address: the
 * password and everything else were fixed when the register route admitted
 * the signup, so a resend cannot change the account that is created, and it
 * needs no second Turnstile solve.
 *
 * Answers the same whether or not a signup is pending for the address.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const rl = await consume(`email-code:resend:ip:${ip}`, AUTH_LIMITS.signup.ip.limit, AUTH_LIMITS.signup.ip.windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  try {
    const email = normalizeEmail(schema.parse(await request.json()).email)

    if (!platformEmailConfigured()) {
      return NextResponse.json(emailUnavailableBody('not_configured'), { status: 503 })
    }

    const throttle = await throttleEmailCodeSend('signup', email)
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: 'A code was sent to this address moments ago. Wait a minute before asking for another.' },
        { status: 429, headers: { 'Retry-After': String(throttle.retryAfter) } },
      )
    }

    const reissued = await reissueEmailCode('signup', email)
    if (reissued) {
      try {
        await deliverPlatformEmail(email, () => sendSignupCodeEmail(email, reissued.code))
      } catch (error) {
        if (error instanceof EmailDeliveryUnavailableError) {
          return NextResponse.json(emailUnavailableBody('failed'), { status: 503 })
        }
        throw error
      }
    }

    return NextResponse.json({
      status: 'code_sent',
      resendAfterSec: Math.round(AUTH_LIMITS.emailCode.send.cooldown.windowMs / 1000),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 })
    }
    console.error('Signup code resend error:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'Failed to send a new code' }, { status: 500 })
  }
}
