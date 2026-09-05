export const dynamic = 'force-dynamic'

/**
 * Admin step-up ("sudo mode") — the second factor for every destructive admin
 * endpoint.
 *
 * GET    /api/admin/reauth  → is sudo active, and which factors can I use?
 * POST   /api/admin/reauth  → { password? , totp? } → mint the sudo cookie
 * DELETE /api/admin/reauth  → drop sudo immediately
 *
 * This route deliberately uses `resolveFounder` and NOT `requireFounder`:
 * requireFounder demands step-up on POST, and this IS the step-up.
 */

import { NextRequest, NextResponse } from 'next/server'
import { resolveFounder } from '@/lib/admin/auth/requireFounder'
import { verifyPassword } from '@/lib/auth/password'
import { verifyTOTP } from '@/lib/auth/totp'
import { prisma } from '@/lib/db/prisma'
import {
  ADMIN_SUDO_TTL_SEC,
  clearAdminSudoCookie,
  hasAdminSudo,
  mintAdminSudoToken,
  setAdminSudoCookie,
} from '@/lib/admin/auth/adminStepUp'
import { recordSecurityEvent } from '@/lib/platform/controls'

// ── Brute-force brake ─────────────────────────────────────────────────────────
// In-process and per-user. The founder surface has a handful of accounts, so a
// map is the right size of tool here; it costs nothing and resets on deploy.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5
const _attempts = new Map<string, { count: number; firstAt: number }>()

function registerFailure(userId: string): number {
  const now = Date.now()
  const existing = _attempts.get(userId)
  if (!existing || now - existing.firstAt > ATTEMPT_WINDOW_MS) {
    _attempts.set(userId, { count: 1, firstAt: now })
    return 1
  }
  existing.count += 1
  return existing.count
}

function isLockedOut(userId: string): boolean {
  const existing = _attempts.get(userId)
  if (!existing) return false
  if (Date.now() - existing.firstAt > ATTEMPT_WINDOW_MS) {
    _attempts.delete(userId)
    return false
  }
  return existing.count >= MAX_ATTEMPTS
}

export async function GET(request: NextRequest) {
  const identity = await resolveFounder(request)
  if (identity instanceof NextResponse) return identity

  const user = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { password: true, twoFactorEnabled: true, twoFactorSecret: true },
  })

  return NextResponse.json({
    active: hasAdminSudo(request, identity.userId),
    ttlSeconds: ADMIN_SUDO_TTL_SEC,
    methods: {
      password: !!user?.password,
      totp: !!(user?.twoFactorEnabled && user?.twoFactorSecret),
    },
  })
}

export async function POST(request: NextRequest) {
  const identity = await resolveFounder(request)
  if (identity instanceof NextResponse) return identity

  if (isLockedOut(identity.userId)) {
    return NextResponse.json(
      { error: 'Too many failed attempts. Wait 15 minutes before trying again.', code: 'SUDO_LOCKED' },
      { status: 429 },
    )
  }

  let body: { password?: unknown; totp?: unknown } = {}
  try {
    body = (await request.json()) ?? {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const password = typeof body.password === 'string' ? body.password : ''
  const totp = typeof body.totp === 'string' ? body.totp.replace(/\s/g, '') : ''

  if (!password && !totp) {
    return NextResponse.json({ error: 'Provide your password or a TOTP code.' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { password: true, twoFactorEnabled: true, twoFactorSecret: true },
  })
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // TOTP first when offered — it is the stronger factor, and an account with
  // 2FA on should not be downgradable to password-only.
  let verified = false
  let usedFactor: 'totp' | 'password' | null = null

  if (totp && user.twoFactorEnabled && user.twoFactorSecret) {
    verified = verifyTOTP(user.twoFactorSecret, totp)
    usedFactor = 'totp'
  } else if (password && user.password) {
    verified = await verifyPassword(password, user.password)
    usedFactor = 'password'
  }

  if (!verified) {
    const attempts = registerFailure(identity.userId)
    await recordSecurityEvent({
      kind: 'auth_anomaly',
      severity: attempts >= MAX_ATTEMPTS ? 'high' : 'warn',
      userId: identity.userId,
      userEmail: identity.userEmail,
      ip: request.headers.get('x-forwarded-for'),
      summary: `Failed admin step-up (${usedFactor ?? 'no usable factor'}) — attempt ${attempts}/${MAX_ATTEMPTS}`,
      detail: { factor: usedFactor, attempts },
    }).catch(() => {})

    // No usable factor at all is a configuration problem, not a wrong secret —
    // say so, otherwise the founder retypes a correct password forever.
    if (!usedFactor) {
      return NextResponse.json(
        {
          error: 'This account has no password or TOTP configured, so admin changes cannot be confirmed. Set one up first.',
          code: 'SUDO_NO_FACTOR',
        },
        { status: 400 },
      )
    }

    const response = NextResponse.json(
      { error: usedFactor === 'totp' ? 'That TOTP code is not valid.' : 'That password is not correct.' },
      { status: 401 },
    )
    clearAdminSudoCookie(response)
    return response
  }

  const minted = mintAdminSudoToken(identity.userId)
  if (!minted) {
    return NextResponse.json(
      { error: 'Server misconfiguration: no signing secret available for admin step-up.' },
      { status: 503 },
    )
  }

  _attempts.delete(identity.userId)

  await prisma.auditLog.create({
    data: {
      action: 'ADMIN_STEP_UP_GRANTED',
      type: 'admin',
      userId: identity.userId,
      userEmail: identity.userEmail,
      details: `Admin sudo granted via ${usedFactor} for ${ADMIN_SUDO_TTL_SEC / 60} minutes`,
    },
  }).catch(() => {})

  const response = NextResponse.json({
    ok: true,
    expiresAt: minted.expiresAt.toISOString(),
    ttlSeconds: ADMIN_SUDO_TTL_SEC,
    factor: usedFactor,
  })
  setAdminSudoCookie(response, minted.token)
  return response
}

export async function DELETE(request: NextRequest) {
  const founder = await resolveFounder(request)
  if (founder instanceof NextResponse) return founder

  const response = NextResponse.json({ ok: true })
  clearAdminSudoCookie(response)
  return response
}
