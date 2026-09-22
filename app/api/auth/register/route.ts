export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password'
import { sendAccountExistsEmail, sendSignupCodeEmail } from '@/lib/auth/email'
import {
  assertSignupAllowed,
  recordSecurityEvent,
  SignupSlotTakenError,
} from '@/lib/platform-controls'
import { verifySignupChallenge } from '@/lib/platform-signals'
import {
  assertSetupTokenAdmits,
  claimAwaitsToken,
  deploymentIsClaimed,
  SetupTokenError,
  setupTokenRequired,
} from '@/lib/auth/setup-token'
import { currentEdition } from '@/lib/edition'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import {
  EMAIL_CODE_TTL_MS,
  issueEmailCode,
  normalizeEmail,
  throttleEmailCodeSend,
} from '@/lib/auth/email-code'
import {
  deliverPlatformEmail,
  EmailDeliveryUnavailableError,
  emailUnavailableBody,
  platformEmailConfigured,
} from '@/lib/email/platform-delivery'
import { signupVerificationPolicy } from '@/lib/auth/signup/policy'
import { AccountAlreadyExistsError, completeEmailSignup } from '@/lib/auth/signup/complete-email-signup'
import type { PendingSignup } from '@/lib/auth/signup/pending'
import type { Prisma } from '@prisma/client'

import { z } from 'zod'

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
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

/**
 * POST /api/auth/register
 *
 * Every gate runs here, once. Then either the account is created now (the
 * first operator of a self-hosted install) or a code is mailed and the account
 * is created by POST /api/auth/register/verify once the code is proven. No
 * account and no session exist for an address nobody has proven.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parsed = registerSchema.parse(body)
    const email = normalizeEmail(parsed.email)
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

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password)
    if (!passwordValidation.valid) {
      return NextResponse.json(
        { error: passwordValidation.message },
        { status: 400 }
      )
    }

    // Refused before anything is written, and before any code is mailed. On a
    // self-hosted deployment with a configured token this is what stops a
    // stranger who can reach the host from taking the operator's
    // administrator slot.
    await assertSetupTokenAdmits(parsed.setupToken)

    const edition = currentEdition()
    const verification = signupVerificationPolicy({
      edition,
      isFirstAccount: edition === 'single-tenant' ? !(await deploymentIsClaimed()) : false,
      // True only when a token is configured, and `assertSetupTokenAdmits`
      // above has already refused anyone who did not present it. That is what
      // makes skipping the code a claim by the operator of the machine rather
      // than by whoever reached an empty deployment first.
      claimGatedBySetupToken: setupTokenRequired(),
      mailConfigured: platformEmailConfigured(),
    })

    // No transport, and this signup must prove its address. Refused, and said
    // so, rather than creating an account nobody verified or telling someone
    // to wait for a code that is never coming.
    if (verification === 'refuse_no_mail') {
      return NextResponse.json(emailUnavailableBody('not_configured'), { status: 503 })
    }

    // A first account on an install that configured neither a setup token nor
    // SMTP. Nothing here can tell the operator apart from a passer-by, and the
    // single administrator slot is not something to hand out on first come.
    if (verification === 'refuse_unprotected_claim') {
      return NextResponse.json(
        {
          error:
            'This deployment cannot admit its first account yet: it has no setup token and no email configured, ' +
            'so nothing can prove who you are. Set BACKENLY_SETUP_TOKEN in .env (npm run selfhost prints one) ' +
            'and restart, or configure SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM to verify by email.',
          code: 'CLAIM_NOT_PROTECTED',
        },
        { status: 503 },
      )
    }

    // Hashed before the branch below so that an address with an account and
    // one without cost the same, and nothing downstream sees the plaintext.
    const passwordHash = await hashPassword(password)
    const referralCode = parsed.ref || request.cookies.get('backenly_ref')?.value || null

    const pending: PendingSignup = {
      passwordHash,
      name: name || null,
      referralCode,
      untrusted: signupGuard.untrusted === true,
      score: signupGuard.score ?? null,
      signals: signupGuard.signals ?? [],
      ip,
    }

    // The operator claiming their own self-hosted install. Possession of the
    // machine is the proof, and most installs have no mail transport yet.
    if (verification === 'skip') {
      return await completeEmailSignup({ email, ...pending, emailVerified: false })
    }

    // Everything else proves the address first.
    const throttle = await throttleEmailCodeSend('signup', email)
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: 'A code was sent to this address moments ago. Wait a minute before asking for another.' },
        { status: 429, headers: { 'Retry-After': String(throttle.retryAfter) } },
      )
    }

    // An address that already has an account gets a note saying so instead of
    // a code, and the page answers exactly as it does for a new address. This
    // route used to answer "User with this email already exists", which let
    // anyone test which addresses have Backenly accounts.
    //
    // Unlike forgot-password, this one may report a delivery failure: BOTH
    // branches send a message, so a broken transport fails both identically
    // and the failure says nothing about which addresses have accounts. There
    // is also no account to protect yet if the address is new.
    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    })

    try {
      if (existing) {
        await deliverPlatformEmail(email, () => sendAccountExistsEmail(email))
      } else {
        const { code } = await issueEmailCode('signup', email, pending as unknown as Prisma.InputJsonValue)
        await deliverPlatformEmail(email, () => sendSignupCodeEmail(email, code))
      }
    } catch (error) {
      if (error instanceof EmailDeliveryUnavailableError) {
        return NextResponse.json(emailUnavailableBody('failed'), { status: 503 })
      }
      throw error
    }

    return NextResponse.json({
      status: 'verification_required',
      email,
      expiresInSec: Math.round(EMAIL_CODE_TTL_MS / 1000),
      resendAfterSec: Math.round(AUTH_LIMITS.emailCode.send.cooldown.windowMs / 1000),
    })
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
    if (error instanceof AccountAlreadyExistsError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
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
