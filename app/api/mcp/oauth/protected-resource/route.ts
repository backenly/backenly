export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * Served at `/.well-known/oauth-protected-resource` and at the path-suffixed
 * `/.well-known/oauth-protected-resource/api/mcp` (see the rewrites in
 * next.config.js). Hosts derive the suffixed form from the resource URL, and
 * some try the bare form first, so both must answer.
 *
 * This document is the other half of the `WWW-Authenticate` header the MCP
 * route returns on 401. The header says "ask this URL"; this says "here is the
 * authorization server to use". Publishing one without the other leaves a host
 * unable to complete discovery, which is why they landed in the same change.
 *
 * Deliberately unauthenticated and cacheable — it contains no secrets and a
 * client must be able to read it precisely when it has no credential.
 */

import { NextResponse } from 'next/server'
import { appOrigin, mcpResourceUrl, SUPPORTED_SCOPES } from '@/lib/mcp/oauth'

function body() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [appOrigin()],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${appOrigin()}/docs/mcp`,
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
