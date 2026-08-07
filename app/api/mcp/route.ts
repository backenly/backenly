export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/mcp — the REMOTE MCP endpoint (Streamable HTTP transport).
 *
 * The npm package (`npx @backenly/mcp-server`) is one way to reach Backenly over
 * MCP: it speaks stdio to the host and HTTP to us. This route is the OTHER way —
 * an MCP host connects to this URL DIRECTLY, no local Node process, no npx:
 *
 *   claude mcp add --transport http backenly https://backenly.com/api/mcp \
 *     --header "x-api-key: mcp_live_…"
 *
 * It is a thin JSON-RPC ⇄ HTTP translator. It does NOT re-implement tool
 * dispatch — `tools/call` DELEGATES in-process to the exact same proven
 * handlers the npm package hits (`/api/mcp/chat`, `/api/mcp/tool`), so the two
 * transports can never drift and every governance guarantee (auth, quota,
 * rate-limit, approval escalation, audit) applies identically. The only logic
 * here is the wire protocol: initialize / tools.list / tools.call / ping.
 *
 * Stateless by design: every request carries `x-api-key`, so there is no
 * session to keep. We return no `Mcp-Session-Id` and offer no GET SSE stream —
 * both are optional in the spec for a server that never initiates messages.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateMcp, wwwAuthenticate, type McpAuthResult } from '@/lib/mcp/auth'
import { buildCatalog } from '@/lib/mcp/catalog'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { prisma } from '@/lib/db/prisma'
import { POST as toolCall } from './tool/route'
import { POST as chatCall } from './chat/route'
import { leanForAgent } from '@/lib/mcp/agent-response'

const SERVER_NAME = 'backenly'
const SERVER_VERSION = '1.0.0'
// We implement these MCP revisions; on initialize we echo the client's version
// when it is one of them, else fall back to the newest we speak.
const DEFAULT_PROTOCOL = '2025-06-18'
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])

export function OPTIONS() {
  return optionsResponse()
}

/**
 * GET has no body to act on. A Streamable-HTTP server MAY open an SSE stream
 * here for server-initiated messages; we never send any, so 405 is the correct,
 * spec-sanctioned answer ("the server does not offer an SSE stream at this
 * endpoint"). Answered as JSON-RPC so a confused host still gets a clean shape.
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
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return withCors(
      NextResponse.json(rpcError(null, -32700, 'Parse error: request body is not valid JSON.'), { status: 400 }),
    )
  }

  // JSON-RPC batching: an array of messages. Notifications/responses in the
  // batch produce no reply, so the response array can be shorter than the input.
  if (Array.isArray(payload)) {
    const out: object[] = []
    for (const msg of payload) {
      const reply = await handleMessage(msg, request)
      if (reply) out.push(reply)
    }
    if (out.length === 0) return withCors(new NextResponse(null, { status: 202 }))
    // If anything in the batch failed auth, the whole batch is a 401 challenge —
    // a host retrying after login is the only useful next step either way.
    const challenge = out.map((r) => AUTH_CHALLENGE.get(r)).find(Boolean)
    if (challenge) {
      return withCors(
        NextResponse.json(out, { status: 401, headers: { 'www-authenticate': challenge } }),
      )
    }
    return withCors(NextResponse.json(out))
  }

  const reply = await handleMessage(payload, request)
  // A notification (no id / notifications/*) gets an empty 202, not a JSON-RPC body.
  if (!reply) return withCors(new NextResponse(null, { status: 202 }))
  return rpcResponse(reply)
}

/**
 * Route one JSON-RPC message. Returns the response object, or `null` when the
 * message is a notification or a client→server response that needs no reply.
 */
async function handleMessage(msg: any, request: NextRequest): Promise<object | null> {
  const method: unknown = msg?.method
  const id = msg?.id ?? null

  // No method → this is a response to something WE sent (we never send
  // requests, so just ignore it). Notifications (`notifications/*`) also get no
  // reply per JSON-RPC.
  if (typeof method !== 'string') return null
  if (method.startsWith('notifications/')) return null

  switch (method) {
    case 'initialize':
      return handleInitialize(id, msg?.params, request)
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return handleToolsList(id, request)
    case 'tools/call':
      return handleToolsCall(id, msg?.params, request)
    // We advertise only `tools`. Answer these probes with empty sets anyway —
    // friendlier than method-not-found for hosts that enumerate every surface.
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

async function handleInitialize(id: any, params: any, request: NextRequest): Promise<object> {
  const auth = await authenticateMcp(request)
  if (!auth.success) return authRpcError(id, auth)

  const project = await prisma.project
    .findUnique({ where: { id: auth.projectId! }, select: { name: true } })
    .catch(() => null)
  const label = project?.name ?? auth.projectId!
  const toolCount = buildCatalog({ readOnly: auth.readOnly }).length

  const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null
  const protocolVersion = requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL

  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: buildInstructions(label, toolCount),
  })
}

async function handleToolsList(id: any, request: NextRequest): Promise<object> {
  const auth = await authenticateMcp(request)
  if (!auth.success) return authRpcError(id, auth)

  const tools = buildCatalog({ readOnly: auth.readOnly }).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
  return rpcResult(id, { tools })
}

async function handleToolsCall(id: any, params: any, request: NextRequest): Promise<object> {
  const name = params?.name
  const args = (params?.arguments ?? {}) as Record<string, unknown>
  if (typeof name !== 'string' || !name) {
    return rpcError(id, -32602, 'Invalid params: tools/call requires a string `name`.')
  }

  const apiKey = request.headers.get('x-api-key') ?? ''
  const origin = request.nextUrl.origin

  // Route exactly like the stdio server does: natural language goes to the
  // brain (/api/mcp/chat); everything else goes to the typed dispatcher
  // (/api/mcp/tool), which already handles db_*, apply_migration,
  // read_backend_state sections, destructive refusal, and the synthetic tools.
  const isChat = name === 'backend_chat'
  const targetPath = isChat ? '/api/mcp/chat' : '/api/mcp/tool'
  const forwardBody = isChat
    ? { message: typeof args.message === 'string' ? args.message : '' }
    : { tool: name, args }

  let body: any = {}
  let status = 200
  try {
    const proxied = proxyRequest(origin, targetPath, apiKey, forwardBody)
    const res = isChat ? await chatCall(proxied) : await toolCall(proxied)
    status = res.status
    body = await res.json().catch(() => ({}))
  } catch (err) {
    // A crash in a delegated handler must not take down the JSON-RPC channel —
    // report it to the agent as a tool error it can read and recover from.
    const message = err instanceof Error ? err.message : String(err)
    return rpcResult(id, {
      content: [{ type: 'text', text: `Backenly tool "${name}" failed: ${message}` }],
      isError: true,
    })
  }

  const ok = body?.ok !== false && status >= 200 && status < 300
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(leanForAgent(body), null, 2) }],
    isError: !ok,
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Synthesize the request the delegated REST handler expects. It carries the
 * same `x-api-key`, so auth / quota / rate-limit / audit all run identically to
 * a direct call. A full URL is used so the handler's `request.nextUrl.origin`
 * (e.g. fetch_docs) resolves correctly.
 */
function proxyRequest(origin: string, path: string, apiKey: string, body: unknown): NextRequest {
  return new NextRequest(new URL(path, origin).toString(), {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

function buildInstructions(projectLabel: string, toolCount: number): string {
  const project = projectLabel ? `"${projectLabel}"` : 'this project'
  return [
    `Backenly is connected. You now have live, governed access to ${project}'s backend`,
    `through ${toolCount} Backenly tools — no backend code required.`,
    ``,
    `WHAT YOU CAN BUILD: database tables, REST APIs, auth & end-user accounts, file storage,`,
    `realtime, event triggers, row-level-security policies, and serverless functions. Every`,
    `change is planned, verified, journaled with a receipt, and reversible; destructive or`,
    `auth-touching changes require explicit human approval.`,
    ``,
    `ON YOUR FIRST REPLY of this session, briefly tell the user Backenly is connected to`,
    `${project} and ask what they'd like to build or change. Keep it to a sentence or two.`,
    ``,
    `OPERATING RULES:`,
    `- Ground decisions in real state: call read_backend_state before proposing or making`,
    `  changes. Never guess at tables or config.`,
    `- For natural-language builds ("add a posts table with comments"), use backend_chat.`,
    `  For precise reads and row writes, use run_query / apply_migration / db_* directly.`,
    `- Never fabricate results. If a tool returns nothing or errors, say so plainly.`,
  ].join('\n')
}

function rpcResult(id: any, result: object): object {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcError(id: any, code: number, message: string, data?: unknown): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/** Map an MCP auth failure onto a JSON-RPC error carrying the machine code. */
/**
 * Auth failures must leave as HTTP 401 carrying `WWW-Authenticate`, not as a
 * 200 with a JSON-RPC error inside.
 *
 * This was the single reason no MCP host could offer browser login for
 * Backenly. A host starts OAuth discovery on a 401 challenge; a 200 tells it
 * the call succeeded and the error is the server's problem, so it never looks
 * for an authorization server and the user is left pasting an API key.
 *
 * The handlers here return plain JSON-RPC objects, so the challenge is carried
 * out-of-band on this map rather than by changing every handler's return type.
 */
const AUTH_CHALLENGE = new WeakMap<object, string>()

function authRpcError(id: any, auth: McpAuthResult): object {
  const reply = rpcError(id, -32001, auth.error ?? 'Authentication failed.', { code: auth.code })
  AUTH_CHALLENGE.set(reply, wwwAuthenticate(auth))
  return reply
}

/** Wrap a JSON-RPC reply, upgrading auth failures to a 401 challenge. */
function rpcResponse(reply: object): NextResponse {
  const challenge = AUTH_CHALLENGE.get(reply)
  if (!challenge) return withCors(NextResponse.json(reply))
  return withCors(
    NextResponse.json(reply, { status: 401, headers: { 'www-authenticate': challenge } }),
  )
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
