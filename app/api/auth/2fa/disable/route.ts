export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/2fa/disable
 *
 * Disables 2FA on the authenticated user's account.
 * Requires either a valid TOTP code or a backup code to confirm intent.
 *
 * Body: { code: string }  — TOTP code or backup code
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { verifyTOTP } from '@/lib/auth/totp'
import { verifyPassword } from '@/lib/auth/password'
import { prisma } from '@/lib/db/postgres'
import { z } from 'zod'

const schema = z.object({
  code: z.string().min(1, 'Verification code is required'),
})

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
    select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!user.twoFactorEnabled) {
    return NextResponse.json({ error: '2FA is not currently enabled' }, { status: 400 })
  }

  // Verify TOTP code
  let codeValid = user.twoFactorSecret ? verifyTOTP(user.twoFactorSecret, code) : false

  // If TOTP fails, check backup codes
  if (!codeValid) {
    const backupCodes = await prisma.twoFactorBackupCode.findMany({
      where: { userId: user.id, usedAt: null },
    })

    for (const bc of backupCodes) {
      if (await verifyPassword(code, bc.codeHash)) {
        codeValid = true
        break
      }
    }
  }

  if (!codeValid) {
    return NextResponse.json(
      { error: 'Invalid verification code' },
      { status: 400 }
    )
  }

  // Disable 2FA and purge backup codes
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    }),
    prisma.twoFactorBackupCode.deleteMany({ where: { userId: user.id } }),
  ])

  return NextResponse.json({ message: '2FA has been disabled successfully.' })
}
