export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
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

/**
 * POST /v1/{projectId}/auth/signin
 *
 * Authenticates an END USER of the project — NOT a Backenly platform developer.
 * Reads from workspace_{projectId}.users — isolated from the platform User table.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const projectId = params.projectId

    // Throttled per IP AND per project. This surface had no rate limiting of
    // any kind: it is unauthenticated by design, because it is how a
    // customer's own users sign in, but the platform's own /api/auth/login has
    // IP brute-force protection and this had none. That left credential
    // stuffing against every end user of every project unthrottled.
    //
    // Keyed on both so one project under attack cannot lock out sign-in attempts for a
    // different project behind the same egress address.
    const ip = clientIp(request)
    const limit = await consume(
      `v1:endUserSignin:${projectId}:${ip}`,
      AUTH_LIMITS.endUserSignin.ip.limit,
      AUTH_LIMITS.endUserSignin.ip.windowMs,
    )
    if (!limit.allowed) return throttledV1Response(limit)

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

    // A SECOND budget, keyed on the identity being guessed.
    //
    // The per-IP limit above is weak against distributed credential stuffing:
    // a botnet spends one attempt per address and never trips it. Keying on
    // project + normalised email means a single account cannot be hammered
    // from many sources either. The platform's own login has account lockout
    // for the same reason; this is its end-user equivalent.
    //
    // Normalised, so `Alice@x.com` and `alice@x.com` share one budget rather
    // than doubling it.
    const identityLimit = await consume(
      `v1:endUserSignin:${projectId}:${String(email).trim().toLowerCase()}`,
      AUTH_LIMITS.endUserSignin.ip.limit,
      AUTH_LIMITS.endUserSignin.ip.windowMs,
    )
    // Deliberately the same answer as an IP trip, and the same shape as a
    // wrong password: a different response here would confirm the address
    // exists and is being defended.
    if (!identityLimit.allowed) return throttledV1Response(identityLimit)
    const schemaName = `workspace_${projectId}`

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
       AND column_name IN ('role', 'is_blocked')`,
      schemaName
    )
    const optCols = new Set(optColRows.map(r => r.column_name))
    const selectCols = ['id', 'email', `"${pwCol}"`, 'name', ...(optCols.has('role') ? ['"role"'] : []), ...(optCols.has('is_blocked') ? ['"is_blocked"'] : [])].join(', ')

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

    const token = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret),
      { expiresIn: '7d' },
    )

    // Count this end-user as active for the month (MAU tracking — never blocks).
    trackEndUserActive(projectId, String(user.id), user.email).catch(() => {})
    // Stamp last_login so the Auth dashboard's "active · 30d" metric is real.
    stampLastLogin(projectId, user.id).catch(() => {})

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
