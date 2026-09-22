export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { logAuthEvent } from '@/lib/services/logging'
import { initializeAccountEntitlements } from '@/lib/entitlements'
import { sendVerificationEmail } from '@/lib/auth/email'
import {
  assertSignupAllowed,
  createUserClaimingSignupSlot,
  recordSecurityEvent,
  SignupSlotTakenError,
} from '@/lib/platform-controls'
import { onSignupCompleted, recordProductEvent, verifySignupChallenge } from '@/lib/platform-signals'
import {
  assertSetupTokenAdmits,
  claimAwaitsToken,
  SetupTokenError,
  setupTokenRequired,
} from '@/lib/auth/setup-token'
import { currentEdition } from '@/lib/edition'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'

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
  // Claims a self-hosted deployment. Printed by `npm run selfhost` and only
  // readable by somebody who can reach that machine, so possession of the box
  // grants the single administrator slot rather than whoever loads the page
  // first. Ignored on Cloud and on installs that configured no token.
  setupToken: z.string().max(256).optional(),
})

/**
 * GET /api/auth/register
 *
 * What a signup made right now must carry beyond an email and a password. The
 * signup page reads it to decide whether to show the setup-token field.
 *
 * When the database cannot say whether the deployment is claimed, this answers
 * from configuration alone. Showing the field to an operator who does not need
 * it costs one ignored input; hiding it from one who does is the defect this
 * exists to fix.
 */
export async function GET() {
  let required: boolean
  try {
    required = await claimAwaitsToken()
  } catch {
    required = setupTokenRequired()
  }
  return NextResponse.json({ setupTokenRequired: required })
}

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
    const ipLimit = await consume(`signup:ip:${ip}`, AUTH_LIMITS.signup.ip.limit, AUTH_LIMITS.signup.ip.windowMs)
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
    const botCheck = await verifySignupChallenge({ token: parsed.turnstileToken, ip })
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
    const untrusted = signupGuard.untrusted === true

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
    // Refused before anything is written. On a self-hosted deployment with a
    // configured token this is what stops a stranger who can reach the host
    // from taking the operator's administrator slot.
    await assertSetupTokenAdmits(parsed.setupToken)

    const now = new Date()
    const user = await createUserClaimingSignupSlot(async tx => {
      const created = await tx.user.create({
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
          signupScore: signupGuard.score ?? null,
          signupSignals: signupGuard.signals ?? [],
          signupIp: ip === 'unknown' ? null : ip,
        },
        include: {
          role: true,
        },
      })

      // Adopt THE project, in the same transaction that created the account.
      //
      // This is the second half of "one command produces a ready deployment".
      // Bootstrap creates the project before any account exists, so it starts
      // owner-less; until something adopted the operator, Project.userId stayed
      // NULL and every path keyed on ownership disagreed with every other one —
      // the dashboard listed no projects to the only account there was.
      //
      // `userId: null` in the WHERE is what makes it safe: only an unowned
      // project is ever claimed, so a later account cannot take it and two
      // requests racing cannot disagree. The database decides, once. Doing it
      // HERE rather than in a second `npm run bootstrap` is what removes the
      // hidden step.
      //
      // Single-tenant only. On Cloud, projects belong to whoever created them
      // and an unowned project is not a state that occurs.
      if (currentEdition() === 'single-tenant') {
        await tx.project.updateMany({
          where: { userId: null },
          data: { userId: created.id },
        })
      }

      return created
    })

    
    // Give the new account its entitlements. A no-op in single-tenant, where
    // they come from the edition rather than a Subscription row.
    await initializeAccountEntitlements(user.id).catch(() => {
      // Non-fatal: billing seed may not have run yet
    })

    // Tell Backenly's business machinery an account was created. Referral
    // attribution is what it does with that today. Ref comes from the form
    // body, or the backenly_ref cookie set when the visitor landed on ?ref=
    // (survives the OAuth round-trip too). A no-op in single-tenant, and the
    // seam swallows its own errors, so signup cannot fail here.
    const refCode = parsed.ref || request.cookies.get('backenly_ref')?.value || null
    await onSignupCompleted({ userId: user.id, email: user.email, provider: 'email', referralCode: refCode })

    // Track signup event (non-blocking)
    recordProductEvent({ type: 'signup', userId: user.id, metadata: { email: user.email, provider: 'email' } })

    // Create session
    const { token, refreshToken } = await createSession(user.id, user.email, user.role?.name, user.name || undefined, 'email')
    
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

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
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
    // A concurrent request won the single self-hosted account slot. The
    // transaction that raised this already rolled back, so nothing partial was
    // written and the loser simply gets the closed-registration answer.
    if (error instanceof SignupSlotTakenError) {
      return NextResponse.json({ error: error.guard.reason }, { status: error.guard.status })
    }
    // A missing or wrong setup token, or a deployment already claimed. Its
    // message is written for an operator standing at the machine and says
    // nothing useful to anybody else.
    if (error instanceof SetupTokenError) {
      return NextResponse.json(
        { error: error.message, code: 'SETUP_TOKEN_REJECTED' },
        { status: error.status }
      )
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
