export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { logAuthEvent } from '@/lib/services/logging'
import { createFreeSubscription } from '@/lib/billing'
import { logEvent } from '@/lib/analytics/logger'
import { sendVerificationEmail } from '@/lib/auth/email'
import { assertSignupAllowed } from '@/lib/platform/controls'
import { applyReferralOnSignup } from '@/lib/billing/referral'
import { z } from 'zod'
import jwt from 'jsonwebtoken'

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().optional(),
  // Referral code captured from ?ref= on the signup page (optional).
  ref: z.string().max(32).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parsed = registerSchema.parse(body)
    const email = parsed.email.trim().toLowerCase()
    const { password, name } = parsed

    // Founder kill switches: signupsDisabled / maintenanceMode + blocklist.
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null
    const signupGuard = await assertSignupAllowed(email, ip)
    if (!signupGuard.ok) {
      return NextResponse.json({ error: signupGuard.reason }, { status: signupGuard.status })
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password)
    if (!passwordValidation.valid) {
      return NextResponse.json(
        { error: passwordValidation.message },
        { status: 400 }
      )
    }
    
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    })
    
    if (existingUser) {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 400 }
      )
    }
    
    // Hash password
    const hashedPassword = await hashPassword(password)
    
    // Get default role (Developer) or create if doesn't exist
    // Since roles can be global (projectId: null) or project-scoped, we look for a global Developer role
    // Note: Compound unique constraints don't support null, so we use findFirst for global roles
    let defaultRole = await prisma.role.findFirst({
      where: {
        name: 'Developer',
        projectId: null, // Global role
      },
    })
    
    if (!defaultRole) {
      defaultRole = await prisma.role.create({
        data: {
          name: 'Developer',
          description: 'Can read and write data, deploy functions',
          permissions: ['read', 'write', 'deploy'],
          projectId: null, // Global role, not project-scoped
        },
      })
    }
    
    // Create user — signup is also a session start, so seed both timestamps.
    const now = new Date()
    const user = await prisma.user.create({
      data: {
        email,
        name: name || null,
        password: hashedPassword,
        provider: 'email',
        emailVerified: false,
        roleId: defaultRole.id,
        lastLogin: now,
        lastActiveAt: now,
      },
      include: {
        role: true,
      },
    })
    
    // Create free subscription
    await createFreeSubscription(user.id).catch(() => {
      // Non-fatal: billing seed may not have run yet
    })

    // Referral attribution + signup bonus. Ref comes from the form body, or the
    // backenly_ref cookie set when the visitor landed on ?ref= (survives the
    // OAuth round-trip too). Fully non-fatal — never breaks signup.
    const refCode = parsed.ref || request.cookies.get('backenly_ref')?.value || null
    await applyReferralOnSignup(user.id, user.email, refCode).catch(() => {})

    // Track signup event (non-blocking)
    logEvent('signup', user.id, undefined, { email: user.email, provider: 'email' })

    // Create session
    const { token } = await createSession(user.id, user.email, user.role?.name, user.name || undefined, 'email')
    
    // Create audit log
    await prisma.auditLog.create({
      data: {
        action: 'User registered',
        type: 'ui',
        userId: user.id,
        userEmail: user.email,
        details: `New user registered with email: ${user.email}`,
      },
    })

    // Log auth event
    await logAuthEvent({
      event: 'register',
      userId: user.id,
      success: true,
      metadata: { email: user.email, provider: 'email' },
    })

    // Fire-and-forget: truly non-blocking — never delay the response for email
    const secret = process.env.JWT_SECRET
    if (secret) {
      const verifyToken = jwt.sign(
        { userId: user.id, email: user.email, purpose: 'email-verification' },
        secret,
        { expiresIn: '24h' }
      )
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      const verifyUrl = `${appUrl}/auth/verify-email?token=${verifyToken}`
      // 10 s hard cap so a firewalled SMTP host never blocks the HTTP response
      Promise.race([
        sendVerificationEmail(user.email, verifyUrl),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('email_timeout')), 10_000)),
      ]).catch(() => { /* Non-fatal */ })
    }

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        role: user.role?.name,
      },
      token,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Failed to register user' },
      { status: 500 }
    )
  }
}
