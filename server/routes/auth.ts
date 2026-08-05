import { Router, Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { ensureAuthUsersTable, buildUserInsert, isReservedTestEmail } from '@/lib/services/end-user-auth-table'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { sendError, sendSuccess, ErrorCodes } from '../lib/response'
import {
  refreshEndUserToken,
  logoutEndUser,
  forgotEndUserPassword,
  resetEndUserPassword,
  requestEmailVerification,
  verifyEndUserEmail,
  requestMagicLink,
  verifyMagicLink,
} from '@/lib/services/end-user-auth-flows'
import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { JWTSecretManager, resolveJwtSecret } from '@/lib/services/jwtSecretManager'

const router = Router()

// End-user passwords must be at least 8 chars. Project owners can opt into
// stricter rules via their auth config; this is the floor that the runtime
// enforces regardless of project config.
const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().optional(),
})

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

// In-memory IP throttle for the public end-user auth surface. The runtime is
// behind nginx; X-Forwarded-For is trusted. Each project also has API-key
// rate limiting on /api/v1/* but auth signup/signin run BEFORE the project's
// API-key gate, so they need their own brake.
const SIGNUP_LIMITS = { limit: 10, windowMs: 60 * 60 * 1000 }
// Reserved test accounts (…@*.internal) get their own generous bucket. The
// behavioral verifier signs one up on every build / scan / deploy-readiness run,
// all from the server's single egress IP — sharing the 10/hr real-user bucket,
// those self-tests exhaust it and the verifier then gets 429, which fails the
// "Live HTTP endpoints" check and blocks the deploy for a perfectly healthy
// backend. A separate bucket means real users and the verifier can never starve
// each other; still bounded (these accounts are auto-purged + excluded from
// quotas, so the cap is pure anti-abuse, not a product limit).
const SIGNUP_INTERNAL_LIMITS = { limit: 100, windowMs: 60 * 60 * 1000 }
const SIGNIN_LIMITS = { limit: 30, windowMs: 15 * 60 * 1000 }
const ipBuckets = new Map<string, { count: number; resetAt: number }>()
function ipFrom(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  const xffStr = Array.isArray(xff) ? xff[0] : xff
  return (xffStr?.split(',')[0]?.trim()) || req.socket.remoteAddress || 'unknown'
}
function throttle(key: string, policy: { limit: number; windowMs: number }): { allowed: boolean; retryAfter: number } {
  const now = Date.now()
  const b = ipBuckets.get(key)
  if (!b || b.resetAt <= now) {
    ipBuckets.set(key, { count: 1, resetAt: now + policy.windowMs })
    return { allowed: true, retryAfter: 0 }
  }
  if (b.count >= policy.limit) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) }
  }
  b.count++
  return { allowed: true, retryAfter: 0 }
}
// GC the map periodically.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [k, b] of Array.from(ipBuckets.entries())) {
      if (b.resetAt < now) ipBuckets.delete(k)
    }
  }, 60_000).unref?.()
}

/**
 * POST /api/v1/:projectId/auth/signup  (also /auth/register)
 * Register an end user in workspace_{projectId}.users
 */
async function handleSignUp(req: Request, res: Response) {
  const { projectId } = req.params

  // IP rate limit — applies BEFORE any DB lookup so we can't be used as a
  // free email-existence oracle. Peeking at the already-parsed body email to
  // pick the bucket is a pure string check (no DB), so the oracle protection is
  // preserved. Reserved test emails route to their own bucket (see above).
  const ip = ipFrom(req)
  const isInternalTest = isReservedTestEmail((req.body as { email?: unknown })?.email as string | undefined)
  const rl = isInternalTest
    ? throttle(`v1-signup-internal:${projectId}:${ip}`, SIGNUP_INTERNAL_LIMITS)
    : throttle(`v1-signup:${projectId}:${ip}`, SIGNUP_LIMITS)
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    // ── State the limit and the wait, not "try again later" ──────────────────
    //
    // "Try again later" is unactionable: it names no threshold, so the caller
    // cannot tell whether they tripped a burst guard or an hourly cap, and no
    // wait, so their only option is to poll. A developer doing ordinary testing
    // hit this, had no idea what the limit was, and had to guess how long to
    // pause. The numbers are not a secret — they are configuration, and stating
    // them turns a dead end into a decision.
    sendError(
      res,
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      `Too many signup attempts — the limit is ${SIGNUP_LIMITS.limit} per hour per IP, per project. ` +
      `Retry in ${rl.retryAfter}s (see the Retry-After header).`,
      429,
    )
    return
  }

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Project not found', 404)
      return
    }

    const parsed = signUpSchema.safeParse(req.body)
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, {
        fields: parsed.error.flatten().fieldErrors,
      })
      return
    }

    // Built-in auth works out of the box: the signing secret is provisioned
    // lazily on the first signup, exactly like the users table below. Before
    // this, a fresh project 503'd here ("Authentication is not configured")
    // even though the APIs page advertises /auth/signup as live.
    let signingSecret: string
    if (project.jwtSecret && project.jwtSecret.length >= 32) {
      signingSecret = resolveJwtSecret(project.jwtSecret)
    } else {
      try {
        signingSecret = await JWTSecretManager.getOrCreateSecret(projectId)
      } catch (err: any) {
        console.error('[Auth] jwtSecret provisioning failed:', err?.message ?? 'unknown')
        sendError(res, ErrorCodes.INTERNAL_ERROR, 'Authentication is not configured for this project.', 503)
        return
      }
    }

    const { email, password, name } = parsed.data

    // Guarantee the users table satisfies the auth contract before we touch
    // it — creates it when missing, self-heals a drifted one (e.g. an
    // AI-generated `users` table with no `role` column). This is what
    // previously failed signup with `column "role" does not exist`.
    const schema = await ensureAuthUsersTable(projectId)
    const schemaName = schema.schemaName

    // Service-role: workspace users tables may have FORCE ROW LEVEL SECURITY.
    // Anonymous signups need the service-role bypass; without it, both the
    // SELECT-existing and the INSERT below hit PG 42501.
    const existing = await executeWithUserContext<any>(
      '',
      true,
      `SELECT id FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    )
    if (existing.length > 0) {
      sendError(res, ErrorCodes.CONFLICT, 'An account with this email already exists', 409)
      return
    }

    const hashedPassword = await hashPassword(password)
    const displayName = name || email.split('@')[0]

    // INSERT column list AND RETURNING clause are both built from the live
    // schema — a column the table does not have is never referenced.
    const plan = await buildUserInsert(schema, {
      id: crypto.randomUUID(),
      email,
      name: displayName,
      username: email.split('@')[0],
      password: hashedPassword,
      password_hash: hashedPassword,
    })

    // Service-role INSERT — see comment on `existing` SELECT above.
    const created = await executeWithUserContext<any>('', true, plan.sql, plan.values)
    const user = created[0]

    const token = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      signingSecret,
      { expiresIn: '7d', algorithm: 'HS256' }
    )

    // Non-blocking: fire on_signup AI functions. Synthetic verifier accounts are
    // filtered inside fireAiFunctionsOnSignup, not here — two signup routes call
    // it and a guard at the call site only ever covers one of them.
    import('@/lib/services/ai-functions/executor').then(({ fireAiFunctionsOnSignup }) => {
      fireAiFunctionsOnSignup(projectId, { id: user.id, email: user.email, name: user.name }).catch(
        (err: any) => console.warn('[AiFunctions] on_signup failed (non-fatal):', err?.message)
      )
    }).catch(() => {})

    // Non-blocking: send the branded verification email (24h token). Signup
    // never waits on SMTP — verification is enforced (if enabled) at signin.
    // Skip entirely for synthetic verifier accounts (…@*.internal): issuing a
    // token would leave an orphaned `_email_verifications` row in the
    // developer's Tables after the verifier deletes the throwaway user.
    if (!isReservedTestEmail(email)) {
      requestEmailVerification(projectId, email).catch(
        (err: any) => console.warn('[EmailVerification] signup send failed (non-fatal):', err?.message)
      )
    }

    res.status(201).json({ data: { user, token } })
  } catch (error: any) {
    console.error('Signup error:', error)
    // Never leak Prisma / Postgres internals to the end user's app.
    const safe = sanitizeDiagnostic(error)
    sendError(
      res,
      ErrorCodes.INTERNAL_ERROR,
      safe ? `Could not create the account — ${safe}` : 'Could not create the account.',
      500,
    )
  }
}

/**
 * POST /api/v1/:projectId/auth/signin  (also /auth/login)
 * Authenticate an end user from workspace_{projectId}.users
 */
async function handleSignIn(req: Request, res: Response) {
  const { projectId } = req.params

  // IP rate limit for brute-force protection.
  const ip = ipFrom(req)
  const rl = throttle(`v1-signin:${projectId}:${ip}`, SIGNIN_LIMITS)
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    sendError(
      res,
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      `Too many sign-in attempts — the limit is ${SIGNIN_LIMITS.limit} per 15 minutes per IP, per project. ` +
      `Retry in ${rl.retryAfter}s (see the Retry-After header).`,
      429,
    )
    return
  }

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Project not found', 404)
      return
    }

    const parsed = signInSchema.safeParse(req.body)
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', 400, {
        fields: parsed.error.flatten().fieldErrors,
      })
      return
    }

    const { email, password } = parsed.data
    const schemaName = `workspace_${projectId}`

    const tableCheck = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'users'
      ) AS exists`,
      schemaName
    )
    if (!tableCheck[0]?.exists) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Authentication is not enabled for this project.', 404)
      return
    }

    // Service-role: same RLS bypass rationale as signup — the caller is
    // unauthenticated at this point (we are issuing the JWT), so no
    // app.current_user_id exists yet. Without the bypass, the SELECT below
    // returns zero rows on a users table with own_rows RLS, producing a
    // misleading "Invalid email or password" for an account that exists.
    //
    // SELECT * — schema-tolerant. The AI may generate users tables with any
    // combination of `password` vs `password_hash`, with or without
    // `is_blocked`, `role`, etc. A hardcoded column list breaks signin the
    // moment a column doesn't exist (PG 42703 → 500 → "Failed to
    // authenticate user", but the real cause is schema mismatch, not bad
    // credentials).
    const users = await executeWithUserContext<any>(
      '',
      true,
      `SELECT * FROM "${schemaName}"."users" WHERE email = $1 LIMIT 1`,
      [email],
    )

    const user = users[0]
    const storedHash = user?.password ?? user?.password_hash
    if (!user || !storedHash) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Invalid email or password', 401)
      return
    }
    if (user.is_blocked === true) {
      sendError(res, ErrorCodes.FORBIDDEN, 'This account has been suspended.', 403)
      return
    }

    const isValid = await verifyPassword(password, storedHash)
    if (!isValid) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Invalid email or password', 401)
      return
    }

    // Email-verification gate — opt-in via ProjectAuthConfig. Only blocks when
    // the column exists AND is explicitly false, so legacy users tables
    // without the column are unaffected.
    if (user.email_verified === false) {
      const emailCtx = await getAuthEmailContext(projectId)
      if (emailCtx.requireEmailVerification) {
        sendError(
          res,
          ErrorCodes.FORBIDDEN,
          'Please verify your email before signing in. Check your inbox for the verification link.',
          403,
          { reason: 'EMAIL_NOT_VERIFIED' },
        )
        return
      }
    }

    if (!project.jwtSecret || project.jwtSecret.length < 32) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Authentication is not configured for this project.', 503)
      return
    }
    const token = jwt.sign(
      { userId: user.id, email: user.email, projectId, role: user.role ?? 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret),
      { expiresIn: '7d', algorithm: 'HS256' }
    )
    sendSuccess(res, { user: { id: user.id, email: user.email, name: user.name }, token })
  } catch (error: any) {
    console.error('Signin error:', error?.message ?? 'unknown')
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to authenticate user', 500)
  }
}

// ── Session lifecycle flows (shared kernel) ──────────────────────────────────
// refresh-token / logout / forgot-password / reset-password live in
// lib/services/end-user-auth-flows.ts, shared with the Next.js dev routes.
// These MUST be mounted here: nginx routes all of /api/v1/ to this Express
// server in production, and the dynamic catch-all hard-404s auth paths — so
// before these handlers existed, all four endpoints were dead in prod while
// the API Builder advertised them.

/** Extract a bearer token from Authorization header or JSON body. */
function tokenFrom(req: Request, bodyKeys: string[] = ['token']): string | null {
  const authHeader = req.headers['authorization'] as string | undefined
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7)
  for (const k of bodyKeys) {
    const v = req.body?.[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

const FORGOT_LIMITS = { limit: 10, windowMs: 60 * 60 * 1000 }

async function handleRefreshToken(req: Request, res: Response) {
  const result = await refreshEndUserToken(
    req.params.projectId,
    tokenFrom(req, ['token', 'refreshToken']),
  )
  res.status(result.status).json(result.body)
}

async function handleLogout(req: Request, res: Response) {
  const result = await logoutEndUser(req.params.projectId, tokenFrom(req))
  res.status(result.status).json(result.body)
}

async function handleForgotPassword(req: Request, res: Response) {
  const { projectId } = req.params
  // IP rate limit — this endpoint can trigger emails, so it needs its own
  // brake against abuse (same pattern as signup/signin above).
  const ip = ipFrom(req)
  const rl = throttle(`v1-forgot:${projectId}:${ip}`, FORGOT_LIMITS)
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    sendError(res, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Too many password reset requests. Try again later.', 429)
    return
  }
  const result = await forgotEndUserPassword(projectId, req.body?.email)
  res.status(result.status).json(result.body)
}

async function handleResetPassword(req: Request, res: Response) {
  const result = await resetEndUserPassword(
    req.params.projectId,
    req.body?.token,
    req.body?.password,
  )
  res.status(result.status).json(result.body)
}

// ── Email verification + magic links ─────────────────────────────────────────

async function handleVerifyEmail(req: Request, res: Response) {
  const result = await verifyEndUserEmail(req.params.projectId, req.body?.token)
  res.status(result.status).json(result.body)
}

async function handleResendVerification(req: Request, res: Response) {
  const { projectId } = req.params
  const ip = ipFrom(req)
  const rl = throttle(`v1-resend-verify:${projectId}:${ip}`, FORGOT_LIMITS)
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    sendError(res, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Too many verification emails requested. Try again later.', 429)
    return
  }
  const result = await requestEmailVerification(projectId, req.body?.email)
  res.status(result.status).json(result.body)
}

async function handleMagicLinkRequest(req: Request, res: Response) {
  const { projectId } = req.params
  const ip = ipFrom(req)
  const rl = throttle(`v1-magic:${projectId}:${ip}`, FORGOT_LIMITS)
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    sendError(res, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Too many sign-in links requested. Try again later.', 429)
    return
  }
  const result = await requestMagicLink(projectId, req.body?.email)
  res.status(result.status).json(result.body)
}

async function handleMagicLinkVerify(req: Request, res: Response) {
  const result = await verifyMagicLink(req.params.projectId, req.body?.token)
  res.status(result.status).json(result.body)
}

/** Minimal hosted page for emailed links — works with zero developer setup. */
function hostedPage(title: string, message: string, appUrl: string | null, appName: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const back = appUrl
    ? `<a href="${esc(appUrl)}" style="display:inline-block;margin-top:20px;background:#8b5cf6;color:#fff;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:12px;">Back to ${esc(appName)}</a>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#0e0f13;color:#f0f0f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
<div style="max-width:420px;padding:40px 32px;text-align:center;">
<p style="color:#8b5cf6;font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 16px;">${esc(appName)}</p>
<h1 style="font-size:22px;font-weight:800;margin:0 0 12px;">${esc(title)}</h1>
<p style="color:#9ca3af;font-size:15px;margin:0;">${esc(message)}</p>
${back}
</div></body></html>`
}

/**
 * GET /auth/verify-email?token=… — the target of the emailed verification
 * link. Completes server-side and shows a confirmation page, so verification
 * works even when the developer has built nothing.
 */
async function handleVerifyEmailPage(req: Request, res: Response) {
  const { projectId } = req.params
  const token = typeof req.query.token === 'string' ? req.query.token : undefined
  const emailCtx = await getAuthEmailContext(projectId).catch(
    () => ({ appName: 'your app', appUrl: null as string | null, requireEmailVerification: false, magicLinksEnabled: true }),
  )
  const result = await verifyEndUserEmail(projectId, token)
  const html = result.status === 200
    ? hostedPage('Email verified', 'Your email address has been confirmed. You can now sign in.', emailCtx.appUrl, emailCtx.appName)
    : hostedPage('Link not valid', result.body?.error?.message || 'This verification link is invalid or has expired.', emailCtx.appUrl, emailCtx.appName)
  res.status(result.status === 200 ? 200 : 400).type('html').send(html)
}

/**
 * GET /auth/magic?token=… — the target of the emailed magic link. On success:
 * redirects to the app with the session token in the URL fragment
 * ({appUrl}#backenly_token=…), which the SDK picks up automatically. Without a
 * configured App URL it shows a hosted confirmation instead.
 */
async function handleMagicPage(req: Request, res: Response) {
  const { projectId } = req.params
  const token = typeof req.query.token === 'string' ? req.query.token : undefined
  const emailCtx = await getAuthEmailContext(projectId).catch(
    () => ({ appName: 'your app', appUrl: null as string | null, requireEmailVerification: false, magicLinksEnabled: true }),
  )
  const result = await verifyMagicLink(projectId, token)
  if (result.status !== 200) {
    res.status(400).type('html').send(
      hostedPage('Link not valid', result.body?.error?.message || 'This sign-in link is invalid or has expired.', emailCtx.appUrl, emailCtx.appName),
    )
    return
  }
  const sessionToken: string = result.body?.data?.token
  if (emailCtx.appUrl) {
    // Fragment (not query): never sent to the app's server or logged there.
    res.redirect(302, `${emailCtx.appUrl}#backenly_token=${encodeURIComponent(sessionToken)}`)
    return
  }
  res.status(200).type('html').send(
    hostedPage(
      "You're signed in",
      'Sign-in succeeded, but this app has not configured its App URL yet — add it in Backenly → Auth settings so this link can return users to the app automatically.',
      null,
      emailCtx.appName,
    ),
  )
}

// Primary routes
router.post('/:projectId/auth/signup', handleSignUp)
router.post('/:projectId/auth/signin', handleSignIn)
router.post('/:projectId/auth/refresh-token', handleRefreshToken)
router.post('/:projectId/auth/logout', handleLogout)
router.post('/:projectId/auth/verify-email', handleVerifyEmail)
router.get('/:projectId/auth/verify-email', handleVerifyEmailPage)
router.post('/:projectId/auth/resend-verification', handleResendVerification)
router.post('/:projectId/auth/magic-link', handleMagicLinkRequest)
router.post('/:projectId/auth/magic-link/verify', handleMagicLinkVerify)
router.get('/:projectId/auth/magic', handleMagicPage)
router.post('/:projectId/auth/forgot-password', handleForgotPassword)
router.post('/:projectId/auth/reset-password', handleResetPassword)

// Aliases — AI platforms (Lovable, Replit, Base44) generate /auth/login and
// /auth/register instead of Backenly's /auth/signin and /auth/signup.
// Without these, requests fall through to the dynamic catch-all which tries
// to validate an Authorization header and returns 401 "Invalid or expired token".
router.post('/:projectId/auth/login', handleSignIn)
router.post('/:projectId/auth/register', handleSignUp)
// Alias — /auth/refresh for SDKs that use the short form.
router.post('/:projectId/auth/refresh', handleRefreshToken)

export default router
