/**
 * The row tools refuse a bad call the same way on every surface.
 *
 * db_query, db_insert, db_update and db_delete are served by their own routes
 * (/api/mcp/db/*) and by /api/mcp/tool, which the remote MCP endpoint and the
 * stdio package call. Only the dedicated routes used to validate: /api/mcp/tool
 * passed its args to the helper as they came, so `{ table, select, groupBy }`
 * was refused with "use run_query" on one surface and ran, keys ignored, on the
 * other. Both now parse with lib/mcp/db-tool-requests.ts.
 *
 * Every call here is one that must be refused before a database is touched,
 * and nothing is mocked below the route guard: were a refusal missing, the
 * helper would run and answer with a database error, not the refusal expected.
 * The guard is reduced to authentication by key (quota, rate limits and pause
 * state are not what this checks); the read-only refusal is the real one.
 *
 * Then the same calls go through both MCP transports, the remote endpoint in
 * process and the BUILT stdio package over stdio, onto the same real routes,
 * and must reach the agent as the dedicated route's own body.
 *
 * Needs the package built: npm ci --prefix packages/mcp-server && npm run build --prefix packages/mcp-server
 */

import '../helpers/real-web-standard'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { NextRequest } from 'next/server'

const mockAuthFor = (key: string | null) =>
  key === 'read-write-test-credential'
    ? { success: true, projectId: 'p1', userId: 'u1', keyId: 'k1', scope: 'mcp', readOnly: false }
    : key === 'read-only-test-credential'
      ? { success: true, projectId: 'p1', userId: 'u1', keyId: 'k2', scope: 'mcp', readOnly: true }
      : null

jest.mock('@/lib/mcp/auth', () => {
  const actual = jest.requireActual('@/lib/mcp/auth')
  return {
    ...actual,
    authenticateMcp: jest.fn(async (req: NextRequest) =>
      mockAuthFor(req.headers.get('x-api-key'))
        ?? { success: false, status: 401, code: 'INVALID_KEY', error: 'The API key is invalid or revoked.' }),
  }
})
jest.mock('@/lib/mcp/guard', () => {
  const actual = jest.requireActual('@/lib/mcp/guard')
  return {
    ...actual,
    mcpGuard: jest.fn(async (req: NextRequest) => {
      const auth = mockAuthFor(req.headers.get('x-api-key'))
      if (!auth) {
        const { mcpAuthFailureResponse } = jest.requireActual('@/lib/mcp/auth')
        return { response: mcpAuthFailureResponse({ success: false, status: 401, code: 'INVALID_KEY', error: 'bad key' }), auth: null }
      }
      return { response: null, auth }
    }),
    recordMcpCall: jest.fn(),
  }
})

import type { Client } from '@modelcontextprotocol/client'
import * as remoteRoute from '@/app/api/mcp/route'
import { GET as healthGet } from '@/app/api/mcp/health/route'
import { GET as manifestGet } from '@/app/api/mcp/manifest/route'
import { POST as toolPost } from '@/app/api/mcp/tool/route'
import { POST as queryPost } from '@/app/api/mcp/db/query/route'
import { POST as insertPost } from '@/app/api/mcp/db/insert/route'
import { POST as updatePost } from '@/app/api/mcp/db/update/route'
import { POST as deletePost } from '@/app/api/mcp/db/delete/route'
import { buildDispatchable } from '@/lib/mcp/catalog'
import { DB_TOOL_REQUESTS, type DbToolName } from '@/lib/mcp/db-tool-requests'
import {
  comparable,
  remoteClient,
  requireBuiltPackage,
  serveBackenly,
  stdioClient,
  type Era,
} from '../helpers/mcp-transports'

const RW = 'read-write-test-credential'
const RO = 'read-only-test-credential'

const DEDICATED: Record<DbToolName, (req: NextRequest) => Promise<Response>> = {
  db_query: queryPost as any,
  db_insert: insertPost as any,
  db_update: updatePost as any,
  db_delete: deletePost as any,
}

function post(url: string, key: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  })
}

async function answer(res: Response) {
  return { status: res.status, body: await res.json() }
}

const viaToolRoute = async (key: string, tool: DbToolName, args: Record<string, unknown>) =>
  answer(await toolPost(post('https://backenly.test/api/mcp/tool', key, { tool, args })))

const viaDedicatedRoute = async (key: string, tool: DbToolName, args: Record<string, unknown>) =>
  answer(await DEDICATED[tool](post(`https://backenly.test/api/mcp/db/${tool.slice(3)}`, key, args)))

interface Refusal {
  tool: DbToolName
  args: Record<string, unknown>
  code: string
  says?: RegExp
}

/** Refused for their arguments, from a key that may run the tool. */
const BAD_ARGS: Refusal[] = [
  { tool: 'db_query', args: { table: 'posts', select: 'count(*)', groupBy: 'status' }, code: 'UNSUPPORTED_PARAMS', says: /run_query/ },
  { tool: 'db_query', args: { table: 'posts', colour: 'red' }, code: 'UNKNOWN_PARAMS', says: /colour/ },
  { tool: 'db_query', args: { table: 'posts', limit: 500 }, code: 'BAD_BODY' },
  { tool: 'db_query', args: { table: 'posts', limit: '10' }, code: 'BAD_BODY' },
  { tool: 'db_query', args: { table: '   ' }, code: 'BAD_BODY' },
  { tool: 'db_query', args: {}, code: 'BAD_BODY' },
  { tool: 'db_insert', args: { table: 'posts', row: {} }, code: 'BAD_BODY', says: /at least one column/ },
  { tool: 'db_insert', args: { table: 'posts' }, code: 'BAD_BODY' },
  { tool: 'db_update', args: { table: 'posts', filter: {}, patch: { title: 'x' } }, code: 'BAD_BODY', says: /refusing table-wide UPDATE/ },
  { tool: 'db_update', args: { table: 'posts', filter: { id: 1 } }, code: 'BAD_BODY' },
  { tool: 'db_update', args: { table: 'posts', filter: { id: 1 }, patch: {} }, code: 'BAD_BODY', says: /at least one column/ },
  { tool: 'db_delete', args: { table: 'posts', filter: {} }, code: 'BAD_BODY', says: /refusing table-wide DELETE/ },
  { tool: 'db_delete', args: { table: 'posts' }, code: 'BAD_BODY' },
  { tool: 'db_delete', args: { table: 'posts', filter: { id: 1 }, where: '1=1' }, code: 'UNSUPPORTED_PARAMS' },
]

/** Writes from a read-only key: refused before their arguments are even read. */
const READ_ONLY_WRITES: Refusal[] = [
  { tool: 'db_insert', args: { table: 'posts', row: { title: 'x' } }, code: 'READ_ONLY_KEY' },
  { tool: 'db_update', args: { table: 'posts', filter: { id: 1 }, patch: { title: 'x' } }, code: 'READ_ONLY_KEY' },
  { tool: 'db_delete', args: { table: 'posts', filter: { id: 1 } }, code: 'READ_ONLY_KEY' },
  { tool: 'db_delete', args: { table: 'posts', filter: {} }, code: 'READ_ONLY_KEY' },
]

describe('/api/mcp/tool and /api/mcp/db/* refuse the same calls with the same answer', () => {
  it.each(BAD_ARGS)('$tool $args -> $code', async ({ tool, args, code, says }) => {
    const [tool_, dedicated] = await Promise.all([viaToolRoute(RW, tool, args), viaDedicatedRoute(RW, tool, args)])
    expect(tool_).toEqual(dedicated)
    expect(dedicated.status).toBe(400)
    expect(dedicated.body.code).toBe(code)
    if (says) expect(dedicated.body.error + ' ' + (dedicated.body.hint ?? '')).toMatch(says)
  })

  it.each(READ_ONLY_WRITES)('read-only key: $tool $args -> $code', async ({ tool, args, code }) => {
    const [tool_, dedicated] = await Promise.all([viaToolRoute(RO, tool, args), viaDedicatedRoute(RO, tool, args)])
    expect(tool_).toEqual(dedicated)
    expect(dedicated.status).toBe(403)
    expect(dedicated.body.code).toBe(code)
  })

  it('checks a read-only key’s reads for their arguments like anyone else’s', async () => {
    const args = { table: 'posts', select: 'count(*)' }
    const [tool_, dedicated] = await Promise.all([viaToolRoute(RO, 'db_query', args), viaDedicatedRoute(RO, 'db_query', args)])
    expect(tool_).toEqual(dedicated)
    expect(dedicated.body.code).toBe('UNSUPPORTED_PARAMS')
  })
})

// buildDispatchable, not buildCatalog: db_query is callable but not advertised
// (run_query is the one read door), and its schema still has to be right for
// a client pinned to an older manifest that lists it.
describe('the schema each row tool is described with is what it accepts', () => {
  const catalog = buildDispatchable()

  it.each(Object.keys(DB_TOOL_REQUESTS) as DbToolName[])('%s', (tool) => {
    const schema = DB_TOOL_REQUESTS[tool]
    const advertised = catalog.find((t) => t.name === tool)!.inputSchema as {
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
    const keys = Object.keys(schema.shape)
    const required = keys.filter((k) => !(schema.shape as Record<string, { isOptional(): boolean }>)[k].isOptional())

    expect(Object.keys(advertised.properties).sort()).toEqual([...keys].sort())
    expect([...(advertised.required ?? [])].sort()).toEqual(required.sort())
    expect(advertised.additionalProperties).toBe(false)
  })
})

describe.each<Era>(['legacy', 'modern'])('through both MCP transports, %s era', (era) => {
  let backend: { server: http.Server; base: string }
  let home: string
  const clients: Record<string, { remote: Client; stdio: Client }> = {}

  beforeAll(async () => {
    requireBuiltPackage()
    backend = await serveBackenly({
      'GET /api/mcp/health': healthGet as any,
      'GET /api/mcp/manifest': manifestGet as any,
      'POST /api/mcp/tool': toolPost as any,
    })
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-mcp-db-'))
    for (const key of [RW, RO]) {
      clients[key] = {
        remote: await remoteClient(era, key, remoteRoute),
        stdio: await stdioClient(era, key, backend.base, home),
      }
    }
  }, 60_000)
  afterAll(async () => {
    for (const { remote, stdio } of Object.values(clients)) {
      await remote?.close()
      await stdio?.close()
    }
    backend?.server.close()
    if (home) fs.rmSync(home, { recursive: true, force: true })
  })

  const cases = [
    ...BAD_ARGS.map((c) => ({ ...c, key: RW })),
    ...READ_ONLY_WRITES.map((c) => ({ ...c, key: RO })),
  ]

  it.each(cases)('$tool $args ($code) reaches the agent as the dedicated route’s own body', async ({ tool, args, key }) => {
    const { remote, stdio } = clients[key]
    const [r, s, dedicated] = await Promise.all([
      remote.callTool({ name: tool, arguments: args }),
      stdio.callTool({ name: tool, arguments: args }),
      viaDedicatedRoute(key, tool, args),
    ])
    expect(comparable(s)).toEqual(comparable(r))
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual(dedicated.body)
  })
})
