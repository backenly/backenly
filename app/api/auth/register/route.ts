export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { logAuthEvent } from '@/lib/services/logging'
import { createFreeSubscription } from '@/lib/billing'
import { logEvent } from '@/lib/analytics/logger'
import { sendVerificationEmail } from '@/lib/auth/email'
import {
  assertSignupAllowed,
  createUserClaimingSignupSlot,
  recordSecurityEvent,
  SignupSlotTakenError,
} from '@/lib/platform/controls'
import { applyReferralOnSignup } from '@/lib/billing/referral'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { verifyBotChallenge } from '@/lib/trust/bot-defense'
import { z } from 'zod'
import jwt from 'jsonwebtoken'

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().optional(),
  // Referral code captured from ?ref= on the signup page (optional).
  ref: z.string().max(32).optional(),
  // Cloudflare Turnstile solve. Required once TURNSTILE_SECRET_KEY is set;
  // ignored before that so shipping this never locks real users out.
  turnstileToken: z.string().max(4096).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parsed = registerSchema.parse(body)
    const email = parsed.email.trim().toLowerCase()
    const { password, name } = parsed

    const ip = clientIp(request)

    // Rate limit before anything expensive. The policy already existed in
    // AUTH_LIMITS but this route never consumed it, so a script could register
    // unlimited accounts from one address at full speed.
    const ipLimit = consume(`signup:ip:${ip}`, AUTH_LIMITS.signup.ip.limit, AUTH_LIMITS.signup.ip.windowMs)
    if (!ipLimit.allowed) {
      await recordSecurityEvent({
        kind: 'signup_rate_limited',
        severity: 'warn',
        userEmail: email,
        ip,
        summary: `Signup rate limit tripped for ${ip}`,
        detail: { ip, email, retryAfter: ipLimit.retryAfter },
      }).catch(() => {})
      return NextResponse.json(
        { error: 'Too many sign-up attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } },
      )
    }

    // Proof of humanity. This is the control that actually stops scripted
    // signups — the domain heuristics below are a second layer, because a bot
    // operator can register a fresh domain faster than any list can grow.
    const botCheck = await verifyBotChallenge(parsed.turnstileToken, ip)
    if (!botCheck.ok) {
      await recordSecurityEvent({
        kind: 'bot_challenge_failed',
        severity: 'warn',
        userEmail: email,
        ip,
        summary: `Signup blocked — Turnstile ${botCheck.code}`,
        detail: { ip, email, code: botCheck.code },
      }).catch(() => {})
      return NextResponse.json({ error: botCheck.reason }, { status: 403 })
    }

    // Founder kill switches: signupsDisabled / maintenanceMode + blocklist,
    // plus the email trust assessment.
    const signupGuard = await assertSignupAllowed(email, ip)
    if (!signupGuard.ok) {
      return NextResponse.json({ error: signupGuard.reason }, { status: signupGuard.status })
    }
    const untrusted = signupGuard.trust?.verdict === 'challenge'

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
    //
    // Wrapped so a self-hosted deployment's single account slot is claimed
    // atomically. assertSignupAllowed above is a pre-flight, fifty lines back;
    // relying on it alone lets two concurrent first signups both read zero
    // accounts and both succeed, which is exactly the state a single-operator
    // install must not reach. On Cloud this takes no lock and inserts directly.
    const now = new Date()
    const user = await createUserClaimingSignupSlot(tx =>
      tx.user.create({
        data: {
          email,
          name: name || null,
          password: hashedPassword,
          provider: 'email',
          emailVerified: false,
          roleId: defaultRole.id,
          lastLogin: now,
          lastActiveAt: now,
          trustLevel: untrusted ? 'untrusted' : 'trusted',
          signupScore: signupGuard.trust?.score ?? null,
          signupSignals: signupGuard.trust?.signals ?? [],
          signupIp: ip === 'unknown' ? null : ip,
        },
        include: {
          role: true,
        },
      })
    )

    
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
    // A concurrent request won the single self-hosted account slot. The
    // transaction that raised this already rolled back, so nothing partial was
    // written and the loser simply gets the closed-registration answer.
    if (error instanceof SignupSlotTakenError) {
      return NextResponse.json({ error: error.guard.reason }, { status: error.guard.status })
    }
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
