/**
 * TURNING AN ADMITTED EMAIL SIGNUP INTO AN ACCOUNT
 * ================================================
 * The second half of email signup, shared by the two ways an account comes to
 * exist:
 *
 *   - immediately, for the first operator of a self-hosted install
 *     (POST /api/auth/register), and
 *   - once the emailed code is proven (POST /api/auth/register/verify).
 *
 * Moved here from the register route unchanged in substance. Everything
 * before this point (rate limits, Turnstile, admission, password strength, the
 * setup token) has already happened, and happens once, in the register route.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { createSession } from '@/lib/auth/session'
import { logAuthEvent } from '@/lib/services/logging'
import { initializeAccountEntitlements } from '@/lib/entitlements'
import { createUserClaimingSignupSlot } from '@/lib/platform-controls'
import { onSignupCompleted, recordProductEvent } from '@/lib/platform-signals'
import { currentEdition } from '@/lib/edition'

export interface EmailSignup {
  email: string
  name: string | null
  /** bcrypt, from lib/auth/password. The plaintext never reaches this module. */
  passwordHash: string
  referralCode: string | null
  /** The admission verdict: Cloud's email trust said "challenge". */
  untrusted: boolean
  score: number | null
  signals: string[]
  ip: string
  /** True when the address was proven with an emailed code. */
  emailVerified: boolean
}

/** The address gained an account between the code being sent and being entered. */
export class AccountAlreadyExistsError extends Error {
  constructor() {
    super('An account with this email already exists. Sign in instead.')
    this.name = 'AccountAlreadyExistsError'
  }
}

/**
 * Create the account, its session and cookies, and the response carrying them.
 *
 * Throws `SignupSlotTakenError` when a concurrent request took a self-hosted
 * deployment's single slot, and `AccountAlreadyExistsError` when the address
 * was registered meanwhile (an OAuth signup, or a second tab). Both roll back
 * before anything is written.
 */
export async function completeEmailSignup(input: EmailSignup): Promise<NextResponse> {
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

  // Proving the address is what the "challenge" verdict asked for, so a
  // verified signup is trusted, exactly as /api/auth/verify-email upgrades an
  // account on the link path.
  const trustLevel = input.emailVerified || !input.untrusted ? 'trusted' : 'untrusted'

  // Create user — signup is also a session start, so seed both timestamps.
  //
  // Wrapped so a self-hosted deployment's single account slot is claimed
  // atomically. assertSignupAllowed in the route is a pre-flight; relying on
  // it alone lets two concurrent first signups both read zero accounts and
  // both succeed, which is exactly the state a single-operator install must
  // not reach. On Cloud this takes no lock and inserts directly.
  const now = new Date()
  let user
  try {
    user = await createUserClaimingSignupSlot(async tx => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          password: input.passwordHash,
          provider: 'email',
          emailVerified: input.emailVerified,
          roleId: defaultRole.id,
          lastLogin: now,
          lastActiveAt: now,
          trustLevel,
          signupScore: input.score,
          signupSignals: input.signals,
          signupIp: input.ip === 'unknown' ? null : input.ip,
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
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') throw new AccountAlreadyExistsError()
    throw error
  }

  // Give the new account its entitlements. A no-op in single-tenant, where
  // they come from the edition rather than a Subscription row.
  await initializeAccountEntitlements(user.id).catch(() => {
    // Non-fatal: billing seed may not have run yet
  })

  // Tell Backenly's business machinery an account was created. Referral
  // attribution is what it does with that today. A no-op in single-tenant, and
  // the seam swallows its own errors, so signup cannot fail here.
  await onSignupCompleted({ userId: user.id, email: user.email, provider: 'email', referralCode: input.referralCode })

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
      details: input.emailVerified
        ? `New user registered with email: ${user.email} (address proven with an emailed code)`
        : `New user registered with email: ${user.email}`,
    },
  })

  // Log auth event
  await logAuthEvent({
    event: 'register',
    userId: user.id,
    success: true,
    metadata: { email: user.email, provider: 'email', emailVerified: input.emailVerified },
  })

  const response = NextResponse.json({
    status: 'created',
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
}
