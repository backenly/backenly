/**
 * The remote MCP endpoint (/api/mcp) as MCP clients see it, in both eras.
 *
 * The official SDK serves the protocol now, so these drive the route with the
 * official client: a 2025-era client (the `initialize` handshake) and a
 * 2026-07-28 client (`server/discover`, a `_meta` envelope on every request).
 * Each connects through the route's own POST handler, in process, carrying a
 * credential the way a host does.
 *
 * The delegated handlers (/api/mcp/tool and /api/mcp/chat) are replaced by
 * fixtures answering what those handlers answer, and the route's
 * authentication is stubbed per credential. What is under test is everything
 * between: negotiation, the catalog each key is served, result shapes, auth
 * challenges and their refresh, resources, and refusal of what the endpoint
 * does not serve. No database is reached.
 */

import '../helpers/real-web-standard'
import { NextRequest, NextResponse } from 'next/server'

const mockCalls: { path: string; body: any }[] = []

const mockToolAnswers: Record<string, [number, Record<string, unknown>]> = {
  read_backend_state: [200, { ok: true, summary: '2 tables', data: { tables: ['posts', 'users'] }, needsUser: false, timing: { ms: 3, heavy: false } }],
  list_tables: [200, { ok: true, summary: '1 table', data: [{ name: 'posts' }], needsUser: false }],
  apply_migration: [400, {
    ok: false,
    summary: 'The migration stopped at statement 2.',
    error: 'column "title" already exists',
    code: 'CONSTRAINT_CONFLICT',
    hint: 'Drop the ADD COLUMN for title; it is already there.',
    applied: [{ summary: 'Created table posts' }],
    data: null,
    needsUser: false,
  }],
}

const mockChatAnswer = {
  ok: true,
  summary: 'Dropping posts needs a human: parked for approval.',
  status: 'awaiting_approval',
  approval: { id: 'apr_1', status: 'pending', poll: 'check_approval', note: 'A project owner approves this in the dashboard.' },
  needsUser: true,
  timing: { ms: 12 },
}

jest.mock('@/app/api/mcp/tool/route', () => ({
  POST: jest.fn(async (req: NextRequest) => {
    const body = await req.json()
    mockCalls.push({ path: '/api/mcp/tool', body })
    const answer = mockToolAnswers[body.tool]
    if (!answer) return NextResponse.json({ ok: false, error: `Unknown MCP tool "${body.tool}".`, code: 'UNKNOWN_TOOL' }, { status: 404 })
    return NextResponse.json(answer[1], { status: answer[0] })
  }),
}))
jest.mock('@/app/api/mcp/chat/route', () => ({
  POST: jest.fn(async (req: NextRequest) => {
    const body = await req.json()
    mockCalls.push({ path: '/api/mcp/chat', body })
    return NextResponse.json(mockChatAnswer)
  }),
}))
jest.mock('@/lib/db/prisma', () => ({
  prisma: { project: { findUnique: jest.fn(async () => ({ name: 'Demo' })) } },
}))
jest.mock('@/lib/mcp/auth', () => {
  const actual = jest.requireActual('@/lib/mcp/auth')
  return {
    ...actual,
    authenticateMcp: jest.fn(async (req: NextRequest) => {
      const bearer = req.headers.get('authorization')
      const key = req.headers.get('x-api-key')
      if (bearer === 'Bearer expired') {
        return { success: false, status: 401, code: 'INVALID_TOKEN', error: 'The access token is invalid or expired.' }
      }
      if (bearer === 'Bearer refreshed' || key === 'read-write-test-credential') {
        return { success: true, projectId: 'p1', userId: 'u1', keyId: 'k1', readOnly: false }
      }
      if (key === 'read-only-test-credential') {
        return { success: true, projectId: 'p1', userId: 'u1', keyId: 'k2', readOnly: true }
      }
      return { success: false, status: 401, code: 'NO_AUTH', error: 'Missing x-api-key header or Bearer token.' }
    }),
  }
})

import { Client, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client'
import { GET, OPTIONS, POST } from '@/app/api/mcp/route'
import { mcpTools } from '@/lib/mcp/protocol/remote-server'
import { buildMcpInstructions, publicResources } from '@/lib/mcp/protocol/shared'

const URL_ = 'https://backenly.test/api/mcp'
const RW = { 'x-api-key': 'read-write-test-credential' }
const RO = { 'x-api-key': 'read-only-test-credential' }
type Era = 'legacy' | 'modern'

/** The route, as a fetch: what a host reaches over the network. */
async function routeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method === 'POST') return POST(new NextRequest(url.toString(), init as any))
  if (method === 'OPTIONS') return OPTIONS()
  if (method === 'GET') return GET()
  return new Response(null, { status: 405 })
}

async function connect(era: Era, opts: { headers?: Record<string, string>; authProvider?: AuthProvider } = {}) {
  const client = new Client({ name: 'protocol-test', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {})
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: opts.headers ?? {} },
    ...(opts.authProvider ? { authProvider: opts.authProvider } : {}),
    fetch: routeFetch as any,
  })
  await client.connect(transport)
  return client
}

const lean = ({ timing: _t, events: _e, partialEvents: _p, ...rest }: Record<string, unknown>) => rest

function raw(body: unknown, headers: Record<string, string> = RW, accept = 'application/json, text/event-stream') {
  return POST(new NextRequest(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

beforeEach(() => { mockCalls.length = 0 })

describe.each<Era>(['legacy', 'modern'])('remote endpoint, %s era', (era) => {
  let client: Client
  beforeAll(async () => { client = await connect(era, { headers: RW }) })
  afterAll(async () => { await client.close() })

  it('negotiates the revision of its era', () => {
    expect(client.getProtocolEra()).toBe(era)
    expect(client.getNegotiatedProtocolVersion()).toBe(era === 'modern' ? '2026-07-28' : '2025-11-25')
  })

  it('serves the instructions the stdio package is given, naming the project', () => {
    expect(client.getInstructions()).toBe(buildMcpInstructions('Demo', mcpTools(false).length))
    const caps = client.getServerCapabilities()!
    expect(caps.tools).toEqual({ listChanged: false })
    expect(caps.resources).toBeDefined()
  })

  it('lists the full catalog, with titles and annotations, to a read-write key', async () => {
    const { tools } = await client.listTools()
    expect(tools).toEqual(mcpTools(false))
    expect(tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean')).toBe(true)
  })

  it('returns a successful call as the handler body, as text and as structuredContent', async () => {
    const result: any = await client.callTool({ name: 'read_backend_state', arguments: {} })
    const expected = lean(mockToolAnswers.read_backend_state[1])
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual(expected)
    expect(result.content).toHaveLength(1)
    expect(JSON.parse(result.content[0].text)).toEqual(expected)
  })

  it('returns a refusal with its code, hint and what already landed', async () => {
    const result: any = await client.callTool({ name: 'apply_migration', arguments: { sql: 'x' } })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'CONSTRAINT_CONFLICT', applied: [{ summary: 'Created table posts' }] })
    expect(result.content[1].text).toMatch(/ALREADY APPLIED, do not repeat: Created table posts/)
  })

  it('routes backend_chat to the brain and keeps its approval object, adding nothing', async () => {
    const result: any = await client.callTool({ name: 'backend_chat', arguments: { message: 'drop posts' } })
    expect(mockCalls).toEqual([{ path: '/api/mcp/chat', body: { message: 'drop posts' } }])
    expect(result.structuredContent).toEqual(lean(mockChatAnswer))
    for (const absent of ['toolsRun', 'iterations', 'verified', 'applied', 'partial']) {
      expect(result.structuredContent).not.toHaveProperty(absent)
    }
  })

  it('passes a tool it does not advertise to the handler, which decides', async () => {
    const result: any = await client.callTool({ name: 'no_such_tool', arguments: {} })
    expect(mockCalls).toEqual([{ path: '/api/mcp/tool', body: { tool: 'no_such_tool', args: {} } }])
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('UNKNOWN_TOOL')
  })

  it('lists its resources and reads one through its read-only tool', async () => {
    const { resources } = await client.listResources()
    expect(resources).toEqual(publicResources())
    const read = await client.readResource({ uri: 'backenly://tables' })
    expect(mockCalls).toEqual([{ path: '/api/mcp/tool', body: { tool: 'list_tables', args: {} } }])
    expect(JSON.parse((read.contents[0] as any).text)).toEqual(lean(mockToolAnswers.list_tables[1]))
  })

  it('refuses an unknown resource as invalid params, naming the uri', async () => {
    await expect(client.readResource({ uri: 'backenly://nope' })).rejects.toMatchObject({ code: -32602 })
  })

  it('serves a read-only key only the read-only catalog', async () => {
    const ro = await connect(era, { headers: RO })
    try {
      const { tools } = await ro.listTools()
      expect(tools).toEqual(mcpTools(true))
      expect(tools.length).toBeLessThan(mcpTools(false).length)
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
      expect(ro.getInstructions()).toBe(buildMcpInstructions('Demo', mcpTools(true).length))
    } finally {
      await ro.close()
    }
  })

  it('answers an expired token with a challenge, and the client refreshes and retries', async () => {
    let token = 'expired'
    const challenges: string[] = []
    const authProvider: AuthProvider = {
      token: async () => token,
      onUnauthorized: async ({ response }) => {
        challenges.push(response.headers.get('www-authenticate') ?? '')
        token = 'refreshed'
      },
    }
    const refreshed = await connect(era, { authProvider })
    try {
      expect(challenges).toHaveLength(1)
      expect(challenges[0]).toContain('error="invalid_token"')
      expect(challenges[0]).toContain('resource_metadata=')
      const { tools } = await refreshed.listTools()
      expect(tools.length).toBe(mcpTools(false).length)
    } finally {
      await refreshed.close()
    }
  })

  it('refuses a client with no credential, with the challenge that starts OAuth', async () => {
    await expect(connect(era)).rejects.toThrow()
  })
})

describe('the remote endpoint on the wire', () => {
  const initialize = (protocolVersion: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  })

  it.each(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])('answers a %s initialize in that revision', async (version) => {
    const res = await raw(initialize(version))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.protocolVersion).toBe(version)
    expect(body.result.instructions).toBe(buildMcpInstructions('Demo', mcpTools(false).length))
  })

  it('answers a revision it does not know with one it does', async () => {
    const body = await (await raw(initialize('2023-01-01'))).json()
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('still answers a 2025 client that only accepts application/json', async () => {
    const res = await raw(initialize('2025-06-18'), RW, 'application/json')
    expect(res.status).toBe(200)
    expect((await res.json()).result.protocolVersion).toBe('2025-06-18')
  })

  it('serves tools/list statelessly, without a prior initialize', async () => {
    const body = await (await raw({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).json()
    expect(body.result.tools).toEqual(mcpTools(false))
  })

  it('answers a missing credential with 401 and WWW-Authenticate, in both eras', async () => {
    for (const message of [
      initialize('2025-06-18'),
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    ]) {
      const res = await raw(message, {})
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm="backenly", resource_metadata="/)
      expect(res.headers.get('access-control-expose-headers')).toContain('www-authenticate')
      const body = await res.json()
      expect(body.error).toMatchObject({ code: -32001, data: { code: 'NO_AUTH' } })
    }
  })

  it('refuses a body that is not JSON-RPC with a parse error', async () => {
    const res = await raw('{this is not json')
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error.code).toBe(-32700)
  })

  it('answers a method it does not serve with method-not-found', async () => {
    const body = await (await raw({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} })).json()
    expect(body.error.code).toBe(-32601)
  })

  it('answers GET with 405: there is no server-initiated stream', async () => {
    const res = await GET()
    expect(res.status).toBe(405)
    expect((await res.json()).error.code).toBe(-32000)
  })

  it('lets a browser-based host send the 2026 request headers', async () => {
    const res = OPTIONS()
    const allowed = res.headers.get('access-control-allow-headers') ?? ''
    for (const h of ['mcp-protocol-version', 'mcp-method', 'mcp-name', 'authorization', 'x-api-key']) {
      expect(allowed).toContain(h)
    }
  })
})
