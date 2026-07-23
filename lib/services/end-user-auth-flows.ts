/**
 * END-USER AUTH FLOWS — shared kernel
 * ====================================
 * Framework-free implementations of the four "session lifecycle" auth flows:
 *
 *   refreshEndUserToken   POST /auth/refresh-token
 *   logoutEndUser         POST /auth/logout
 *   forgotEndUserPassword POST /auth/forgot-password
 *   resetEndUserPassword  POST /auth/reset-password
 *
 * WHY THIS FILE EXISTS: the public runtime surface (/api/v1/*) is served by
 * the Express runtime in production (nginx routes ALL of /api/v1/ to port
 * 3001), while the same routes also exist as Next.js handlers for local dev.
 * The logic used to live only in the Next.js handlers — which made these four
 * endpoints hard-404 in production even though the API Builder advertised
 * them. Both surfaces now call these functions, so behavior can never drift
 * between dev and prod again.
 *
 * Every function returns { status, body } and never throws — callers just
 * serialize the result. Body shapes match the platform-wide contract:
 * success → { data: ... }, failure → { error: { code, message, details? } }.
 */

import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth/password'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { ensureAuthUsersTable, introspectAuthUsersTable, stampLastLogin, isReservedTestEmail } from '@/lib/services/end-user-auth-table'
import { trackEndUserActive } from '@/lib/billing/quota-kernel'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

export interface AuthFlowResult {
  status: number
  body: any
}

function ok(data: any): AuthFlowResult {
  return { status: 200, body: { data } }
}

function err(code: string, message: string, status: number, details?: Record<string, any>): AuthFlowResult {
  return { status, body: { error: { code, message, ...(details && { details }) } } }
}

/**
 * POST /auth/refresh-token
 * Issues a new access token from a still-valid token (sliding window) or an
 * expired one within a 7-day grace window.
 */
export async function refreshEndUserToken(projectId: string, rawToken: string | null): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)

    if (!rawToken) {
      return err(
        'UNAUTHORIZED',
        'Token required. Pass your current token in the Authorization header (Bearer <token>) or request body as { token }.',
        401,
      )
    }

    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      return err('NOT_FOUND', 'Authentication is not configured for this project.', 503)
    }

    // Verify token with the project's own jwtSecret
    let payload: any = null
    try {
      payload = jwt.verify(rawToken, resolveJwtSecret(project.jwtSecret), { algorithms: ['HS256'] }) as any
    } catch (e: any) {
      // If expired, retry with ignoreExpiration to enforce the 7-day grace window
      if (e?.name === 'TokenExpiredError') {
        try {
          payload = jwt.verify(rawToken, resolveJwtSecret(project.jwtSecret), {
            algorithms: ['HS256'],
            ignoreExpiration: true,
          }) as any
          const exp: number = payload?.exp ?? 0
          const secondsSinceExpiry = Math.floor(Date.now() / 1000) - exp
          const GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60
          if (secondsSinceExpiry > GRACE_PERIOD_SECONDS) {
            return err('UNAUTHORIZED', 'Token has expired beyond the refresh grace period. Please sign in again.', 401)
          }
        } catch {
          return err('UNAUTHORIZED', 'Invalid token. Please sign in again.', 401)
        }
      } else {
        return err('UNAUTHORIZED', 'Invalid token. Please sign in again.', 401)
      }
    }

    // Token must be scoped to THIS project
    if (!payload || payload.projectId !== projectId) {
      return err('UNAUTHORIZED', 'Token is not valid for this project.', 401)
    }

    const schemaName = `workspace_${projectId}`

    // Read only columns that actually exist — an AI-generated users table may
    // lack `role` / `is_blocked` / `name`. A hardcoded list would 42703 → 500.
    const schema = await introspectAuthUsersTable(projectId)
    const selectCols = ['id', 'email']
    if (schema.hasName) selectCols.push('name')
    if (schema.hasRole) selectCols.push('role')
    if (schema.hasIsBlocked) selectCols.push('is_blocked')

    // Service-role read: the users table is FORCE RLS (service-role-only
    // policy), so a plain query would see zero rows and 401 every refresh.
    const users = await executeWithUserContext<any>(
      '',
      true,
      `SELECT ${selectCols.map(c => `"${c}"`).join(', ')} FROM "${schemaName}"."users" WHERE id = $1 LIMIT 1`,
      [payload.userId],
    )

    const user = users[0]
    if (!user) return err('UNAUTHORIZED', 'User not found. Please sign in again.', 401)
    if (user.is_blocked) return err('FORBIDDEN', 'This account has been suspended.', 403)

    const newToken = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret!),
      { expiresIn: '7d' },
    )

    // A token refresh means the end-user is still active this month.
    trackEndUserActive(projectId, String(user.id)).catch(() => {})
    // Stamp last_login so the Auth dashboard's "active · 30d" metric is real.
    stampLastLogin(projectId, user.id).catch(() => {})

    return ok({ token: newToken, user: { id: user.id, email: user.email, name: user.name } })
  } catch (error: any) {
    console.error('Refresh token error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to refresh token', 500)
  }
}

/**
 * POST /auth/logout
 * Server-side token invalidation: stores the JWT ID (jti) in a per-workspace
 * blacklist table (lazily created). Always returns 200 — logout is idempotent.
 */
export async function logoutEndUser(projectId: string, rawToken: string | null): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)

    if (rawToken) {
      // Decode without strict expiry check so we can blacklist already-expired tokens too
      let payload: any = null
      try {
        if (project.jwtSecret) {
          payload = jwt.verify(rawToken, resolveJwtSecret(project.jwtSecret), {
            algorithms: ['HS256'],
            ignoreExpiration: true,
          }) as any
        }
      } catch {
        // Malformed token — treat as already invalidated, still return 200
      }

      // Skip blacklisting synthetic verifier sessions (…@*.internal): the token
      // is throwaway and the user row is deleted immediately after, so a
      // blacklist entry would just orphan in the developer's `_token_blacklist`.
      if (payload?.jti && payload?.projectId === projectId && !isReservedTestEmail(payload.email)) {
        const schemaName = `workspace_${projectId}`
        const expiresAt = payload.exp
          ? new Date(payload.exp * 1000)
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

        await prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS "${schemaName}"."_token_blacklist" (
            jti        TEXT        PRIMARY KEY,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `)

        // Prune tokens that have already expired (keep the table small)
        await prisma.$executeRawUnsafe(
          `DELETE FROM "${schemaName}"."_token_blacklist" WHERE expires_at < NOW()`,
        )

        await prisma.$executeRawUnsafe(
          `INSERT INTO "${schemaName}"."_token_blacklist" (jti, expires_at)
           VALUES ($1, $2)
           ON CONFLICT (jti) DO NOTHING`,
          payload.jti,
          expiresAt,
        )
      }
    }

    return ok({ message: 'Logged out successfully.' })
  } catch (error: any) {
    console.error('Logout error:', error?.message ?? error)
    // Logout should never fail from the client's perspective
    return ok({ message: 'Logged out successfully.' })
  }
}

/**
 * POST /auth/forgot-password
 * Generates a single-use, 1-hour reset token. Sends it via SMTP when
 * configured; otherwise returns it in the response so the developer can wire
 * their own delivery. Always 200 for unknown emails (no user enumeration).
 */
export async function forgotEndUserPassword(projectId: string, emailRaw: unknown): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)

    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : undefined
    if (!email) return err('BAD_REQUEST', 'email is required', 400)

    const schemaName = `workspace_${projectId}`

    // Lazily create the password resets table (no migration required)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"."_password_resets" (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        email      TEXT        NOT NULL,
        token      TEXT        NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "_pw_resets_token_idx"
         ON "${schemaName}"."_password_resets" (token)`,
    )

    // Purge expired tokens so the table stays small
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${schemaName}"."_password_resets" WHERE expires_at < NOW()`,
    )

    // Look up user — do NOT leak existence via the response.
    // Service-role: caller has no session user id yet, RLS would hide the row.
    const users = await executeWithUserContext<{ id: string; email: string }>(
      '',
      true,
      `SELECT id, email FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    ).catch(() => [] as { id: string; email: string }[])

    if (users.length > 0) {
      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      // Invalidate any existing unused reset for this email
      await prisma.$executeRawUnsafe(
        `DELETE FROM "${schemaName}"."_password_resets" WHERE email = $1 AND used_at IS NULL`,
        email,
      )

      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schemaName}"."_password_resets" (email, token, expires_at)
         VALUES ($1, $2, $3)`,
        email,
        token,
        expiresAt,
      )

      // Branded delivery: the email carries the app's name and links back to
      // the app's URL (ProjectAuthConfig), never to backenly.com.
      let emailSent = false
      try {
        const { getAuthEmailContext, sendEndUserPasswordResetEmail } =
          await import('@/lib/services/end-user-auth-email')
        const emailCtx = await getAuthEmailContext(projectId)
        emailSent = await sendEndUserPasswordResetEmail(projectId, email, token, emailCtx)
      } catch (emailErr: any) {
        console.warn('[ForgotPassword] Email send failed (non-fatal):', emailErr?.message)
      }

      if (!emailSent) {
        // NEVER return the token to the caller — this endpoint is
        // unauthenticated, so echoing it back would let anyone take over any
        // account just by knowing the email address. If SMTP isn't configured
        // the token sits unused in _password_resets until it expires; the
        // developer must configure SMTP_HOST/SMTP_USER/SMTP_PASS for the flow
        // to complete.
        console.warn(
          `[ForgotPassword] Reset token for project ${projectId} could not be emailed ` +
          '(SMTP not configured or send failed). The reset flow is broken for this ' +
          'project until SMTP delivery works.',
        )
      }
    }

    // Generic success — never reveal whether the email was found
    return ok({ message: 'If an account with that email exists, a password reset link has been sent.' })
  } catch (error: any) {
    console.error('Forgot password error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to process password reset request', 500)
  }
}

/**
 * POST /auth/reset-password
 * Consumes a reset token, updates the password, and returns a fresh JWT so
 * the user is immediately signed in.
 */
export async function resetEndUserPassword(
  projectId: string,
  tokenRaw: unknown,
  passwordRaw: unknown,
): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)

    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      return err('INTERNAL_ERROR', 'Authentication is not configured for this project.', 503)
    }

    const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : undefined
    const newPassword = typeof passwordRaw === 'string' ? passwordRaw : undefined

    if (!token) return err('BAD_REQUEST', '"token" is required', 400)
    if (!newPassword || newPassword.length < 8) {
      return err('BAD_REQUEST', '"password" must be at least 8 characters', 400)
    }

    const schemaName = `workspace_${projectId}`

    // Bring the users table to the auth contract so the password UPDATE below
    // targets columns that actually exist — handles `password` vs
    // `password_hash` and `updatedAt` vs `updated_at` schema drift.
    const usersSchema = await ensureAuthUsersTable(projectId)

    const resets = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, email, expires_at, used_at
         FROM "${schemaName}"."_password_resets"
         WHERE token = $1
         LIMIT 1`,
      token,
    ).catch(() => [] as any[])

    if (resets.length === 0) {
      return err('BAD_REQUEST', 'Invalid or expired password reset token.', 400)
    }

    const reset = resets[0]

    if (reset.used_at) {
      return err('BAD_REQUEST', 'This password reset link has already been used.', 400)
    }

    if (new Date(reset.expires_at) < new Date()) {
      return err('BAD_REQUEST', 'This password reset link has expired. Please request a new one.', 400)
    }

    // Fetch the user — service-role since the caller is not yet authenticated.
    const users = await executeWithUserContext<any>(
      '',
      true,
      `SELECT id, email, name FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [reset.email],
    ).catch(() => [] as any[])

    if (users.length === 0) {
      return err('NOT_FOUND', 'User account not found.', 404)
    }

    const user = users[0]
    const hashedPassword = await hashPassword(newPassword)

    // Update the user's password — service-role so the UPDATE bypasses
    // own_rows RLS that would otherwise gate the row on app.current_user_id.
    // Column names come from the live schema descriptor, never hardcoded.
    const setParts = [`"${usersSchema.passwordColumn}" = $1`]
    if (usersSchema.updatedAtColumn) setParts.push(`"${usersSchema.updatedAtColumn}" = NOW()`)
    await executeWithUserContext(
      '',
      true,
      `UPDATE "${schemaName}"."users"
         SET ${setParts.join(', ')}
         WHERE id = $2`,
      [hashedPassword, user.id],
    )

    // Mark the reset token as used (single-use enforcement)
    await prisma.$executeRawUnsafe(
      `UPDATE "${schemaName}"."_password_resets"
         SET used_at = NOW()
         WHERE id = $1`,
      reset.id,
    )

    const newToken = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret!),
      { expiresIn: '7d' },
    )

    return ok({
      message: 'Password has been reset successfully.',
      token: newToken,
      user: { id: user.id, email: user.email, name: user.name },
    })
  } catch (error: any) {
    console.error('Reset password error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to reset password', 500)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION + MAGIC LINKS
// ═══════════════════════════════════════════════════════════════════════════════

/** Lazily create a single-use auth-token table (same pattern as _password_resets). */
async function ensureTokenTable(schemaName: string, tableName: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      email      TEXT        NOT NULL,
      token      TEXT        NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "${tableName}_token_idx" ON "${schemaName}"."${tableName}" (token)`,
  )
  // Every resend/verify flow looks rows up by email. Reserved (_-prefixed)
  // tables are platform-managed and excluded from the autonomy probes, so this
  // table must ship with its indexes — nothing will retrofit them later.
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "${tableName}_email_idx" ON "${schemaName}"."${tableName}" (email)`,
  )
  // Opportunistic cleanup keeps these tables tiny.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "${schemaName}"."${tableName}" WHERE expires_at < NOW()`,
  ).catch(() => {})
}

/** Ensure the users table can record verification state (metadata-only ADD). */
async function ensureEmailVerifiedColumn(schemaName: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "${schemaName}"."users" ADD COLUMN IF NOT EXISTS "email_verified" BOOLEAN NOT NULL DEFAULT FALSE`,
  ).catch(() => {})
}

/** Look up a single-use token row and validate expiry/reuse. */
async function consumeToken(
  schemaName: string,
  tableName: string,
  token: string,
): Promise<{ email: string } | { error: string }> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, email, expires_at, used_at FROM "${schemaName}"."${tableName}" WHERE token = $1 LIMIT 1`,
    token,
  ).catch(() => [] as any[])
  if (rows.length === 0) return { error: 'Invalid or expired link.' }
  const row = rows[0]
  if (row.used_at) return { error: 'This link has already been used.' }
  if (new Date(row.expires_at) < new Date()) return { error: 'This link has expired. Please request a new one.' }
  await prisma.$executeRawUnsafe(
    `UPDATE "${schemaName}"."${tableName}" SET used_at = NOW() WHERE id = $1`,
    row.id,
  )
  return { email: row.email }
}

/**
 * POST /auth/resend-verification (also fired non-blocking on signup)
 * Generates a 24h verification token and emails it. Always 200 — never leaks
 * whether the email exists or is already verified.
 */
export async function requestEmailVerification(projectId: string, emailRaw: unknown): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)

    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : undefined
    if (!email) return err('BAD_REQUEST', 'email is required', 400)

    const schemaName = `workspace_${projectId}`
    await ensureEmailVerifiedColumn(schemaName)
    await ensureTokenTable(schemaName, '_email_verifications')

    const users = await executeWithUserContext<{ id: string; email_verified: boolean }>(
      '', true,
      `SELECT id, "email_verified" FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    ).catch(() => [] as any[])

    if (users.length > 0 && !users[0].email_verified) {
      const token = crypto.randomBytes(32).toString('hex')
      await prisma.$executeRawUnsafe(
        `DELETE FROM "${schemaName}"."_email_verifications" WHERE email = $1 AND used_at IS NULL`,
        email,
      )
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schemaName}"."_email_verifications" (email, token, expires_at) VALUES ($1, $2, $3)`,
        email, token, new Date(Date.now() + 24 * 60 * 60 * 1000),
      )
      try {
        const { getAuthEmailContext, sendEndUserVerificationEmail } =
          await import('@/lib/services/end-user-auth-email')
        const emailCtx = await getAuthEmailContext(projectId)
        await sendEndUserVerificationEmail(projectId, email, token, emailCtx)
      } catch (mailErr: any) {
        console.warn('[EmailVerification] send failed (non-fatal):', mailErr?.message)
      }
    }

    return ok({ message: 'If an account with that email exists, a verification link has been sent.' })
  } catch (error: any) {
    console.error('Request email verification error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to send verification email', 500)
  }
}

/**
 * POST /auth/verify-email { token } (also served as a hosted GET link target)
 * Consumes the token and marks the user verified.
 */
export async function verifyEndUserEmail(projectId: string, tokenRaw: unknown): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)

    const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : undefined
    if (!token) return err('BAD_REQUEST', 'token is required', 400)

    const schemaName = `workspace_${projectId}`
    await ensureEmailVerifiedColumn(schemaName)
    await ensureTokenTable(schemaName, '_email_verifications')

    const consumed = await consumeToken(schemaName, '_email_verifications', token)
    if ('error' in consumed) return err('BAD_REQUEST', consumed.error, 400)

    await executeWithUserContext(
      '', true,
      `UPDATE "${schemaName}"."users" SET "email_verified" = TRUE WHERE email = $1`,
      [consumed.email],
    )

    return ok({ verified: true, email: consumed.email, message: 'Email verified successfully.' })
  } catch (error: any) {
    console.error('Verify email error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to verify email', 500)
  }
}

/**
 * POST /auth/magic-link { email }
 * Passwordless sign-in: emails a single-use, 15-minute link. Creates the
 * account on first use (standard magic-link semantics) with a random password
 * hash, so the flow works for both new and returning users. Always 200.
 */
export async function requestMagicLink(projectId: string, emailRaw: unknown): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)
    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      return err('INTERNAL_ERROR', 'Authentication is not configured for this project.', 503)
    }

    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : undefined
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return err('BAD_REQUEST', 'A valid email is required', 400)
    }

    const { getAuthEmailContext, sendEndUserMagicLinkEmail } =
      await import('@/lib/services/end-user-auth-email')
    const emailCtx = await getAuthEmailContext(projectId)
    if (!emailCtx.magicLinksEnabled) {
      return err('FORBIDDEN', 'Magic-link sign-in is disabled for this project.', 403)
    }

    const schemaName = `workspace_${projectId}`
    await ensureTokenTable(schemaName, '_magic_links')

    const token = crypto.randomBytes(32).toString('hex')
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${schemaName}"."_magic_links" WHERE email = $1 AND used_at IS NULL`,
      email,
    )
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schemaName}"."_magic_links" (email, token, expires_at) VALUES ($1, $2, $3)`,
      email, token, new Date(Date.now() + 15 * 60 * 1000),
    )

    try {
      await sendEndUserMagicLinkEmail(projectId, email, token, emailCtx)
    } catch (mailErr: any) {
      console.warn('[MagicLink] send failed (non-fatal):', mailErr?.message)
    }

    return ok({ message: 'If that email is valid, a sign-in link has been sent.' })
  } catch (error: any) {
    console.error('Request magic link error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to send magic link', 500)
  }
}

/**
 * POST /auth/magic-link/verify { token } (also served by the hosted GET /auth/magic)
 * Consumes the token, creates the user if this is their first sign-in, marks
 * the email verified (they proved inbox ownership), and returns a session JWT.
 */
export async function verifyMagicLink(projectId: string, tokenRaw: unknown): Promise<AuthFlowResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return err('NOT_FOUND', 'Project not found', 404)
    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      return err('INTERNAL_ERROR', 'Authentication is not configured for this project.', 503)
    }

    const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : undefined
    if (!token) return err('BAD_REQUEST', 'token is required', 400)

    const schemaName = `workspace_${projectId}`
    await ensureTokenTable(schemaName, '_magic_links')

    const consumed = await consumeToken(schemaName, '_magic_links', token)
    if ('error' in consumed) return err('BAD_REQUEST', consumed.error, 400)
    const email = consumed.email

    const usersSchema = await ensureAuthUsersTable(projectId)
    await ensureEmailVerifiedColumn(schemaName)

    let users = await executeWithUserContext<any>(
      '', true,
      `SELECT id, email${usersSchema.hasName ? ', name' : ''}${usersSchema.hasRole ? ', role' : ''} FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    ).catch(() => [] as any[])

    if (users.length === 0) {
      // First sign-in: create the account with an unguessable password hash.
      const { buildUserInsert } = await import('@/lib/services/end-user-auth-table')
      const randomPassword = await hashPassword(crypto.randomBytes(32).toString('hex'))
      const plan = await buildUserInsert(usersSchema, {
        email,
        [usersSchema.passwordColumn]: randomPassword,
        name: email.split('@')[0],
        email_verified: true,
      })
      users = await executeWithUserContext<any>('', true, plan.sql, plan.values)
      if (users.length === 0) {
        return err('INTERNAL_ERROR', 'Failed to create account', 500)
      }
    } else {
      // Clicking the emailed link proves inbox ownership.
      await executeWithUserContext(
        '', true,
        `UPDATE "${schemaName}"."users" SET "email_verified" = TRUE WHERE email = $1`,
        [email],
      ).catch(() => {})
    }

    const user = users[0]
    const sessionToken = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret!),
      { expiresIn: '7d' },
    )

    trackEndUserActive(projectId, String(user.id)).catch(() => {})
    stampLastLogin(projectId, user.id).catch(() => {})

    return ok({
      token: sessionToken,
      user: { id: user.id, email: user.email, name: user.name ?? null },
    })
  } catch (error: any) {
    console.error('Verify magic link error:', error?.message ?? error)
    return err('INTERNAL_ERROR', 'Failed to verify magic link', 500)
  }
}
