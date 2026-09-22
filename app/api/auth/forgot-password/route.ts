export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { sendPasswordResetCodeEmail } from '@/lib/auth/email'
import { recordSecurityEvent } from '@/lib/platform-controls'
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
 * Mail the code and record what happened, without the caller waiting.
 *
 * Every outcome lands somewhere an operator can see it. A delivery failure is
 * also a security event, because "nobody can reset their password" is an
 * availability incident and the whole reason this route was rewritten: the
 * provider refused every message for days while each page said "sent".
 */
async function deliverResetCode(user: { id: string; email: string }, code: string): Promise<void> {
  let details: string
  try {
    const outcome = await deliverPlatformEmail(user.email, () => sendPasswordResetCodeEmail(user.email, code))
    details = outcome === 'sent'
      ? 'Password reset code sent'
      : 'Password reset code refused for this recipient by the receiving mail server'
  } catch (error) {
    // Nothing escapes: this runs detached from the request, and an unhandled
    // rejection takes the whole process down with it.
    const category = error instanceof EmailDeliveryUnavailableError ? error.category : 'unknown'
    details = `Password reset code could not be sent (${category})`
    await recordSecurityEvent({
      kind: 'email_delivery_failed',
      severity: 'high',
      userEmail: user.email,
      summary: `Password reset code could not be delivered (${category})`,
      detail: { surface: 'forgot-password', category },
    }).catch(() => {})
  }

  await prisma.auditLog.create({
    data: { action: 'Password reset requested', type: 'ui', userId: user.id, userEmail: user.email, details },
  }).catch(() => {})
}

/**
 * POST /api/auth/forgot-password
 *
 * Mails a six-digit code that POST /api/auth/reset-password accepts with a new
 * password.
 *
 * This used to answer "we sent a reset link" in every case, including the ones
 * where nothing was sent: an account with no password (every Google or GitHub
 * signup), a per-email limit that returned a fake success, an address stored
 * with different letter case, and a send that failed and was swallowed.
 *
 * It answers the same thing to everyone now, and means it. Whether an account
 * exists changes nothing a caller can observe: not the status, not the body,
 * not the database work done, and not how long any of it takes. What changed
 * is that a failure is no longer lost — it is recorded for operators rather
 * than reported to the stranger who asked.
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

    // Issued either way, so an address with an account and one without cost
    // the same database work. The code for an address with no account is never
    // mailed anywhere and expires unused.
    const { code } = await issueEmailCode('password_reset', email)

    if (user) {
      // Also for an account with no password. Google and GitHub signups have
      // none, and proving the address is enough to let them set one: it is
      // the same proof the provider gave when the account was made.
      //
      // NOT awaited, and its outcome never reaches the response. Waiting for
      // the provider would make a request for a real address take as long as
      // a send and one for an unknown address return at once, which answers
      // "does this account exist" by stopwatch. A failure is recorded where
      // operators look instead: the audit trail, the Security tab, and the
      // structured [email] line.
      void deliverResetCode(user, code).catch(() => {})
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
