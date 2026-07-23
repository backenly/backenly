export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { prisma } from '@/lib/db/postgres'
import { sendPasswordResetEmail } from '@/lib/auth/email'
import { z } from 'zod'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'

const schema = z.object({
  email: z.string().email('Invalid email address'),
})

export async function POST(request: NextRequest) {
  // ── Rate limit: IP + email composite ──────────────────────────────────────
  // Limits chosen to be tight enough to slow scraping but loose enough that a
  // user fat-fingering their email a couple times still works.
  const ip = clientIp(request)
  const ipRl = consume(`forgot:ip:${ip}`, AUTH_LIMITS.forgotPassword.ip.limit, AUTH_LIMITS.forgotPassword.ip.windowMs)
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: 'Too many password reset requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(ipRl.retryAfter) } }
    )
  }

  try {
    const body = await request.json()
    const { email } = schema.parse(body)

    // Per-email throttle on top of IP throttle.
    const emailRl = consume(`forgot:email:${email.toLowerCase()}`, AUTH_LIMITS.forgotPassword.email.limit, AUTH_LIMITS.forgotPassword.email.windowMs)
    if (!emailRl.allowed) {
      // Return the same generic message to avoid email enumeration via
      // distinguishable 429s. Still set Retry-After for honest clients.
      return NextResponse.json(
        { message: 'If an account exists for that email, we sent a reset link.' },
        { status: 200, headers: { 'Retry-After': String(emailRl.retryAfter) } }
      )
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (user && user.password) {
      const secret = process.env.JWT_SECRET
      if (!secret) throw new Error('JWT_SECRET is not configured')

      // Single-use token: jti is recorded in DB on issue, deleted on consume.
      const jti = crypto.randomBytes(16).toString('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1h

      const token = jwt.sign(
        { userId: user.id, purpose: 'password-reset', jti },
        secret,
        { expiresIn: '1h', algorithm: 'HS256' }
      )

      // Invalidate any prior outstanding reset tokens for this user — only one
      // valid reset link at a time.
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } })
      await prisma.passwordResetToken.create({
        data: { jti, userId: user.id, expiresAt },
      })

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      const resetUrl = `${appUrl}/auth/reset-password?token=${token}`

      Promise.race([
        sendPasswordResetEmail(email, resetUrl),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('email_timeout')), 10_000)),
      ]).catch(() => { /* non-fatal */ })

      await prisma.auditLog.create({
        data: {
          action: 'Password reset requested',
          type: 'ui',
          userId: user.id,
          userEmail: user.email,
          details: `Password reset email sent to ${email}`,
        },
      })
    }

    // Always return 200 regardless of whether email exists.
    return NextResponse.json({
      message: 'If an account exists for that email, we sent a reset link.',
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 })
    }
    console.error('Forgot password error:', error instanceof Error ? error.message : 'unknown')
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }
}
