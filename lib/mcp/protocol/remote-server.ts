/**
 * The remote MCP server, as the official SDK serves it.
 *
 * app/api/mcp/route.ts used to speak the wire protocol by hand: initialize,
 * tools/list, tools/call and ping, for the 2024 and 2025 revisions only, with
 * resources and prompts answered as empty lists. The SDK now owns the protocol
 * (both eras, negotiation, envelopes, error codes); this module only says what
 * the server contains, for one authenticated request.
 *
 * It implements nothing itself. tools/call and resources/read delegate in
 * process to the same handlers the stdio package and the CLI reach over HTTP
 * (/api/mcp/tool and /api/mcp/chat), carrying the caller's own credential, so
 * authentication, quota, rate limits, read-only refusal, approvals and audit
 * run exactly as they do on every other path.
 */

import { NextRequest } from 'next/server'
import { ResourceNotFoundError, Server } from '@modelcontextprotocol/server'
import type { AuthInfo, Tool } from '@modelcontextprotocol/server'
import { buildCatalog } from '@/lib/mcp/catalog'
import { forwardedCredentialHeaders } from '@/lib/mcp/forward-credential'
import { POST as toolCall } from '@/app/api/mcp/tool/route'
import { POST as chatCall } from '@/app/api/mcp/chat/route'
import { buildMcpInstructions, MCP_RESOURCES, publicResources, shapeToolResult } from './shared'

export const REMOTE_SERVER_INFO = { name: 'backenly', version: '2.0.0' }

/** What the route verified about the caller, carried to the factory as AuthInfo.extra. */
export interface BackenlyCaller {
  projectId: string
  userId: string
  readOnly: boolean
  projectLabel: string
}

export function callerOf(authInfo: AuthInfo | undefined): BackenlyCaller | null {
  const extra = authInfo?.extra as Partial<BackenlyCaller> | undefined
  return extra?.projectId && extra.userId ? (extra as BackenlyCaller) : null
}

/** The catalog as tools/list serves it. Its schemas are plain JSON Schema. */
export function mcpTools(readOnly: boolean): Tool[] {
  return buildCatalog({ readOnly }).map((t) => ({
    name: t.name,
    ...(t.annotations?.title ? { title: t.annotations.title } : {}),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  })) as unknown as Tool[]
}

/** A request for a delegated handler, carrying the caller's own credential. */
function delegatedRequest(original: Request, path: string, body: unknown): NextRequest {
  return new NextRequest(new URL(path, original.url).toString(), {
    method: 'POST',
    headers: { ...forwardedCredentialHeaders(original.headers), 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/** Run one tool through the handler every other path uses, and shape the result. */
async function callTool(name: string, args: Record<string, unknown>, original: Request) {
  const isChat = name === 'backend_chat'
  const request = isChat
    ? delegatedRequest(original, '/api/mcp/chat', { message: typeof args.message === 'string' ? args.message : '' })
    : delegatedRequest(original, '/api/mcp/tool', { tool: name, args })
  try {
    const res = isChat ? await chatCall(request) : await toolCall(request)
    const body = await res.json().catch(() => ({}))
    const ok = (body as { ok?: unknown })?.ok !== false && res.status >= 200 && res.status < 300
    return shapeToolResult(body, ok)
  } catch (err) {
    // A crash in a delegated handler must not take down the exchange: the agent
    // gets an error it can read. Nothing is claimed about what ran.
    const message = err instanceof Error ? err.message : String(err)
    return shapeToolResult({ ok: false, error: `Backenly tool "${name}" failed: ${message}`, code: 'HANDLER_CRASHED' }, false)
  }
}

/**
 * The server for one request. Cheap and side-effect free, as the SDK requires
 * of a factory: everything it needs was resolved by the route before it ran.
 */
export function buildRemoteServer({ authInfo, requestInfo }: { authInfo?: AuthInfo; requestInfo?: Request }): Server {
  const caller = callerOf(authInfo)
  // The route authenticates before the SDK sees a request, so reaching here
  // without a caller is a wiring bug, not a client error.
  if (!caller || !requestInfo) throw new Error('MCP server built without an authenticated caller')

  const tools = mcpTools(caller.readOnly)
  const server = new Server(REMOTE_SERVER_INFO, {
    capabilities: { tools: { listChanged: false }, resources: {} },
    instructions: buildMcpInstructions(caller.projectLabel, tools.length),
  })

  server.setRequestHandler('tools/list', async () => ({ tools }))

  server.setRequestHandler('tools/call', async (req) => {
    const result = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, requestInfo)
    return server.projectCallToolResult(result, undefined)
  })

  server.setRequestHandler('resources/list', async () => ({ resources: publicResources() }))

  server.setRequestHandler('resources/read', async (req) => {
    const resource = MCP_RESOURCES.find((r) => r.uri === req.params.uri)
    if (!resource) {
      throw new ResourceNotFoundError(req.params.uri, `Unknown resource: ${req.params.uri}. Available: ${MCP_RESOURCES.map((r) => r.uri).join(', ')}`)
    }
    const result = await callTool(resource.tool, {}, requestInfo)
    if (result.isError) {
      throw new Error(String(result.structuredContent.error ?? `Could not read ${resource.uri}`))
    }
    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: result.content[0].text }] }
  })

  return server
}
