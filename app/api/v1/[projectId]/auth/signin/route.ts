export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { clientIp } from '@/lib/security/auth-rate-limit'
import { admitSigninAttempt, admitSigninRequest } from '@/lib/security/end-user-signin-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { carriesInternalToken, isPlatformProbe } from '@/lib/security/platform-probe'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { signInSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { verifyPassword, verifyPasswordAgainstDecoy } from '@/lib/auth/password'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { stampLastLogin } from '@/lib/services/end-user-auth-table'
import { trackEndUserActive } from '@/lib/quota/kernel'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import jwt from 'jsonwebtoken'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { endUserTokenSecret, endUserTokenClaims, type AuthEnvironment } from '@/lib/branches/auth-environment'
import { inAuthEnvironment } from '@/lib/branches/next-auth-environment'

/**
 * POST /v1/{projectId}/auth/signin
 *
 * Authenticates an END USER of the project — NOT a Backenly platform developer.
 * Reads from workspace_{projectId}.users — isolated from the platform User table.
 * With a preview branch's key it reads the branch's `users` and issues a token
 * only that branch accepts (lib/branches/auth-environment.ts).
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params
  return inAuthEnvironment(request, projectId, (env) => signIn(request, projectId, env))
}

async function signIn(request: NextRequest, projectId: string, env: AuthEnvironment): Promise<Response> {
  try {

    // Throttled per project, on FAILED attempts per address and per account,
    // under a ceiling on all attempts per address. Successful sign-ins are
    // never what runs a budget out: lib/security/end-user-signin-limit.ts has
    // what counting them did to real users.
    const ip = clientIp(request)
    // Backenly's own contract probe is not counted (lib/security/platform-probe.ts),
    // and whether a request is the probe depends on the address in its body. So a
    // request carrying the internal-traffic token is counted once that address is
    // known, below; every other request is counted here, before anything else.
    const mayBeProbe = carriesInternalToken(request)
    if (!mayBeProbe) {
      const limit = await admitSigninRequest(projectId, ip)
      if (!limit.allowed) return throttledV1Response(limit)
    }

    // Validate project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'Project not found', 404)
    }

    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      return createErrorResponse(
        ErrorCodes.NOT_FOUND,
        'Authentication is not configured for this project.',
        503
      )
    }

    // Validate request body
    const validation = await validateRequestBody(signInSchema, request)
    if (!validation.success) {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, (validation as { success: false; error: string }).error, 400)
    }

    const { email, password } = validation.data

    const probe = mayBeProbe && isPlatformProbe(request, email)
    if (mayBeProbe && !probe) {
      const limit = await admitSigninRequest(projectId, ip)
      if (!limit.allowed) return throttledV1Response(limit)
    }

    // The failure budgets, per address and per account. The account one is
    // what stops distributed stuffing: a botnet spends one attempt per address
    // and never trips a per-address limit, but every guess at one account
    // lands in the same bucket.
    //
    // Spent now and refunded once the password proves correct, below. Keyed on
    // the address as typed (normalised), never on whether it exists: a
    // different answer for real accounts would confirm which ones are real.
    const attempt = probe ? null : await admitSigninAttempt(projectId, ip, email)
    if (attempt?.denied) return throttledV1Response(attempt.denied)
    const schemaName = env.schemaName

    // Check if users table exists
    const tableCheck = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'users'
      ) AS exists`,
      schemaName
    )

    if (!tableCheck[0]?.exists) {
      return createErrorResponse(
        ErrorCodes.NOT_FOUND,
        'Authentication is not enabled for this project.',
        404
      )
    }

    // Detect which column stores the password hash — some schemas use 'password', others 'password_hash'
    const pwColRows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'
       AND column_name IN ('password', 'password_hash') LIMIT 1`,
      schemaName
    )
    const pwCol = pwColRows[0]?.column_name ?? 'password'

    // Detect optional columns
    const optColRows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users'
       AND column_name IN ('role', 'is_blocked', 'email_verified')`,
      schemaName
    )
    const optCols = new Set(optColRows.map(r => r.column_name))
    const selectCols = ['id', 'email', `"${pwCol}"`, 'name', ...(optCols.has('role') ? ['"role"'] : []), ...(optCols.has('is_blocked') ? ['"is_blocked"'] : []), ...(optCols.has('email_verified') ? ['"email_verified"'] : [])].join(', ')

    // Sign-in must read the users row to verify the password hash. At this
    // moment the caller has no session-context user id yet, so RLS would
    // hide the row. Run as service-role — sign-in is a platform-internal
    // privileged operation, exactly what the service-role escape hatch is for.
    const users = await executeWithUserContext<any>(
      '',
      true,
      `SELECT ${selectCols} FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    )

    const user = users[0]
    const storedHash: string | undefined = user
      ? (user[pwCol] ?? user.password ?? user.password_hash)
      : undefined

    // ── Both paths cost the same ────────────────────────────────────────────
    //
    // The message for an unknown address and a wrong password was already
    // identical, and the TIMING was not: a missing user returned immediately
    // while a real one paid for a bcrypt comparison first. bcrypt is tuned to
    // be slow, so that gap is tens of milliseconds and trivially measurable
    // over a few samples. It is a working account-enumeration oracle wearing
    // the right error message.
    //
    // So an absent user is compared against a decoy hash generated at the same
    // cost factor the product issues. The comparison cannot succeed and its
    // result is discarded; the only thing wanted is the work.
    const isValid = storedHash
      ? await verifyPassword(password, storedHash)
      : await verifyPasswordAgainstDecoy(password)

    if (!isValid) {
      return createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid email or password', 401)
    }

    // The password is right, so this attempt was not a guess: it gives back
    // what it drew from the failure budgets. Before the suspension and
    // verification answers, which refuse someone who knows the password.
    await attempt?.credentialsVerified()

    // ── Suspension is disclosed only to someone who proved the password ─────
    //
    // This check used to run BEFORE the password was verified, so anyone could
    // submit any address with a junk password and learn from the 403 both that
    // the account exists and that it is suspended. That is enumeration with no
    // credential at all, and it undid the matched messages above.
    //
    // After verification, the only caller who can see it is the account holder,
    // who is entitled to know why they cannot get in.
    if (user.is_blocked) {
      return createErrorResponse(ErrorCodes.FORBIDDEN, 'This account has been suspended.', 403)
    }

    // Email-verification gate — opt-in via ProjectAuthConfig. Only blocks when
    // the column exists AND is explicitly false, so legacy users tables
    // without the column are unaffected. Not on a preview branch, which cannot
    // send the verification email whose link would lift it.
    if (user.email_verified === false && !env.branch) {
      const { getAuthEmailContext } = await import('@/lib/services/end-user-auth-email')
      const emailCtx = await getAuthEmailContext(projectId)
      if (emailCtx.requireEmailVerification) {
        return createErrorResponse(
          ErrorCodes.FORBIDDEN,
          'Please verify your email before signing in. Check your inbox for the verification link.',
          403,
          { reason: 'EMAIL_NOT_VERIFIED' },
        )
      }
    }

    const token = jwt.sign(
      {
        userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID(),
        ...endUserTokenClaims(env.branch),
      },
      endUserTokenSecret(resolveJwtSecret(project.jwtSecret), env.branch),
      { expiresIn: '7d' },
    )

    // Count this end-user as active for the month (MAU tracking — never blocks).
    // A preview branch's test users are not the month's active users.
    if (!env.branch) trackEndUserActive(projectId, String(user.id), user.email).catch(() => {})
    // Stamp last_login so the Auth dashboard's "active · 30d" metric is real.
    stampLastLogin(projectId, user.id, schemaName).catch(() => {})

    return createSuccessResponse({
      user: { id: user.id, email: user.email, name: user.name, role: user.role ?? 'user' },
      token,
    })
  } catch (error: any) {
    console.error('Signin error:', error)
    const safe = sanitizeDiagnostic(error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      safe ? `Could not sign in — ${safe}` : 'Could not sign in.',
      500,
    )
  }
}

export const POST = recordedV1(handlePOST)
