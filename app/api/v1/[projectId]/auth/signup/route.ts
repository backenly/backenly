export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { clientIp } from '@/lib/security/auth-rate-limit'
import { admitExistenceCheck, admitSignupRequest } from '@/lib/security/end-user-signup-limit'
import { throttledV1Response } from '@/lib/security/rate-limit-response'
import { carriesInternalToken, isPlatformProbe } from '@/lib/security/platform-probe'
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
import { emitEndUserCreated } from '@/lib/services/end-user-auth-events'
import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'
import { ensureEmailVerifiedColumn, requestEmailVerification } from '@/lib/services/end-user-auth-flows'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import {
  endUserTokenSecret,
  endUserTokenClaims,
  SKIPPED_ON_BRANCH_SIGNUP,
  type AuthEnvironment,
} from '@/lib/branches/auth-environment'
import { inAuthEnvironment } from '@/lib/branches/next-auth-environment'

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
 *
 * A request that presents a preview branch's key signs the user up on that
 * branch instead: its own `users` table, a token only that branch accepts, and
 * none of production's side effects (lib/branches/auth-environment.ts).
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params
  return inAuthEnvironment(request, projectId, (env) => signUp(request, projectId, env))
}

async function signUp(request: NextRequest, projectId: string, env: AuthEnvironment): Promise<Response> {
  try {
    // Throttled per project and address: every attempt under one cap, and the
    // "already registered" answer under a much tighter one, because it is the
    // existence oracle (lib/security/end-user-signup-limit.ts).
    const ip = clientIp(request)
    // Backenly's own contract probe is not counted (lib/security/platform-probe.ts),
    // and whether a request is the probe depends on the address in its body. So a
    // request carrying the internal-traffic token is counted once that address is
    // known, below; every other request is counted here, before anything else.
    const mayBeProbe = carriesInternalToken(request)
    if (!mayBeProbe) {
      const limit = await admitSignupRequest(projectId, ip)
      if (!limit.allowed) return throttledV1Response(limit)
    }

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

    const probe = mayBeProbe && isPlatformProbe(request, email)
    if (mayBeProbe && !probe) {
      const limit = await admitSignupRequest(projectId, ip)
      if (!limit.allowed) return throttledV1Response(limit)
    }

    // Behavioral-verifier signups use reserved `.internal` emails. They must not
    // consume the project's MAU quota or trip its cap — they are throwaway rows
    // cleaned up moments later and never shown to the developer.
    const isInternalTest = isReservedTestEmail(email)

    // Guarantee the users table satisfies the auth contract — creates it when
    // missing, self-heals a drifted one (adds `role` / `is_blocked` / a
    // password column / timestamps as needed). All additions are
    // non-destructive metadata-only operations on PG 11+. On a preview branch
    // it is the branch's own `users` table.
    const schema = await ensureAuthUsersTable(projectId, { email }, env.schemaName)
    const schemaName = schema.schemaName

    // Check if user already exists in workspace schema.
    // Signup is a server-side admin operation — the user does NOT yet have a
    // session-context user id, so we run as service-role to bypass RLS that
    // would otherwise reject the SELECT/INSERT (PG 42501).
    //
    // The answer is the existence oracle, so it is budgeted before it is looked
    // up, and given back when the address turns out to be free.
    const check = probe ? null : await admitExistenceCheck(projectId, ip)
    if (check?.denied) return throttledV1Response(check.denied)
    const existing = await executeWithUserContext<any>(
      '',
      true,
      `SELECT id FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    )

    if (existing.length > 0) {
      return createErrorResponse(ErrorCodes.CONFLICT, 'An account with this email already exists', 409)
    }
    await check?.addressFree()

    // MAU cap (Plan-driven): once this project hits its monthly-active-user
    // limit, NEW sign-ups are blocked — existing users keep working. The
    // owner is prompted (in-app) to upgrade. Fail-open inside the kernel. A
    // preview branch's test users are not the month's active users, so they
    // neither count nor get capped.
    if (!isInternalTest && !env.branch) {
      const mau = await canAcceptNewEndUser(projectId)
      if (!mau.allowed) {
        return createErrorResponse(ErrorCodes.FORBIDDEN, mau.message ?? 'Sign-ups are temporarily unavailable for this app.', 403)
      }
    }

    // Email verification is the project's choice (ProjectAuthConfig, off by
    // default). A project that never turned it on is left exactly as it was: no
    // column added, no email sent. One that did gets the column BEFORE this
    // insert, because ensureEmailVerifiedColumn grandfathers rows that exist
    // when it first adds the column, and this new account must not be one.
    // Never on a preview branch: the emailed link carries no key, so it could
    // not say which branch it belongs to (SKIPPED_ON_BRANCH_SIGNUP).
    const requireVerification =
      !isInternalTest && !env.branch && (await getAuthEmailContext(projectId)).requireEmailVerification
    if (requireVerification) await ensureEmailVerifiedColumn(schemaName)

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

    // Signed with the RESOLVED secret, as every verifier reads it. Provisioning
    // stores the secret encrypted (JWTSecretManager.getOrCreateSecret), and this
    // route signed with the stored ciphertext, so a sign-up token verified
    // nowhere: the data plane served its holder as anonymous and refresh
    // refused it, until the user signed in again. A branch session is signed
    // with the branch's own secret, derived from that one, so it cannot be
    // presented to production (lib/branches/auth-environment.ts).
    const token = jwt.sign(
      {
        userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID(),
        ...endUserTokenClaims(env.branch),
      },
      endUserTokenSecret(resolveJwtSecret(jwtSecret), env.branch),
      { expiresIn: '7d' },
    )

    // Production side effects. None of them runs for a preview branch, whose
    // response lists what it skipped: functions and webhooks are production
    // code and endpoints, and the active-user count is the bill.
    if (!env.branch) {
      // Count this new end-user toward the project's MAU for the month. Verifier
      // accounts are excluded inside trackEndUserActive itself.
      trackEndUserActive(projectId, String(user.id), email).catch(() => {})

      // Notify webhook subscribers that an end user signed up. Emitted here, not
      // by a database trigger: the `users` table deliberately carries none, since
      // it holds the bcrypt hash (Realtime once leaked it by broadcasting
      // row_to_json(NEW) from this table). The shared emitter builds the payload
      // from a fixed field list and skips reserved test accounts.
      void emitEndUserCreated(projectId, user)

      // Fire on_signup AI functions (non-blocking — never fails the signup)
      import('@/lib/services/ai-functions/executor').then(({ fireAiFunctionsOnSignup }) => {
        fireAiFunctionsOnSignup(projectId, { id: user.id, email: user.email, name: user.name }).catch(
          (err: any) => console.warn('[AiFunctions] on_signup failed (non-fatal):', err?.message)
        )
      }).catch(() => {})
    }

    // Non-blocking: the branded verification email (24h token), only where the
    // project requires verification. Sign-in enforces it; signup never waits on
    // SMTP. Reserved verifier accounts never get here (requireVerification is
    // false for them), so no orphaned `_email_verifications` row is left behind.
    if (requireVerification) {
      requestEmailVerification(projectId, email).catch(
        (err: any) => console.warn('[EmailVerification] signup send failed (non-fatal):', err?.message)
      )
    }

    // 201, as the runtime's signup answers and the contract probe expects: the
    // two implementations of one endpoint must not disagree on success (#147).
    return createSuccessResponse(
      { user, token, ...(env.branch ? { skippedOnBranch: SKIPPED_ON_BRANCH_SIGNUP } : {}) },
      undefined,
      201,
    )
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
