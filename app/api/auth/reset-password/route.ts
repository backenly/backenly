export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/postgres'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { z } from 'zod'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'

const schema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export async function POST(request: NextRequest) {
  // IP rate limit — these are unauthenticated calls.
  const ip = clientIp(request)
  const rl = consume(`reset:ip:${ip}`, AUTH_LIMITS.resetPassword.ip.limit, AUTH_LIMITS.resetPassword.ip.windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    )
  }

  try {
    const body = await request.json()
    const { token, password } = schema.parse(body)

    const strength = validatePasswordStrength(password)
    if (!strength.valid) {
      return NextResponse.json({ error: strength.message }, { status: 400 })
    }

    const secret = process.env.JWT_SECRET
    if (!secret) throw new Error('JWT_SECRET is not configured')

    // Pin HS256. Reset JWTs are signed by us with the same secret.
    let payload: { userId: string; purpose: string; jti: string }
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as any
    } catch {
      return NextResponse.json(
        { error: 'Reset link is invalid or has expired. Please request a new one.' },
        { status: 400 }
      )
    }

    if (payload.purpose !== 'password-reset' || !payload.jti) {
      return NextResponse.json(
        { error: 'Reset link is invalid or has expired. Please request a new one.' },
        { status: 400 }
      )
    }

    // Single-use enforcement: the issuing route recorded jti+userId. Consume
    // the row atomically — `deleteMany` returns count 0 if it's already been
    // used or expired, in which case we reject without doing anything.
    const consumed = await prisma.passwordResetToken.deleteMany({
      where: { jti: payload.jti, userId: payload.userId, expiresAt: { gt: new Date() } },
    })
    if (consumed.count === 0) {
      return NextResponse.json(
        { error: 'Reset link is invalid or has expired. Please request a new one.' },
        { status: 400 }
      )
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } })
    if (!user) {
      return NextResponse.json(
        { error: 'Reset link is invalid or has expired. Please request a new one.' },
        { status: 400 }
      )
    }

    const hashedPassword = await hashPassword(password)

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
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
        details: 'User successfully reset their password',
      },
    })

    return NextResponse.json({ message: 'Password reset successfully. You can now sign in.' })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 })
    }
    console.error('Reset password error:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 })
  }
}
