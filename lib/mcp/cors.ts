/**
 * CORS for /api/mcp/*.
 *
 * MCP hosts (Claude Code / Cursor / Cline / Claude Desktop) call
 * us from Node — they do NOT need CORS. But a few host implementations and
 * browser-based MCP clients (debugging UIs, web playgrounds) do preflight,
 * and supporting it costs nothing and removes one whole class of "it works
 * in Postman but not in my host" reports.
 *
 * We allow * for origin because the auth token is on x-api-key, not a
 * cookie — so there is no CSRF surface to lock down per-origin.
 */

import { NextResponse } from 'next/server'

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    // `mcp-session-id` / `mcp-protocol-version` / `accept` are sent by
    // Streamable-HTTP MCP hosts hitting the remote /api/mcp endpoint directly.
    // `authorization` carries the OAuth access token; omitting it made the
    // browser-login path unusable from any browser-based host, since the
    // preflight would reject the only header that flow uses.
    'access-control-allow-headers':
      'content-type,accept,authorization,x-api-key,x-correlation-id,mcp-session-id,mcp-protocol-version',
    // `www-authenticate` must be readable by the client or it cannot discover
    // the authorization server from a 401 — the whole point of the challenge.
    'access-control-expose-headers':
      'x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,retry-after,mcp-session-id,www-authenticate',
    'access-control-max-age': '86400',
  }
}

export function optionsResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}
