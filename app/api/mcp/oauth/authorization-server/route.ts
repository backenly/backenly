export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * Served at `/.well-known/oauth-authorization-server` via a rewrite. A host
 * reads this to learn where to register, where to send the user, and which
 * PKCE method to use — so every value here is a promise the endpoints must keep.
 *
 * Two entries are load-bearing and deliberately narrow:
 *
 *   • `code_challenge_methods_supported: ["S256"]` — advertising `plain` would
 *     let a client downgrade PKCE to nothing, since a plain challenge equals
 *     the verifier. OAuth 2.1 removes it; so do we.
 *   • `token_endpoint_auth_methods_supported: ["none"]` — MCP hosts are
 *     installed applications and cannot hold a secret. Claiming otherwise would
 *     invite a client to send one and believe it meant something. PKCE plus the
 *     exact-match redirect allowlist is what binds a code to its client.
 */

import { NextResponse } from 'next/server'
import { appOrigin, SUPPORTED_SCOPES } from '@/lib/mcp/oauth'

function body() {
  const origin = appOrigin()
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    revocation_endpoint: `${origin}/api/mcp/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SUPPORTED_SCOPES,
    service_documentation: `${origin}/docs/mcp`,
  }
}

const HEADERS = {
  'cache-control': 'public, max-age=3600',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version',
}

export function GET() {
  return NextResponse.json(body(), { headers: HEADERS })
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS })
}
