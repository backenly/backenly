export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/2fa/setup
 *
 * Step 1 of TOTP 2FA enrollment.
 * Generates a new TOTP secret, stores it (unconfirmed) on the user, and returns:
 *   - secret:   raw base32 secret (for manual entry)
 *   - qrCodeUrl: data URI of the QR code the user scans in their authenticator app
 *
 * The 2FA is NOT enabled yet — call /api/auth/2fa/verify-setup to confirm.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { generateTOTPSecret, buildTOTPUri } from '@/lib/auth/totp'
import { prisma } from '@/lib/db/postgres'
import QRCode from 'qrcode'

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request).catch(() => null)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, twoFactorEnabled: true },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (user.twoFactorEnabled) {
    return NextResponse.json(
      { error: '2FA is already enabled. Disable it first before re-enrolling.' },
      { status: 409 }
    )
  }

  // Generate a fresh TOTP secret and persist it (not active until verify-setup)
  const secret = generateTOTPSecret()
  const uri = buildTOTPUri(secret, user.email)

  // Store secret on user so verify-setup can read it
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorSecret: secret },
  })

  // Generate QR code as data URI
  const qrCodeUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    width: 200,
    margin: 2,
  })

  return NextResponse.json({
    secret,
    qrCodeUrl,
    manualEntryKey: secret.replace(/=/g, ''), // Strip padding for cleaner display
  })
}
