export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * OAuth authorization endpoint (RFC 6749 §3.1, OAuth 2.1 rules).
 *
 *   GET  — validate the request, then send the user to log in or to consent.
 *   POST — the consent form submits here; mints the authorization code.
 *
 * ── The ordering rule that matters ──────────────────────────────────────────
 *
 * `client_id` and `redirect_uri` are validated BEFORE anything else, and a
 * failure on either renders an error page instead of redirecting. Redirecting
 * an error to an unverified `redirect_uri` is how an authorization endpoint
 * becomes an open redirect; once the URI is confirmed to be registered, later
 * failures may travel back to it as RFC-shaped `?error=` parameters.
 *
 * ── Why consent is a signed round-trip ──────────────────────────────────────
 *
 * The consent page is same-origin and the platform session is a cookie, so a
 * plain form POST here would be CSRF-able: an attacker who registered a client
 * could get a logged-in victim's browser to approve a connection to the
 * VICTIM's project and redirect the code to the ATTACKER's URI — and PKCE would
 * not help, because the attacker holds the verifier.
 *
 * So the GET signs the validated request into a short-lived `req` token, and
 * the consent page turns that into a `confirm` token that additionally carries
 * the logged-in user's id. The POST requires a valid `confirm` whose `uid`
 * equals the current session's user. That token is only ever rendered into the
 * victim's own page, which an attacker's origin cannot read.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { verifyToken } from '@/lib/auth/jwt'
import { CONFIRM_TYP, REQ_TYP, signAuthzToken, verifyAuthzToken } from '@/lib/mcp/oauth-authz'
import {
  appOrigin,
  CODE_TTL_MS,
  hashToken,
  isRegisteredRedirect,
  mcpResourceUrl,
  randomToken,
  SCOPE_READ,
  SCOPE_WRITE,
} from '@/lib/mcp/oauth'
import { canAdministerProject } from '@/lib/edition/guard'

/** An error we must NOT send to the client's redirect_uri. */
function localError(message: string, detail: string) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
      `<div style="font:15px/1.6 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.5rem;color:#e6e6e6;background:#101116">` +
      `<h1 style="font-size:1.05rem;margin:0 0 .5rem">${message}</h1>` +
      `<p style="color:#9a9aa2;margin:0">${detail}</p></div>`,
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

/** An RFC-shaped error that is safe to send back to a verified redirect_uri. */
function redirectError(redirectUri: string, error: string, description: string, state?: string) {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', description)
  if (state) url.searchParams.set('state', state)
  return NextResponse.redirect(url.toString(), { status: 303 })
}

function sessionUserId(request: NextRequest): string | null {
  const bearer = request.headers.get('authorization')
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : request.cookies.get('auth-token')?.value
  if (!token) return null
  const payload = verifyToken(token)
  return payload?.userId ?? null
}

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams

  const clientId = p.get('client_id')
  const redirectUri = p.get('redirect_uri')
  if (!clientId || !redirectUri) {
    return localError('Missing parameters', 'client_id and redirect_uri are both required.')
  }

  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } })
  if (!client) {
    return localError(
      'Unknown client',
      'This client_id is not registered. The MCP host should register at /api/mcp/oauth/register before starting an authorization.',
    )
  }
  if (!isRegisteredRedirect(redirectUri, client.redirectUris)) {
    // Never redirect here — the URI is exactly what we failed to trust.
    return localError(
      'Unregistered redirect URI',
      'This redirect_uri was not registered by the client. It must match one of the registered URIs exactly.',
    )
  }

  // From here on the URI is trusted, so failures may travel back to it.
  const state = p.get('state') ?? undefined

  if (p.get('response_type') !== 'code') {
    return redirectError(redirectUri, 'unsupported_response_type', 'Only response_type=code is supported.', state)
  }

  const codeChallenge = p.get('code_challenge')
  const method = p.get('code_challenge_method')
  if (!codeChallenge) {
    return redirectError(redirectUri, 'invalid_request', 'PKCE is required: code_challenge is missing.', state)
  }
  if (method !== 'S256') {
    return redirectError(
      redirectUri,
      'invalid_request',
      'code_challenge_method must be S256. The plain method is not accepted.',
      state,
    )
  }

  // RFC 8707. Optional, but when sent it must name this server, or the client
  // is asking us to mint a token for someone else's resource.
  const resource = p.get('resource') ?? undefined
  if (resource && resource.replace(/\/+$/, '') !== mcpResourceUrl()) {
    return redirectError(redirectUri, 'invalid_target', `Unknown resource "${resource}".`, state)
  }

  const requested = (p.get('scope') || `${SCOPE_READ} ${SCOPE_WRITE}`).split(/\s+/).filter(Boolean)
  const unknown = requested.filter((s) => s !== SCOPE_READ && s !== SCOPE_WRITE)
  if (unknown.length) {
    return redirectError(redirectUri, 'invalid_scope', `Unknown scope "${unknown[0]}".`, state)
  }
  const scope = requested.join(' ')

  const req = signAuthzToken({ client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, scope, state, resource }, REQ_TYP)

  // Not signed in: bounce through login and come straight back here. The login
  // page sanitises `redirect`, and this URL is same-origin, so the round trip
  // preserves the whole authorization request without us storing anything.
  if (!sessionUserId(request)) {
    const back = new URL('/auth/login', appOrigin())
    back.searchParams.set('redirect', `/api/mcp/oauth/authorize?${p.toString()}`)
    return NextResponse.redirect(back.toString(), { status: 303 })
  }

  const consent = new URL('/mcp/authorize', appOrigin())
  consent.searchParams.set('req', req)
  return NextResponse.redirect(consent.toString(), { status: 303 })
}

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null)
  if (!form) return localError('Bad request', 'Expected a form submission.')

  const confirmToken = String(form.get('confirm') ?? '')
  const projectId = String(form.get('project_id') ?? '')
  const readOnly = String(form.get('read_only') ?? '') === 'on'
  const decision = String(form.get('decision') ?? '')

  const confirm = verifyAuthzToken(confirmToken, CONFIRM_TYP)
  if (!confirm) {
    return localError('This approval expired', 'Start the connection again from your MCP host.')
  }

  // The CSRF check: the confirmation must belong to whoever is signed in now.
  const uid = sessionUserId(request)
  if (!uid || uid !== confirm.uid) {
    return localError('Session mismatch', 'Sign in again and retry the connection.')
  }

  if (decision !== 'approve') {
    return redirectError(confirm.redirect_uri, 'access_denied', 'The user declined.', confirm.state)
  }

  if (!(await canAdministerProject(uid, projectId))) {
    return redirectError(confirm.redirect_uri, 'access_denied', 'Project not found.', confirm.state)
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  })
  if (!project) {
    return redirectError(confirm.redirect_uri, 'access_denied', 'Project not found.', confirm.state)
  }

  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: confirm.client_id } })
  if (!client) {
    return localError('Unknown client', 'This client registration no longer exists.')
  }

  // Read-only is the human's choice here, and it narrows the granted scope. A
  // client that asked for mcp:write does NOT get it if the user said read-only:
  // the consent screen outranks the request, which is the point of consent.
  const grantedScope = readOnly ? SCOPE_READ : confirm.scope

  // The connection. An ApiKey row so quota, rate limiting, usage logging, audit
  // and the read-only enforcement all apply with no new code paths. It carries
  // no usable plaintext key — `keyHash` is random and matches nothing a caller
  // could present, so this row is reachable only by an access token naming it.
  const connection = await prisma.apiKey.create({
    data: {
      name: client.clientName,
      keyHash: `oauth:${randomToken(32)}`,
      keyPrefix: 'mcp_oauth_',
      projectId: project.id,
      userId: uid,
      permissions: readOnly ? ['read'] : ['read', 'write', 'admin'],
      rateLimit: 600,
      keyType: 'mcp_oauth',
      scope: 'mcp',
      serviceRole: true,
      mcpReadOnly: readOnly,
      mcpClientLabel: client.clientName,
    },
  })

  const code = randomToken(32)
  await prisma.mcpOAuthCode.create({
    data: {
      codeHash: hashToken(code),
      clientId: client.clientId,
      apiKeyId: connection.id,
      redirectUri: confirm.redirect_uri,
      codeChallenge: confirm.code_challenge,
      scope: grantedScope,
      resource: confirm.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  })

  await prisma.auditLog
    .create({
      data: {
        projectId: project.id,
        userId: uid,
        action: 'MCP_OAUTH_AUTHORIZED',
        type: 'security',
        details: JSON.stringify({
          clientId: client.clientId,
          clientName: client.clientName,
          connectionId: connection.id,
          readOnly,
          scope: grantedScope,
          at: new Date().toISOString(),
        }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})

  const url = new URL(confirm.redirect_uri)
  url.searchParams.set('code', code)
  if (confirm.state) url.searchParams.set('state', confirm.state)
  return NextResponse.redirect(url.toString(), { status: 303 })
}
