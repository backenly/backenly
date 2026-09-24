export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { signUpSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth/password'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { ensureAuthUsersTable, buildUserInsert, isReservedTestEmail, AuthNotProvisionedError } from '@/lib/services/end-user-auth-table'
import { canAcceptNewEndUser, trackEndUserActive } from '@/lib/quota/kernel'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/auth/signup
 *
 * Registers an END USER of the project — NOT a Backenly platform developer.
 * Users are stored in the project's own workspace schema: workspace_{projectId}.users
 * Completely isolated from the Backenly platform User table.
 *
 * The users table is brought to the auth contract by `ensureAuthUsersTable`
 * before any column is referenced — both the INSERT column list and the
 * RETURNING clause are built from the live schema, so an AI-generated table
 * with a missing column (e.g. no `role`) can no longer 500 signup.
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const projectId = params.projectId

    // Throttled per IP AND per project. This surface had no rate limiting of
    // any kind: it is unauthenticated by design, because it is how a
    // customer's own users sign in, but the platform's own /api/auth/login has
    // IP brute-force protection and this had none. That left credential
    // stuffing against every end user of every project unthrottled.
    //
    // Keyed on both so one project under attack cannot lock out sign-up attempts for a
    // different project behind the same egress address.
    const ip = clientIp(request)
    const limit = await consume(
      `v1:endUserSignup:${projectId}:${ip}`,
      AUTH_LIMITS.endUserSignup.ip.limit,
      AUTH_LIMITS.endUserSignup.ip.windowMs,
    )
    if (!limit.allowed) return throttledV1Response(limit)

    // Validate project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'Project not found', 404)
    }

    // Ensure project has a jwtSecret — generate one if missing
    let jwtSecret = project.jwtSecret
    if (!jwtSecret || jwtSecret.length < 32) {
      jwtSecret = crypto.randomBytes(48).toString('hex')
      await prisma.project.update({
        where: { id: projectId },
        data: { jwtSecret },
      })
    }

    // Validate request body
    const validation = await validateRequestBody(signUpSchema, request)
    if (!validation.success) {
      return createErrorResponse(ErrorCodes.VALIDATION_ERROR, (validation as { success: false; error: string }).error, 400)
    }

    const { email, password, name } = validation.data

    // Behavioral-verifier signups use reserved `.internal` emails. They must not
    // consume the project's MAU quota or trip its cap — they are throwaway rows
    // cleaned up moments later and never shown to the developer.
    const isInternalTest = isReservedTestEmail(email)

    // Guarantee the users table satisfies the auth contract — creates it when
    // missing, self-heals a drifted one (adds `role` / `is_blocked` / a
    // password column / timestamps as needed). All additions are
    // non-destructive metadata-only operations on PG 11+.
    const schema = await ensureAuthUsersTable(projectId, { email })
    const schemaName = schema.schemaName

    // Check if user already exists in workspace schema.
    // Signup is a server-side admin operation — the user does NOT yet have a
    // session-context user id, so we run as service-role to bypass RLS that
    // would otherwise reject the SELECT/INSERT (PG 42501).
    const existing = await executeWithUserContext<any>(
      '',
      true,
      `SELECT id FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    )

    if (existing.length > 0) {
      return createErrorResponse(ErrorCodes.CONFLICT, 'An account with this email already exists', 409)
    }

    // MAU cap (Plan-driven): once this project hits its monthly-active-user
    // limit, NEW sign-ups are blocked — existing users keep working. The
    // owner is prompted (in-app) to upgrade. Fail-open inside the kernel.
    if (!isInternalTest) {
      const mau = await canAcceptNewEndUser(projectId)
      if (!mau.allowed) {
        return createErrorResponse(ErrorCodes.FORBIDDEN, mau.message ?? 'Sign-ups are temporarily unavailable for this app.', 403)
      }
    }

    const hashedPassword = await hashPassword(password)
    const displayName = name || email.split('@')[0]

    // Build a schema-tolerant INSERT: only columns that exist are referenced,
    // CHECK constraints are honoured, and RETURNING lists existing columns
    // only. `password` / `password_hash` are both supplied — the builder
    // keeps whichever the developer's table actually uses.
    const plan = await buildUserInsert(schema, {
      id: crypto.randomUUID(),
      email,
      name: displayName,
      username: email.split('@')[0],
      password: hashedPassword,
      password_hash: hashedPassword,
    })

    // INSERT under service-role so RLS policies (own_rows, public_read, etc.)
    // on the users table don't block the very first signup — the policies'
    // service-role escape hatch (current_setting('app.is_service_role')) is
    // designed exactly for this internal-platform path.
    const created = await executeWithUserContext<any>('', true, plan.sql, plan.values)

    const user = created[0]

    // Count this new end-user toward the project's MAU for the month. Verifier
    // accounts are excluded inside trackEndUserActive itself.
    trackEndUserActive(projectId, String(user.id), email).catch(() => {})

    const token = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      jwtSecret,
      { expiresIn: '7d' },
    )

    // Notify webhook subscribers that an end user signed up.
    //
    // This event is emitted HERE rather than by a database trigger, because the
    // `users` table deliberately carries none: it holds the bcrypt hash, and a
    // row-level capture would put that hash in an outbox and then in an HTTP
    // body aimed at whatever URL the operator configured. Realtime shipped
    // exactly that leak for months by broadcasting row_to_json(NEW) from this
    // table.
    //
    // So the payload is built field by field from a fixed list. `user` is
    // whatever columns the schema-tolerant INSERT returned, and spreading it
    // would silently start including any credential column a future migration
    // adds.
    import('@/lib/webhooks').then(({ triggerWebhooks }) => {
      triggerWebhooks(projectId, 'auth.user.created', {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        role: user.role ?? 'user',
        createdAt: user.created_at ?? user.createdAt ?? new Date().toISOString(),
      }).catch((err: any) =>
        console.warn('[Webhooks] auth.user.created failed (non-fatal):', err?.message)
      )
    }).catch(() => {})

    // Fire on_signup AI functions (non-blocking — never fails the signup)
    import('@/lib/services/ai-functions/executor').then(({ fireAiFunctionsOnSignup }) => {
      fireAiFunctionsOnSignup(projectId, { id: user.id, email: user.email, name: user.name }).catch(
        (err: any) => console.warn('[AiFunctions] on_signup failed (non-fatal):', err?.message)
      )
    }).catch(() => {})

    return createSuccessResponse({ user, token })
  } catch (error: any) {
    if (error instanceof AuthNotProvisionedError) {
      return createErrorResponse(error.code, error.message, 503)
    }
    console.error('Signup error:', error)
    const safe = sanitizeDiagnostic(error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      safe ? `Could not create the account — ${safe}` : 'Could not create the account.',
      500,
    )
  }
}

export const POST = recordedV1(handlePOST)
