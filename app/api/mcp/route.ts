export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * /api/mcp — the REMOTE MCP endpoint (Streamable HTTP).
 *
 * The npm package (`npx @backenly/mcp-server`) is one way to reach Backenly
 * over MCP: it speaks stdio to the host and HTTP to us. This route is the other:
 * a host connects to this URL directly.
 *
 *   claude mcp add --transport http backenly https://backenly.com/api/mcp \
 *     --header "x-api-key: mcp_live_…"
 *
 * The official MCP SDK owns the protocol. What this route adds is the part the
 * SDK deliberately leaves to its caller, plus one compatibility decision:
 *
 *   • AUTHENTICATION first. The SDK verifies no token. A caller that fails gets
 *     HTTP 401 with WWW-Authenticate before the SDK sees the request, which is
 *     what lets a host start its OAuth browser login and refresh an expired
 *     token instead of treating the failure as the server's problem.
 *
 *   • BOTH ERAS. A 2026-07-28 request (per-request `_meta` envelope) is served
 *     by the SDK's createMcpHandler. A 2025-era one (the `initialize` handshake,
 *     2024-10-07 through 2025-11-25) is served by the SDK's own Streamable HTTP
 *     transport, statelessly, with JSON responses, which is how this endpoint
 *     answered those clients before. The branch is the SDK's own classifier, so
 *     it cannot disagree with the SDK about which era a request is.
 *
 * Stateless: every request carries its credential, so there is no session and
 * no server-initiated stream; GET answers 405.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from '@modelcontextprotocol/server'
import { authenticateMcp, wwwAuthenticate, type McpAuthResult } from '@/lib/mcp/auth'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { prisma } from '@/lib/db/prisma'
import { buildRemoteServer, type BackenlyCaller } from '@/lib/mcp/protocol/remote-server'

const modern = createMcpHandler(buildRemoteServer, {
  // 2025-era traffic is routed below instead, so it keeps its JSON answers.
  legacy: 'reject',
  // No handler emits anything before its result, so there is nothing to stream.
  responseMode: 'json',
  onerror: (err) => console.warn('[mcp] modern exchange:', err.message),
})

export function OPTIONS() {
  return optionsResponse()
}

/**
 * GET would open a server-initiated stream. This server never initiates
 * messages and holds no sessions, so 405 is the spec-sanctioned answer.
 */
export function GET() {
  return withCors(
    NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message:
            'This is a POST-only MCP endpoint (no server-initiated SSE stream). ' +
            'Send JSON-RPC requests via POST with an x-api-key header.',
        },
      },
      { status: 405 },
    ),
  )
}

export async function POST(request: NextRequest) {
  const auth = await authenticateMcp(request)
  if (!auth.success) return withCors(authChallenge(auth))

  const authInfo = await authInfoFor(auth)
  const response = (await isLegacyRequest(request))
    ? await serveLegacy(request, authInfo)
    : await modern.fetch(request, { authInfo })
  return withCors(response)
}

/**
 * One 2025-era request on a fresh instance from the same factory, through the
 * SDK's Streamable HTTP transport in stateless JSON mode.
 *
 * That transport also refuses a request whose Accept header does not name
 * text/event-stream, even when it will answer in JSON. This endpoint never
 * required that, so a client that sends only `Accept: application/json` gets it
 * added rather than a 406 it has never had to handle.
 */
async function serveLegacy(request: NextRequest, authInfo: AuthInfo): Promise<Response> {
  const accept = request.headers.get('accept') ?? ''
  const forwarded = /text\/event-stream/i.test(accept)
    ? request
    : new Request(request, { headers: withHeader(request.headers, 'accept', 'application/json, text/event-stream') })

  const server = buildRemoteServer({ authInfo, requestInfo: request })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(forwarded, { authInfo })
  } finally {
    await server.close().catch(() => {})
  }
}

function withHeader(headers: Headers, name: string, value: string): Headers {
  const next = new Headers(headers)
  next.set(name, value)
  return next
}

// ── The caller, as the SDK carries it ────────────────────────────────────────

/** Project names change rarely and every request needs one for its instructions. */
const LABEL_TTL_MS = 60_000
const labels = new Map<string, { label: string; at: number }>()

async function projectLabel(projectId: string): Promise<string> {
  const hit = labels.get(projectId)
  if (hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.label
  const project = await prisma.project
    .findUnique({ where: { id: projectId }, select: { name: true } })
    .catch(() => null)
  const label = project?.name ?? projectId
  labels.set(projectId, { label, at: Date.now() })
  return label
}

async function authInfoFor(auth: McpAuthResult): Promise<AuthInfo> {
  const extra: BackenlyCaller = {
    projectId: auth.projectId!,
    userId: auth.userId!,
    readOnly: auth.readOnly === true,
    projectLabel: await projectLabel(auth.projectId!),
  }
  return {
    token: '',
    clientId: auth.keyId ?? 'unknown',
    scopes: auth.readOnly ? ['mcp:read'] : ['mcp:read', 'mcp:write'],
    extra: extra as unknown as Record<string, unknown>,
  }
}

/**
 * Authentication failures leave as HTTP 401 with WWW-Authenticate, not as a
 * 200 carrying a JSON-RPC error. A host starts OAuth discovery, and refreshes
 * an expired token, only on a 401 challenge; a 200 tells it the call worked and
 * leaves the session broken until someone reconnects it by hand.
 */
function authChallenge(auth: McpAuthResult): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: auth.error ?? 'Authentication failed.', data: { code: auth.code } },
    },
    // Always 401, as this endpoint always answered: the challenge is what a host acts on.
    { status: 401, headers: { 'www-authenticate': wwwAuthenticate(auth) } },
  )
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
