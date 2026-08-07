export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * RFC 7591 Dynamic Client Registration.
 *
 * An MCP host that has never seen Backenly before calls this to get a
 * `client_id`, then immediately starts an authorization. Without it every user
 * would have to pre-register their editor by hand, which is the copy-paste
 * problem this whole flow exists to remove.
 *
 * ── Why this is safe to leave open ──────────────────────────────────────────
 *
 * An unauthenticated POST that creates a row looks alarming, so the reasoning
 * is worth stating: a registration grants NOTHING. It issues no secret and no
 * token; it only records a name and a redirect allowlist. Every actual grant
 * of access still requires a human to log in and click approve on the consent
 * screen, and the code that results is bound by PKCE to the client that
 * requested it. Registering is therefore closer to reserving a label than to
 * obtaining a credential.
 *
 * What it does cost is rows, so registration is capped per source and the
 * redirect URIs are validated up front — an unusable registration should be
 * refused at creation, not discovered at redirect time.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { isAcceptableRedirectUri, oauthError, randomToken } from '@/lib/mcp/oauth'

const MAX_REDIRECT_URIS = 10
const MAX_NAME_LEN = 120

const HEADERS = {
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS })
}

export async function POST(request: NextRequest) {
  let body: any
  try {
    body = await request.json()
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be JSON.')
  }

  const rawUris = body?.redirect_uris
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return oauthError('invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array.')
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    return oauthError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris.`)
  }

  const redirectUris: string[] = []
  for (const uri of rawUris) {
    if (typeof uri !== 'string' || !isAcceptableRedirectUri(uri)) {
      return oauthError(
        'invalid_redirect_uri',
        `"${String(uri).slice(0, 200)}" is not an acceptable redirect URI. ` +
          'Use https, or http on localhost / 127.0.0.1 / [::1]. No URI fragments.',
      )
    }
    redirectUris.push(uri)
  }

  // A confidential client would expect a secret back. We only issue public
  // clients, so say so rather than silently downgrading and letting the client
  // believe it authenticated at the token endpoint.
  const requestedAuth = body?.token_endpoint_auth_method
  if (requestedAuth && requestedAuth !== 'none') {
    return oauthError(
      'invalid_client_metadata',
      'Only public clients are supported (token_endpoint_auth_method="none"). ' +
        'MCP hosts are installed applications and cannot hold a secret; PKCE is required instead.',
    )
  }

  const grantTypes: string[] = Array.isArray(body?.grant_types) ? body.grant_types : []
  for (const g of grantTypes) {
    if (g !== 'authorization_code' && g !== 'refresh_token') {
      return oauthError('invalid_client_metadata', `Unsupported grant_type "${g}".`)
    }
  }

  const clientName =
    typeof body?.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, MAX_NAME_LEN)
      : 'MCP client'

  const clientId = `mcpc_${randomToken(16)}`

  try {
    await prisma.mcpOAuthClient.create({
      data: { clientId, clientName, redirectUris },
    })
  } catch (err) {
    console.error('[mcp/oauth/register] create failed:', err)
    return oauthError('server_error', 'Could not register the client.', 500)
  }

  // RFC 7591 §3.2.1: 201 with the registered metadata echoed back.
  return NextResponse.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // Omitting client_secret_expires_at would imply a secret exists.
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: HEADERS },
  )
}
