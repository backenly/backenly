export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/2fa/verify-setup
 *
 * Step 2 of TOTP 2FA enrollment.
 * The user provides a TOTP code from their authenticator app.
 * If valid, 2FA is enabled and 8 backup codes are returned (shown only once).
 *
 * Body: { code: string }  — 6-digit TOTP code
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { verifyTOTP } from '@/lib/auth/totp'
import { hashPassword } from '@/lib/auth/password'
import { prisma } from '@/lib/db/postgres'
import crypto from 'crypto'
import { z } from 'zod'

const schema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
})

function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    // Format: XXXX-XXXX (8 hex chars split for readability)
    crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-')
  )
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request).catch(() => null)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parse = schema.safeParse(body)
  if (!parse.success) {
    return NextResponse.json({ error: parse.error.errors[0].message }, { status: 400 })
  }
  const { code } = parse.data

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, twoFactorSecret: true, twoFactorEnabled: true },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (user.twoFactorEnabled) {
    return NextResponse.json({ error: '2FA is already enabled' }, { status: 409 })
  }

  if (!user.twoFactorSecret) {
    return NextResponse.json(
      { error: 'No pending 2FA setup. Call /api/auth/2fa/setup first.' },
      { status: 400 }
    )
  }

  // Verify the TOTP code against the stored (unconfirmed) secret
  const valid = verifyTOTP(user.twoFactorSecret, code)
  if (!valid) {
    return NextResponse.json(
      { error: 'Invalid verification code. Make sure your device clock is synchronized.' },
      { status: 400 }
    )
  }

  // Generate backup codes
  const plaintextCodes = generateBackupCodes(8)

  // Hash each backup code before storing (same approach as passwords)
  const hashedCodes = await Promise.all(
    plaintextCodes.map(async (c) => ({ codeHash: await hashPassword(c) }))
  )

  // Enable 2FA and store backup codes atomically
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true },
    }),
    // Remove any old backup codes
    prisma.twoFactorBackupCode.deleteMany({ where: { userId: user.id } }),
    // Insert new backup codes
    prisma.twoFactorBackupCode.createMany({
      data: hashedCodes.map((h) => ({ userId: user.id, codeHash: h.codeHash })),
    }),
  ])

  return NextResponse.json({
    message: '2FA has been enabled successfully.',
    backupCodes: plaintextCodes,
    warning: 'Store these backup codes in a safe place. They will not be shown again.',
  })
}
