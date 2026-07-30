export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/postgres'

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json()

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Verification token is required' }, { status: 400 })
    }

    const secret = process.env.JWT_SECRET
    if (!secret) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
    }

    let payload: { userId: string; email: string; purpose: string }
    try {
      payload = jwt.verify(token, secret) as any
    } catch {
      return NextResponse.json({ error: 'Invalid or expired verification link' }, { status: 400 })
    }

    if (payload.purpose !== 'email-verification') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (user.emailVerified) {
      return NextResponse.json({ message: 'Email already verified', emailVerified: true })
    }

    // Proving control of the mailbox both verifies the address and clears an
    // `untrusted` standing set at signup — so a real person caught by a
    // heuristic unblocks themselves in one click, with no support round-trip.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        ...(user.trustLevel === 'untrusted' ? { trustLevel: 'trusted' } : {}),
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'Email verified',
        type: 'ui',
        userId: user.id,
        userEmail: user.email,
        details: 'User verified their email address via link',
      },
    })

    return NextResponse.json({ message: 'Email verified successfully', emailVerified: true })
  } catch (error) {
    console.error('Email verification error:', error)
    return NextResponse.json({ error: 'Failed to verify email' }, { status: 500 })
  }
}
