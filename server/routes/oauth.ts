import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import {
  ensureAuthUsersTable,
  introspectAuthUsersTable,
  buildUserInsert,
  stampLastLogin,
  isReservedTestEmail,
} from '@/lib/services/end-user-auth-table'
import { canAcceptNewEndUser, trackEndUserActive } from '@/lib/quota/kernel'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

/**
 * END-USER OAUTH RUNTIME (Express)
 * ================================
 * nginx routes ALL of /api/v1/* to this Express server in production. The
 * OAuth sign-in endpoints used to exist only as Next.js routes that prod never
 * reached, so `/api/v1/{projectId}/auth/{provider}` returned the dynamic
 * catch-all's "auth endpoint not found" 404 — the Auth page let developers
 * configure Google/GitHub but the actual sign-in URL was dead.
 *
 * This router mounts the two OAuth endpoints on the runtime that actually
 * serves them:
 *   GET /:projectId/auth/:provider           → redirect to the provider
 *   GET /:projectId/auth/:provider/callback  → exchange code, upsert user, JWT
 *
 * Correctness notes (both were latent bugs in the old Next.js version):
 *   - The client secret is stored ENCRYPTED. We read it back through
 *     WorkspaceOAuthService.getConfig, which decrypts — passing the raw column
 *     to the provider would fail every token exchange.
 *   - The workspace `users` table has RLS enabled + FORCED with a
 *     service-role-only policy, so all reads/writes of user rows run under
 *     service-role (executeWithUserContext) exactly like signup/signin.
 */

const router = Router()

const PROVIDER_AUTH_URLS: Record<string, string> = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  github: 'https://github.com/login/oauth/authorize',
  discord: 'https://discord.com/api/oauth2/authorize',
  facebook: 'https://www.facebook.com/v19.0/dialog/oauth',
}

const PROVIDER_DEFAULT_SCOPES: Record<string, string> = {
  google: 'openid email profile',
  github: 'read:user user:email',
  discord: 'identify email',
  facebook: 'email,public_profile',
}

function jsonError(res: Response, status: number, error: string, code = 'ERROR') {
  res.status(status).json({ success: false, error, code })
}

// ─── OAuth state: signed, expiring, and the only thing `redirect_to` may ride on ─
//
// ── What was wrong ──────────────────────────────────────────────────────────
//
// The state parameter carried `{ projectId, nonce, redirect_to }` base64'd, and
// the callback checked exactly one thing: that `projectId` matched the URL it
// had just been called on. The nonce was generated and NEVER verified — nothing
// stored it, nothing compared it. So state was decorative: any attacker could
// mint one, because every field in it was either public (projectId) or ignored
// (nonce).
//
// That turns `redirect_to` into a token exfiltration primitive. The callback
// ends with:
//
//     redirectUrl.searchParams.set('token', token)   // the end-user's JWT
//     return res.redirect(redirectUrl.toString())
//
// against a URL taken straight out of the forgeable state. Craft a state with
// `redirect_to: https://evil.example`, get any end-user of any OAuth-enabled
// project to complete a sign-in through it, and their project-scoped JWT is
// delivered to the attacker as a query parameter — full account takeover, and
// it lands in the attacker's access logs, referrer headers and browser history
// on the way.
//
// ── The two fixes, which are separate ───────────────────────────────────────
//
// 1. SIGN the state (here). An HMAC over the payload with the project's own
//    secret makes it unforgeable, and an expiry stops a captured state being
//    replayed later. This is what the nonce was gesturing at.
//
// 2. ALLOWLIST the redirect target (see `resolveRedirectTarget`). Signing alone
//    is not enough: the project owner is the one who supplies `redirect_to` on
//    the way in, and a signed open redirect is still an open redirect if the
//    signing key ever leaks or the initiate endpoint is reachable by someone
//    who should not choose the destination.
//
// Both are required. Either alone leaves a hole.

const STATE_TTL_MS = 10 * 60 * 1000

export interface OAuthState {
  projectId: string
  nonce: string
  redirect_to?: string
  /** Issued-at, epoch ms. Bounds how long a captured state stays usable. */
  iat: number
}

/** The key states are signed with — per project, so one project cannot mint another's. */
function stateKey(projectJwtSecret: string): string {
  return crypto
    .createHmac('sha256', resolveJwtSecret(projectJwtSecret))
    .update('backenly:oauth-state:v1')
    .digest('hex')
}

export function signState(payload: OAuthState, projectJwtSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', stateKey(projectJwtSecret)).update(body).digest('base64url')
  return `${body}.${sig}`
}

/**
 * Verify and decode a state. Returns null on ANY problem — malformed, bad
 * signature, expired, wrong project. The caller turns that into one generic
 * error, because distinguishing "bad signature" from "expired" tells an
 * attacker which half of their forgery to work on.
 */
export function verifyState(raw: string, projectId: string, projectJwtSecret: string): OAuthState | null {
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null

  const body = raw.slice(0, dot)
  const presented = raw.slice(dot + 1)
  const expected = crypto.createHmac('sha256', stateKey(projectJwtSecret)).update(body).digest('base64url')

  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let parsed: OAuthState
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (parsed.projectId !== projectId) return null
  if (typeof parsed.iat !== 'number' || Date.now() - parsed.iat > STATE_TTL_MS) return null
  return parsed
}

/**
 * Where the caller may be sent afterwards, given they are about to be handed a
 * session token.
 *
 * Validated against `ConnectedApp` — the project's canonical list of connected
 * frontend origins, the same one CORS reads. Reusing it matters: a second
 * allowlist would be a second thing to keep in step, and "the origins this
 * project talks to" is a question the platform already has one answer for.
 *
 * Returns null when the target is not allowed. The caller then falls back to
 * returning the token in the JSON body — the flow still completes, it just does
 * not hand a credential to an origin the project never claimed.
 */
export async function resolveRedirectTarget(
  projectId: string,
  redirectTo: string | undefined,
): Promise<{ url: URL } | { rejected: string } | null> {
  if (!redirectTo) return null

  let url: URL
  try {
    url = new URL(redirectTo)
  } catch {
    return { rejected: 'not a valid absolute URL' }
  }

  // A token must never leave over plaintext. localhost is exempted because
  // that is where every developer's first integration runs.
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    return { rejected: 'only https:// targets may receive a token (http:// allowed for localhost)' }
  }

  const allowed = await prisma.connectedApp.findMany({
    where: { projectId, isActive: true },
    select: { origin: true },
  })

  // Exact origin match — protocol + host + port. No suffix matching: an
  // `endsWith('.example.com')` allowlist is satisfied by `evil-example.com`,
  // and that class of bug is how allowlists usually fail.
  const origin = url.origin.toLowerCase()
  const ok = allowed.some(a => a.origin.trim().toLowerCase().replace(/\/$/, '') === origin)
  if (!ok) {
    return {
      rejected:
        `origin ${url.origin} is not a connected frontend for this project. ` +
        `Connect it first so the platform knows this app is yours.`,
    }
  }

  return { url }
}

/** Resolve the public base URL for building redirect URIs. */
function baseUrlFrom(req: Request): string {
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
    || (req.headers.host as string | undefined)
    || 'localhost:3000'
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    || (host.startsWith('localhost') ? 'http' : 'https')
  return process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || `${proto}://${host}`
}

// ─── Token exchange ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
}

async function exchangeCodeForToken(
  provider: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<TokenResponse> {
  if (provider === 'github') {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    })
    return res.json() as Promise<TokenResponse>
  }
  if (provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    })
    return res.json() as Promise<TokenResponse>
  }
  if (provider === 'discord') {
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    })
    return res.json() as Promise<TokenResponse>
  }
  if (provider === 'facebook') {
    const url = new URL('https://graph.facebook.com/v19.0/oauth/access_token')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('client_secret', clientSecret)
    url.searchParams.set('code', code)
    url.searchParams.set('redirect_uri', redirectUri)
    const res = await fetch(url.toString())
    return res.json() as Promise<TokenResponse>
  }
  throw new Error(`Unsupported provider: ${provider}`)
}

// ─── Provider user info ───────────────────────────────────────────────────────

interface ProviderUser {
  id: string
  email: string
  name: string
  avatarUrl?: string
}

async function fetchProviderUser(provider: string, accessToken: string): Promise<ProviderUser> {
  if (provider === 'google') {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const data: any = await res.json()
    return { id: data.sub, email: data.email, name: data.name, avatarUrl: data.picture }
  }
  if (provider === 'github') {
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Backenly' },
    })
    const user: any = await userRes.json()
    let email = user.email
    if (!email) {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Backenly' },
      })
      const emails: Array<{ email: string; primary: boolean; verified: boolean }> = await emailRes.json() as any
      const primary = emails.find(e => e.primary && e.verified) || emails[0]
      email = primary?.email
    }
    if (!email) throw new Error('Could not retrieve email from GitHub. Make sure your GitHub account has a public or verified email.')
    return { id: String(user.id), email, name: user.name || user.login, avatarUrl: user.avatar_url }
  }
  if (provider === 'discord') {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const data: any = await res.json()
    const avatar = data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : undefined
    return { id: data.id, email: data.email, name: data.global_name || data.username, avatarUrl: avatar }
  }
  if (provider === 'facebook') {
    const res = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}`)
    const data: any = await res.json()
    return { id: data.id, email: data.email, name: data.name, avatarUrl: data.picture?.data?.url }
  }
  throw new Error(`Unsupported provider: ${provider}`)
}

// ─── GET /:projectId/auth/:provider — initiate OAuth ──────────────────────────

async function handleOAuthInit(req: Request, res: Response) {
  const { projectId, provider } = req.params

  if (!PROVIDER_AUTH_URLS[provider]) {
    return jsonError(res, 404, `Provider "${provider}" is not supported. Supported: google, github, discord, facebook`, 'NOT_FOUND')
  }

  const [config, project] = await Promise.all([
    WorkspaceOAuthService.getConfig(projectId, provider).catch(() => null),
    prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } }),
  ])
  if (!config || !config.enabled || !config.clientId) {
    return jsonError(res, 404, `${provider} authentication is not configured for this project. Configure it under Auth → Social sign-in.`, 'NOT_FOUND')
  }
  if (!project?.jwtSecret || project.jwtSecret.length < 32) {
    // The state is signed with a key derived from this secret. Without it the
    // state cannot be made unforgeable, and an unforgeable state is the only
    // thing standing between `redirect_to` and token exfiltration — so the flow
    // refuses to start rather than starting insecurely.
    return jsonError(res, 503, 'Authentication is not configured for this project.', 'INTERNAL_ERROR')
  }

  const redirectUri = `${baseUrlFrom(req)}/api/v1/${projectId}/auth/${provider}/callback`
  const redirectTo = (req.query.redirect_to as string | undefined) || ''

  // Rejected HERE, at initiate time, rather than after the round trip. The
  // developer wiring this up gets a clear error on their own screen instead of
  // a successful-looking sign-in that silently drops them somewhere else.
  if (redirectTo) {
    const target = await resolveRedirectTarget(projectId, redirectTo)
    if (target && 'rejected' in target) {
      return jsonError(
        res,
        400,
        `redirect_to was refused: ${target.rejected}`,
        'REDIRECT_NOT_ALLOWED',
      )
    }
  }

  const state = signState(
    {
      projectId,
      nonce: crypto.randomBytes(16).toString('hex'),
      redirect_to: redirectTo,
      iat: Date.now(),
    },
    project.jwtSecret,
  )

  const authUrl = new URL(PROVIDER_AUTH_URLS[provider])
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('response_type', 'code')
  const scopes = config.scopes && config.scopes.length > 0
    ? config.scopes.join(provider === 'facebook' ? ',' : ' ')
    : PROVIDER_DEFAULT_SCOPES[provider]
  authUrl.searchParams.set('scope', scopes)
  if (provider === 'google') {
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
  }
  if (provider === 'discord') {
    authUrl.searchParams.set('prompt', 'consent')
  }

  res.redirect(authUrl.toString())
}

// ─── GET /:projectId/auth/:provider/callback — complete OAuth ─────────────────

async function handleOAuthCallback(req: Request, res: Response) {
  const { projectId, provider } = req.params
  const code = req.query.code as string | undefined
  const stateRaw = req.query.state as string | undefined
  const providerError = req.query.error as string | undefined

  if (providerError) {
    return jsonError(res, 400, `OAuth error: ${providerError}`, 'OAUTH_DENIED')
  }
  if (!PROVIDER_AUTH_URLS[provider]) {
    return jsonError(res, 404, `Provider "${provider}" is not supported.`, 'NOT_FOUND')
  }
  if (!code || !stateRaw) {
    return jsonError(res, 400, 'Missing code or state parameter', 'VALIDATION_ERROR')
  }

  const [project, config] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    WorkspaceOAuthService.getConfig(projectId, provider).catch(() => null),
  ])

  if (!project) return jsonError(res, 404, 'Project not found', 'NOT_FOUND')
  if (!project.jwtSecret || project.jwtSecret.length < 32) {
    return jsonError(res, 503, 'Authentication is not configured for this project.', 'INTERNAL_ERROR')
  }

  // The signature is verified BEFORE the state's contents are used for anything.
  // Previously the only check was `stateData.projectId !== projectId`, which an
  // attacker satisfies for free — projectId is in the URL they are attacking.
  // Every other field, including `redirect_to`, was taken on trust.
  const stateData = verifyState(stateRaw, projectId, project.jwtSecret)
  if (!stateData) {
    // One error for every failure mode. Distinguishing "bad signature" from
    // "expired" from "wrong project" tells an attacker which half of their
    // forgery to keep working on.
    return jsonError(
      res,
      401,
      'Invalid or expired state parameter — restart the sign-in flow.',
      'UNAUTHORIZED',
    )
  }
  if (!config || !config.enabled || !config.clientId || !config.clientSecret) {
    return jsonError(res, 404, `${provider} OAuth is not configured for this project`, 'NOT_FOUND')
  }

  const redirectUri = `${baseUrlFrom(req)}/api/v1/${projectId}/auth/${provider}/callback`

  try {
    // 1. Exchange code → access token (uses the DECRYPTED client secret).
    const tokenData = await exchangeCodeForToken(provider, code, config.clientId, config.clientSecret, redirectUri)
    if (tokenData.error || !tokenData.access_token) {
      console.error(`[OAuth Callback] Token exchange failed for ${provider}:`, tokenData)
      return jsonError(res, 401, `Failed to exchange OAuth code: ${tokenData.error || 'unknown error'}`, 'UNAUTHORIZED')
    }

    // 2. Fetch the provider profile.
    const providerUser = await fetchProviderUser(provider, tokenData.access_token)

    // 3. Bring the users table to the auth contract, then add OAuth columns.
    const baseSchema = await ensureAuthUsersTable(projectId)
    const schemaName = baseSchema.schemaName
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schemaName}"."users"
         ADD COLUMN IF NOT EXISTS oauth_provider TEXT,
         ADD COLUMN IF NOT EXISTS oauth_id TEXT,
         ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    )
    // OAuth users have no password — the credential column must be nullable.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schemaName}"."users" ALTER COLUMN "${baseSchema.passwordColumn}" DROP NOT NULL`,
    ).catch(() => {})

    const schema = await introspectAuthUsersTable(projectId)

    // 4. Upsert by oauth_id OR email — under service-role (RLS is forced).
    const existing = await executeWithUserContext<any>(
      '',
      true,
      `SELECT id, email, name FROM "${schemaName}"."users" WHERE oauth_id = $1 OR email = $2 LIMIT 1`,
      [providerUser.id, providerUser.email],
    )

    let userId: string
    let userEmail: string
    let userName: string

    if (existing.length > 0) {
      const row = existing[0]
      userId = String(row.id)
      userEmail = row.email
      userName = row.name
      const setParts = ['oauth_provider = $1', 'oauth_id = $2', 'avatar_url = COALESCE(avatar_url, $3)']
      if (schema.updatedAtColumn) setParts.push(`"${schema.updatedAtColumn}" = NOW()`)
      await executeWithUserContext(
        '',
        true,
        `UPDATE "${schemaName}"."users" SET ${setParts.join(', ')} WHERE id = $4`,
        [provider, providerUser.id, providerUser.avatarUrl || null, userId],
      )
    } else {
      // New OAuth end-user → subject to the project's MAU cap (never for
      // reserved internal test identities, which don't exist for real OAuth).
      if (!isReservedTestEmail(providerUser.email)) {
        const mau = await canAcceptNewEndUser(projectId)
        if (!mau.allowed) {
          return jsonError(res, 403, mau.message ?? 'Sign-ups are temporarily unavailable for this app.', 'FORBIDDEN')
        }
      }
      const plan = await buildUserInsert(schema, {
        id: crypto.randomUUID(),
        email: providerUser.email,
        name: providerUser.name,
        username: providerUser.email.split('@')[0],
        avatar_url: providerUser.avatarUrl || null,
        oauth_provider: provider,
        oauth_id: providerUser.id,
      })
      const createdRows = await executeWithUserContext<any>('', true, plan.sql, plan.values)
      userId = String(createdRows[0]?.id)
      userEmail = providerUser.email
      userName = providerUser.name
    }

    // 5. Mark config used + count activity (never block auth on these).
    prisma.workspaceOAuthConfig
      .update({ where: { projectId_provider: { projectId, provider } }, data: { lastUsed: new Date() } })
      .catch(() => {})
    if (!isReservedTestEmail(userEmail)) trackEndUserActive(projectId, String(userId)).catch(() => {})
    stampLastLogin(projectId, userId).catch(() => {})

    // 6. Project-scoped JWT.
    const token = jwt.sign(
      { userId, email: userEmail, name: userName, provider, projectId, role: 'user', jti: crypto.randomUUID() },
      resolveJwtSecret(project.jwtSecret),
      { expiresIn: '7d' },
    )

    // Re-checked at redirect time even though initiate already checked it. The
    // allowlist can change between the two, and this is the moment a credential
    // actually leaves — the check belongs where the consequence is.
    const target = await resolveRedirectTarget(projectId, stateData.redirect_to)
    if (target && 'url' in target) {
      target.url.searchParams.set('token', token)
      target.url.searchParams.set('user_id', userId)
      return res.redirect(target.url.toString())
    }
    if (target && 'rejected' in target) {
      // Sign-in SUCCEEDED — the user exists and holds a valid token. Only the
      // hand-off was refused. Returning the token in the body completes the
      // flow for the legitimate caller without posting a credential to an
      // origin this project never claimed.
      console.warn(
        `[OAuth Callback] redirect_to refused for ${projectId}: ${target.rejected}`,
      )
      return res.json({
        success: true,
        user: { id: userId, email: userEmail, name: userName, provider },
        token,
        warning:
          `Signed in, but you were not redirected: ${target.rejected} ` +
          `The token is in this response instead.`,
      })
    }

    return res.json({ success: true, user: { id: userId, email: userEmail, name: userName, provider }, token })
  } catch (err: any) {
    console.error(`[OAuth Callback] Error for ${provider}:`, err)
    const safe = sanitizeDiagnostic(err)
    return jsonError(res, 500, safe ? `OAuth sign-in failed — ${safe}` : 'OAuth authentication failed', 'INTERNAL_ERROR')
  }
}

// Callback registered before the bare provider route so the extra path segment
// is matched unambiguously (Express distinguishes by segment count anyway).
router.get('/:projectId/auth/:provider/callback', handleOAuthCallback)
router.get('/:projectId/auth/:provider', handleOAuthInit)

export default router
