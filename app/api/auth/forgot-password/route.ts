export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { sendPasswordResetCodeEmail } from '@/lib/auth/email'
import { z } from 'zod'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { EMAIL_CODE_TTL_MS, issueEmailCode, normalizeEmail, throttleEmailCodeSend } from '@/lib/auth/email-code'
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
 * POST /api/auth/forgot-password
 *
 * Mails a six-digit code that POST /api/auth/reset-password accepts with a new
 * password.
 *
 * This used to answer "we sent a reset link" in every case, including the ones
 * where nothing was sent: an account with no password (every Google or GitHub
 * signup), a per-email limit that returned a fake success, an address stored
 * with different letter case, and a send that failed and was swallowed. Now
 * the only thing the answer hides is whether an account exists.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const ipRl = await consume(`forgot:ip:${ip}`, AUTH_LIMITS.forgotPassword.ip.limit, AUTH_LIMITS.forgotPassword.ip.windowMs)
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: 'Too many password reset requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(ipRl.retryAfter) } }
    )
  }

  try {
    const body = await request.json()
    const email = normalizeEmail(schema.parse(body).email)

    // Deployment-wide and asked before any lookup, so it says nothing about
    // who has an account. A self-hosted operator is told how to recover
    // without email.
    if (!platformEmailConfigured()) {
      return NextResponse.json(emailUnavailableBody('not_configured'), { status: 503 })
    }

    // Keyed on the address before the lookup, so an honest 429 is safe: an
    // address without an account is throttled exactly like one with.
    const throttle = await throttleEmailCodeSend('password_reset', email)
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: 'A code was sent to this address moments ago. Wait a minute before asking for another.' },
        { status: 429, headers: { 'Retry-After': String(throttle.retryAfter) } }
      )
    }

    // Case-insensitive: older rows were stored as typed, and an exact match
    // silently found nobody for them.
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, email: true },
    })

    if (user) {
      // Also for an account with no password. Google and GitHub signups have
      // none, and proving the address is enough to let them set one: it is
      // the same proof the provider gave when the account was made.
      const { code } = await issueEmailCode('password_reset', email)
      let outcome: 'sent' | 'recipient_refused'
      try {
        outcome = await deliverPlatformEmail(() => sendPasswordResetCodeEmail(user.email, code))
      } catch (error) {
        if (error instanceof EmailDeliveryUnavailableError) {
          await prisma.auditLog.create({
            data: {
              action: 'Password reset requested',
              type: 'ui',
              userId: user.id,
              userEmail: user.email,
              details: `Password reset code could not be sent (${error.category})`,
            },
          }).catch(() => {})
          return NextResponse.json(emailUnavailableBody('failed'), { status: 503 })
        }
        throw error
      }

      await prisma.auditLog.create({
        data: {
          action: 'Password reset requested',
          type: 'ui',
          userId: user.id,
          userEmail: user.email,
          details: outcome === 'sent'
            ? 'Password reset code sent'
            : 'Password reset code refused by the recipient mail server',
        },
      })
    }

    return NextResponse.json({
      status: 'code_sent',
      expiresInSec: Math.round(EMAIL_CODE_TTL_MS / 1000),
      resendAfterSec: Math.round(AUTH_LIMITS.emailCode.send.cooldown.windowMs / 1000),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 })
    }
    console.error('Forgot password error:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }
}
