export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/2fa/backup-codes
 *
 * Regenerates backup codes for the authenticated user.
 * Old backup codes are invalidated. Requires TOTP to confirm.
 *
 * Body: { code: string }  — current TOTP code to authenticate the action
 *
 * GET /api/auth/2fa/backup-codes
 * Returns how many unused backup codes remain (count only, not the codes themselves).
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
    crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-')
  )
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request).catch(() => null)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const unusedCount = await prisma.twoFactorBackupCode.count({
    where: { userId: auth.userId, usedAt: null },
  })

  const totalCount = await prisma.twoFactorBackupCode.count({
    where: { userId: auth.userId },
  })

  return NextResponse.json({
    unusedCount,
    usedCount: totalCount - unusedCount,
    total: totalCount,
  })
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
    select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    return NextResponse.json({ error: '2FA is not enabled' }, { status: 400 })
  }

  const valid = verifyTOTP(user.twoFactorSecret, code)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 400 })
  }

  // Generate and store new backup codes
  const plaintextCodes = generateBackupCodes(8)
  const hashedCodes = await Promise.all(
    plaintextCodes.map(async (c) => ({ codeHash: await hashPassword(c) }))
  )

  await prisma.$transaction([
    prisma.twoFactorBackupCode.deleteMany({ where: { userId: user.id } }),
    prisma.twoFactorBackupCode.createMany({
      data: hashedCodes.map((h) => ({ userId: user.id, codeHash: h.codeHash })),
    }),
  ])

  return NextResponse.json({
    message: 'Backup codes regenerated. Old codes are now invalid.',
    backupCodes: plaintextCodes,
    warning: 'Store these backup codes in a safe place. They will not be shown again.',
  })
}
