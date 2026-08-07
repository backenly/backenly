/**
 * MCP OAuth 2.1 — the machinery behind browser-login install.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Installing Backenly's MCP server meant pasting `mcp_live_…` into a config
 * file. Both competing platforms answer an unauthenticated MCP request with
 * `401` + `WWW-Authenticate: Bearer resource_metadata="…"`, which is the
 * discovery hook (RFC 9728) that makes an MCP host open a browser and log the
 * user in. We answered `200` with a JSON-RPC error and published no metadata,
 * so no host could ever offer that flow — it was structurally impossible, not
 * merely unimplemented.
 *
 * ── The decision that keeps this small ──────────────────────────────────────
 *
 * An authorization does not create a parallel credential system. It creates an
 * `ApiKey` row (keyType='mcp_oauth'), and the access token is a short-lived JWT
 * that points at it. Everything already built on ApiKey therefore keeps working
 * untouched: plan quota, per-key rate limiting, usage logging, the audit trail,
 * and the read-only mode. The ApiKey row IS the connection; revoking it kills
 * every token ever issued against it, with no token blocklist to maintain.
 *
 * ── The trap this file exists to avoid ──────────────────────────────────────
 *
 * Platform session tokens are HS256 signed with the SAME `JWT_SECRET`. Without
 * a distinguishing claim, a stolen dashboard cookie would be a valid MCP access
 * token — a privilege escalation from "read the user's browser" to "drive their
 * backend". Every token minted here carries `typ: 'mcp_access_token'` and
 * `verifyAccessToken` REQUIRES it, so a platform token is refused even though
 * its signature is perfectly valid. Never relax that check.
 */

import crypto from 'crypto'
import jwt, { SignOptions, VerifyOptions } from 'jsonwebtoken'

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
const JWT_SECRET = process.env.JWT_SECRET

const ALG: SignOptions['algorithm'] = 'HS256'
const VERIFY_OPTS: VerifyOptions = { algorithms: [ALG] }

/** The claim that separates an MCP access token from a platform session JWT. */
export const ACCESS_TOKEN_TYP = 'mcp_access_token'

export const ACCESS_TOKEN_TTL_SEC = 60 * 60 // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
/**
 * Authorization codes live 5 minutes. RFC 6749 permits 10; hosts redeem within
 * a second, so a longer window buys an attacker time and buys us nothing. Not
 * shorter, because a user on a slow consent page plus clock skew is real.
 */
export const CODE_TTL_MS = 5 * 60 * 1000

export const SCOPE_READ = 'mcp:read'
export const SCOPE_WRITE = 'mcp:write'
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE]

/** Canonical public origin. Every OAuth URL is derived from this one value. */
export function appOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return raw.replace(/\/+$/, '')
}

/**
 * The protected resource identifier — the MCP endpoint itself.
 *
 * This is what lands in the token's `aud`, and what a client sends as
 * `resource` (RFC 8707). Binding the audience is what stops a token minted for
 * Backenly being replayed against another MCP server that trusts the same
 * issuer.
 */
export function mcpResourceUrl(): string {
  return `${appOrigin()}/api/mcp`
}

/** RFC 9728 metadata URL, as advertised in the WWW-Authenticate header. */
export function protectedResourceMetadataUrl(): string {
  return `${appOrigin()}/.well-known/oauth-protected-resource/api/mcp`
}

/** sha256, hex. Codes and refresh tokens are stored hashed, never in the clear. */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge`.
 *
 * S256 only. OAuth 2.1 removes the `plain` method, and accepting it here would
 * silently downgrade every public client to no protection at all — the
 * challenge would equal the verifier, so intercepting the redirect would be
 * enough to redeem the code.
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false
  // RFC 7636: 43–128 characters of the unreserved alphabet.
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(codeChallenge)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface McpAccessTokenClaims {
  iss: string
  sub: string // ApiKey id — the connection
  aud: string // mcpResourceUrl()
  exp: number
  iat: number
  jti: string
  typ: typeof ACCESS_TOKEN_TYP
  scope: string
  client_id: string
  project_id: string
}

export function mintAccessToken(input: {
  apiKeyId: string
  projectId: string
  clientId: string
  scope: string
}): { token: string; expiresIn: number } {
  const token = jwt.sign(
    {
      typ: ACCESS_TOKEN_TYP,
      scope: input.scope,
      client_id: input.clientId,
      project_id: input.projectId,
      jti: crypto.randomBytes(16).toString('hex'),
    },
    JWT_SECRET,
    {
      algorithm: ALG,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      issuer: appOrigin(),
      subject: input.apiKeyId,
      audience: mcpResourceUrl(),
    } as SignOptions,
  )
  return { token, expiresIn: ACCESS_TOKEN_TTL_SEC }
}

/**
 * Verify an access token. Returns null on ANY failure — a caller must not be
 * able to tell an expired token from a forged one from a platform token.
 */
export function verifyAccessToken(token: string): McpAccessTokenClaims | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      ...VERIFY_OPTS,
      issuer: appOrigin(),
      audience: mcpResourceUrl(),
    }) as Partial<McpAccessTokenClaims>

    // The load-bearing check. A platform session JWT verifies against the same
    // secret and would otherwise be accepted here.
    if (decoded.typ !== ACCESS_TOKEN_TYP) return null
    if (!decoded.sub || !decoded.project_id) return null

    return decoded as McpAccessTokenClaims
  } catch {
    return null
  }
}

/** True when the granted scope permits mutation. */
export function scopeAllowsWrite(scope: string | null | undefined): boolean {
  if (!scope) return false
  return scope.split(/\s+/).includes(SCOPE_WRITE)
}

/**
 * Redirect URI matching — exact string comparison against the registered set.
 *
 * Deliberately not prefix or origin matching. A registered
 * `http://localhost:8080/callback` that matched by prefix would also accept
 * `http://localhost:8080/callback.evil.com`, and open-redirecting an
 * authorization code is the whole attack this list prevents. Loopback ports
 * vary per launch, so hosts register the exact URI at DCR time and we hold them
 * to it.
 */
export function isRegisteredRedirect(uri: string, registered: string[]): boolean {
  return registered.includes(uri)
}

/**
 * Reject redirect URIs we will never honour, at registration time.
 *
 * Only https, or http on an explicit loopback host. Plain http anywhere else
 * would send an authorization code across the network in the clear, and a
 * custom scheme (`myapp://`) cannot be verified as belonging to the registrant.
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.hash) return false // RFC 6749: redirect URIs must not carry a fragment
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol === 'http:') {
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    )
  }
  return false
}

/** Standard OAuth error body (RFC 6749 §5.2). */
export function oauthError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}
