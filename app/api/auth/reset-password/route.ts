export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { z } from 'zod'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { EMAIL_CODE_REJECTED_MESSAGE, normalizeEmail, verifyEmailCode } from '@/lib/auth/email-code'

const schema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().min(1, 'Enter the code from the email').max(32),
  password: z.string().min(1, 'Password is required'),
})

/**
 * POST /api/auth/reset-password
 *
 * Replaces a password once the code mailed by POST /api/auth/forgot-password
 * is proven. Every existing session ends, and a lockout from failed sign-ins
 * is lifted, because the person has just proven they own the address.
 */
export async function POST(request: NextRequest) {
  // IP rate limit — these are unauthenticated calls.
  const ip = clientIp(request)
  const rl = await consume(`reset:ip:${ip}`, AUTH_LIMITS.resetPassword.ip.limit, AUTH_LIMITS.resetPassword.ip.windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    )
  }

  try {
    const body = await request.json()
    const parsed = schema.parse(body)
    const email = normalizeEmail(parsed.email)

    // Checked before the code, so a weak password does not spend one of the
    // code's five attempts.
    const strength = validatePasswordStrength(parsed.password)
    if (!strength.valid) {
      return NextResponse.json({ error: strength.message }, { status: 400 })
    }

    const result = await verifyEmailCode('password_reset', email, parsed.code)
    if (!result.ok) {
      return NextResponse.json({ error: EMAIL_CODE_REJECTED_MESSAGE, code: 'CODE_REJECTED' }, { status: 400 })
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, email: true },
    })
    if (!user) {
      return NextResponse.json({ error: EMAIL_CODE_REJECTED_MESSAGE, code: 'CODE_REJECTED' }, { status: 400 })
    }

    const hashedPassword = await hashPassword(parsed.password)

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
        // The code was mailed to this address and typed back, which is the
        // proof verification asks for.
        emailVerified: true,
      },
    })

    // Invalidate every existing session — old JWTs land in a Session row, but
    // if we leave those rows here they keep verifying as valid. Wipe them.
    await prisma.session.deleteMany({ where: { userId: user.id } })

    await prisma.auditLog.create({
      data: {
        action: 'Password reset completed',
        type: 'ui',
        userId: user.id,
        userEmail: user.email,
        details: 'Password replaced with an emailed code; all sessions ended',
      },
    })

    return NextResponse.json({ message: 'Password updated. You can now sign in with it.' })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 })
    }
    console.error('Reset password error:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 })
  }
}
