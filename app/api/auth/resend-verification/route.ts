export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/resend-verification
 *
 * Re-sends the signup verification email to the authenticated user.
 *
 * Exists because the verification wall in the app shell is a dead end without
 * it: an account flagged untrusted at signup cannot do anything until it
 * verifies, so if the first email is lost the user has no way forward and no
 * reason to come back.
 *
 * Deliberately says nothing about whether the address is reachable. A response
 * that distinguished "sent" from "bounced" would turn this into a free mailbox
 * validity oracle for exactly the accounts most likely to be abusive.
 */

import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/postgres'
import { sendVerificationEmail } from '@/lib/auth/email'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'

export const POST = withAuth(async (request: NextRequest, { user }) => {
  const ip = clientIp(request)

  // Two buckets. The IP limit stops a script cycling accounts; the per-user
  // limit stops one account being used to pump mail at a third party, which
  // would burn the platform's sender reputation rather than theirs.
  const ipLimit = consume(
    `resend-verify:ip:${ip}`,
    AUTH_LIMITS.verifyEmail.ip.limit,
    AUTH_LIMITS.verifyEmail.ip.windowMs,
  )
  const userLimit = consume(`resend-verify:user:${user.userId}`, 3, 15 * 60_000)
  if (!ipLimit.allowed || !userLimit.allowed) {
    const retryAfter = Math.max(ipLimit.retryAfter, userLimit.retryAfter)
    return NextResponse.json(
      { error: 'Too many requests. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    )
  }

  try {
    const account = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { id: true, email: true, emailVerified: true },
    })

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    // Already verified is a success, not an error — the caller's goal is met.
    if (account.emailVerified) {
      return NextResponse.json({ ok: true, alreadyVerified: true })
    }

    const secret = process.env.JWT_SECRET
    if (!secret) {
      console.error('[resend-verification] JWT_SECRET missing — cannot mint a token')
      return NextResponse.json(
        { error: 'Verification email is temporarily unavailable.' },
        { status: 503 },
      )
    }

    const token = jwt.sign(
      { userId: account.id, email: account.email, purpose: 'email-verification' },
      secret,
      { expiresIn: '24h' },
    )
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const verifyUrl = `${appUrl}/auth/verify-email?token=${token}`

    // Hard cap so a firewalled SMTP host cannot hang the request. Port 465 is
    // blocked on this host, so mail goes out over 587 STARTTLS; a
    // misconfiguration there fails slow rather than fast.
    await Promise.race([
      sendVerificationEmail(account.email, verifyUrl),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('email_timeout')), 10_000)),
    ])

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[resend-verification] failed:', (err as Error)?.message)
    // Same shape as success. The user is told to check their inbox either way;
    // the server log is where a delivery failure is diagnosed.
    return NextResponse.json({ ok: true })
  }
})
