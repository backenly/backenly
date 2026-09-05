export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { verifyPassword } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { logAuthEvent } from '@/lib/services/logging'
import { sendAccountLockedEmail } from '@/lib/auth/email'
import { isBlocked, recordSecurityEvent } from '@/lib/platform-controls'
import { z } from 'zod'
import crypto from 'crypto'

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  totpCode: z.string().optional(), // Optional 2FA code
})

// ── IP-based brute-force protection (5 attempts / 15 min per IP) ─────────────
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const MAX_IP_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000

function checkIpBruteForce(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now()
  const record = loginAttempts.get(ip)
  if (!record || record.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true }
  }
  if (record.count >= MAX_IP_ATTEMPTS) {
    return { allowed: false, retryAfterMs: record.resetAt - now }
  }
  record.count++
  return { allowed: true }
}

function resetIpBruteForce(ip: string) {
  loginAttempts.delete(ip)
}

// ── Account-level lockout constants ──────────────────────────────────────────
const MAX_ACCOUNT_ATTEMPTS = 5
const ACCOUNT_LOCK_DURATION_MS = 30 * 60 * 1000 // 30 minutes

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'

  // 1. IP-level rate limit
  const rateCheck = checkIpBruteForce(ip)
  if (!rateCheck.allowed) {
    // Surface an IP brute-force burst on the Security tab.
    recordSecurityEvent({
      kind: 'auth_anomaly',
      severity: 'high',
      ip: ip === 'unknown' ? null : ip,
      summary: `Login brute-force: IP ${ip} exceeded ${MAX_IP_ATTEMPTS} attempts / 15min`,
      detail: { ip, surface: 'login', limit: MAX_IP_ATTEMPTS },
    }).catch(() => {})
    const retryAfterSec = Math.ceil((rateCheck.retryAfterMs ?? WINDOW_MS) / 1000)
    return NextResponse.json(
      { error: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
    )
  }

  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON payload', code: 'MALFORMED_REQUEST' },
        { status: 400 }
      )
    }

    const { email, password, totpCode } = loginSchema.parse(body)

    // Founder blocklist — blocks IP / email / domain at the login surface so
    // an admin can stop an active abuser immediately. Reuses the same code
    // path as the OAuth callbacks and signup.
    const blockHit = await isBlocked({ email, ip: ip === 'unknown' ? null : ip })
    if (blockHit) {
      await recordSecurityEvent({
        kind: 'blocklist_hit',
        severity: 'warn',
        userEmail: email,
        ip: ip === 'unknown' ? null : ip,
        summary: `Blocked login attempt — ${blockHit.kind}=${blockHit.value}`,
        detail: { match: blockHit, surface: 'login' },
      })
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    // 2. Load user
    const user = await prisma.user.findUnique({
      where: { email },
      include: { role: true },
    })

    if (!user) {
      // Don't reveal whether the account exists
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    // 3. Account lockout check (#69)
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMs = user.lockedUntil.getTime() - Date.now()
      const remainingMin = Math.ceil(remainingMs / 60000)
      return NextResponse.json(
        {
          error: `Account temporarily locked due to too many failed login attempts. Try again in ${remainingMin} minute${remainingMin === 1 ? '' : 's'}, or check your email for an unlock link.`,
          code: 'ACCOUNT_LOCKED',
          lockedUntil: user.lockedUntil.toISOString(),
        },
        { status: 423 }
      )
    }

    // 4. OAuth-only accounts can't use password login
    if (!user.password) {
      return NextResponse.json(
        { error: 'This account uses OAuth login. Please sign in with your provider.' },
        { status: 401 }
      )
    }

    // 5. Verify password
    const isValid = await verifyPassword(password, user.password)

    if (!isValid) {
      // Increment per-account failed attempt counter
      const newCount = user.failedLoginAttempts + 1
      const shouldLock = newCount >= MAX_ACCOUNT_ATTEMPTS

      const updateData: Record<string, unknown> = { failedLoginAttempts: newCount }
      if (shouldLock) {
        updateData.lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS)
        // Reset count after locking so the next lock window starts fresh
        updateData.failedLoginAttempts = 0
      }

      await prisma.user.update({ where: { id: user.id }, data: updateData })

      if (shouldLock) {
        // Send unlock email (fire and forget — don't fail the response if email fails)
        sendAccountLockedEmail(user.email, user.lockedUntil ?? new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS)).catch(() => {})
        recordSecurityEvent({
          kind: 'auth_anomaly',
          severity: 'high',
          userId: user.id,
          userEmail: user.email,
          ip: ip === 'unknown' ? null : ip,
          summary: `Account locked after ${MAX_ACCOUNT_ATTEMPTS} failed logins: ${user.email}`,
          detail: { ip, surface: 'login', email: user.email },
        }).catch(() => {})
      }

      await logAuthEvent({
        event: 'login',
        userId: user.id,
        success: false,
        metadata: { email, reason: 'Invalid password', attempt: newCount, locked: shouldLock },
      })

      return NextResponse.json(
        {
          error: 'Invalid email or password',
          ...(shouldLock
            ? { detail: 'Account locked due to too many failed attempts. Check your email for an unlock link.' }
            : { attemptsRemaining: MAX_ACCOUNT_ATTEMPTS - newCount }),
        },
        { status: 401 }
      )
    }

    // 6. 2FA check — if user has 2FA enabled, require TOTP code (#71)
    if (user.twoFactorEnabled) {
      if (!totpCode) {
        return NextResponse.json(
          { error: 'Two-factor authentication code required', code: 'TOTP_REQUIRED' },
          { status: 401 }
        )
      }

      const { verifyTOTP } = await import('@/lib/auth/totp')
      const totpValid = verifyTOTP(user.twoFactorSecret!, totpCode)

      if (!totpValid) {
        // Check backup codes
        const backupCodes = await prisma.twoFactorBackupCode.findMany({
          where: { userId: user.id, usedAt: null },
        })
        const { verifyPassword: verifyHash } = await import('@/lib/auth/password')
        const matchingCode = await (async () => {
          for (const bc of backupCodes) {
            if (await verifyHash(totpCode, bc.codeHash)) return bc
          }
          return null
        })()

        if (!matchingCode) {
          return NextResponse.json(
            { error: 'Invalid two-factor authentication code', code: 'TOTP_INVALID' },
            { status: 401 }
          )
        }

        // Mark backup code as used
        await prisma.twoFactorBackupCode.update({
          where: { id: matchingCode.id },
          data: { usedAt: new Date() },
        })
      }
    }

    // 7. Successful login — reset lockout counters
    const now = new Date()
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: now,
        lastActiveAt: now,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    })

    resetIpBruteForce(ip)

    // 8. Create session with refresh token
    const { token, refreshToken, sessionId } = await createSession(
      user.id,
      user.email,
      user.role?.name,
      user.name || undefined,
      'email'
    )

    await logAuthEvent({
      event: 'login',
      userId: user.id,
      success: true,
      metadata: { email: user.email, provider: 'email' },
    })

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        role: user.role?.name,
      },
      token,
      refreshToken,
    })

    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })

    // Store refresh token in a separate long-lived httpOnly cookie
    if (refreshToken) {
      response.cookies.set('refresh-token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== 'development',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: '/',
      })
    }

    return response
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message, code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    console.error('Login error:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    return NextResponse.json(
      {
        error: 'Failed to login',
        code: 'LOGIN_ERROR',
        details:
          process.env.NODE_ENV === 'development' && error instanceof Error
            ? error.message
            : undefined,
      },
      { status: 500 }
    )
  }
}
