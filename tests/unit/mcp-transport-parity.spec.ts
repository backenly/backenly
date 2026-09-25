/**
 * The stdio package and the remote endpoint serve an agent the same thing.
 *
 * They are two transports onto one backend: the remote endpoint (/api/mcp)
 * runs in this repository, the stdio package (packages/mcp-server) runs on the
 * user's machine and reaches Backenly over HTTP. They used to be written
 * separately and had drifted apart. The remote endpoint served no resources.
 * Its instructions differed. A failure reached an agent as JSON over one and
 * as a sentence over the other, and over stdio the sentence dropped `hint`,
 * `applied` and the trail of what ran.
 *
 * This runs both against the SAME handlers, in both protocol eras, for a
 * read-write and a read-only key, and requires identical answers:
 *
 *   remote: the official client -> app/api/mcp/route.ts, in process
 *   stdio:  the official client -> the BUILT package (dist/cli.js, what npm
 *           ships), spawned -> an HTTP server here that serves the real health
 *           and manifest routes and the same tool/chat handlers
 *
 * The tool and chat handlers are fixtures answering what those handlers
 * answer; authentication is stubbed per credential. Only what the transports
 * legitimately differ in is excluded: the server's name and version, and
 * `tools.listChanged` (only the stdio catalog can change mid-connection).
 *
 * Needs the package built: npm ci --prefix packages/mcp-server && npm run build --prefix packages/mcp-server
 */

import '../helpers/real-web-standard'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

const mockToolAnswers: Record<string, [number, Record<string, unknown>]> = {
  read_backend_state: [200, { ok: true, summary: '2 tables', data: { tables: ['posts', 'users'] }, needsUser: false, timing: { ms: 3, heavy: false } }],
  list_tables: [200, { ok: true, summary: '1 table', data: [{ name: 'posts' }], needsUser: false }],
  db_query: [200, { ok: true, summary: 'Read 1 row(s) from posts', data: { rows: [{ id: 1 }], count: 1 }, needsUser: false }],
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
  // A failure that says nothing about why: the result must say that, not guess.
  get_errors: [500, { ok: false, code: 'TOOL_ERROR' }],
}

const mockChatAnswers: Record<string, Record<string, unknown>> = {
  'drop posts': {
    ok: true,
    summary: 'Dropping posts needs a human: parked for approval.',
    status: 'awaiting_approval',
    approval: { id: 'apr_1', status: 'pending', poll: 'check_approval', note: 'A project owner approves this in the dashboard.' },
    needsUser: true,
    timing: { ms: 12 },
  },
  'build a shop': {
    ok: false,
    summary: 'The brain was rate limited after creating one table.',
    error: 'Rate limited by the model provider.',
    code: 'RATE_LIMITED',
    retryable: true,
    retryAfterMs: 30000,
    toolsRun: ['create_table'],
    iterations: 2,
    events: [{ type: 'tool_ok', tool: 'create_table' }, { type: 'tool_fail', tool: 'create_table', error: 'rate limited' }],
    timing: { ms: 900 },
  },
}

jest.mock('@/app/api/mcp/tool/route', () => ({
  POST: jest.fn(async (req: NextRequest) => {
    const body = await req.json()
    const answer = mockToolAnswers[body.tool]
    if (!answer) return NextResponse.json({ ok: false, error: `Unknown MCP tool "${body.tool}".`, code: 'UNKNOWN_TOOL' }, { status: 404 })
    return NextResponse.json(answer[1], { status: answer[0] })
  }),
}))
jest.mock('@/app/api/mcp/chat/route', () => ({
  POST: jest.fn(async (req: NextRequest) => {
    const body = await req.json()
    const answer = mockChatAnswers[body.message]
    if (!answer) return NextResponse.json({ ok: false, error: '`message` is required.', code: 'INVALID_INPUT' }, { status: 400 })
    return NextResponse.json(answer)
  }),
}))
jest.mock('@/lib/db/prisma', () => ({
  prisma: { project: { findUnique: jest.fn(async () => ({ id: 'p1', name: 'Demo' })) } },
}))
jest.mock('@/lib/mcp/auth', () => {
  const actual = jest.requireActual('@/lib/mcp/auth')
  return {
    ...actual,
    authenticateMcp: jest.fn(async (req: NextRequest) => {
      const key = req.headers.get('x-api-key')
      if (key === 'read-write-test-credential') return { success: true, projectId: 'p1', userId: 'u1', keyId: 'k1', scope: 'mcp', readOnly: false }
      if (key === 'read-only-test-credential') return { success: true, projectId: 'p1', userId: 'u1', keyId: 'k2', scope: 'mcp', readOnly: true }
      return { success: false, status: 401, code: 'INVALID_KEY', error: 'The API key is invalid or revoked.' }
    }),
  }
})
// The manifest route's guard, reduced to its authentication: quota, rate
// limits and pause state are not what this compares.
jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async (req: NextRequest) => {
    const { authenticateMcp, mcpAuthFailureResponse } = jest.requireMock('@/lib/mcp/auth')
    const auth = await authenticateMcp(req)
    if (!auth.success) return { response: mcpAuthFailureResponse(auth), auth: null }
    return { response: null, auth }
  }),
  recordMcpCall: jest.fn(),
}))

import type { Client } from '@modelcontextprotocol/client'
import * as remoteRoute from '@/app/api/mcp/route'
import { GET as healthGet } from '@/app/api/mcp/health/route'
import { GET as manifestGet } from '@/app/api/mcp/manifest/route'
import { POST as toolPost } from '@/app/api/mcp/tool/route'
import { POST as chatPost } from '@/app/api/mcp/chat/route'
import {
  comparable,
  remoteClient,
  requireBuiltPackage,
  serveBackenly,
  stdioClient,
  type Era,
} from '../helpers/mcp-transports'

const KEYS = { 'read-write': 'read-write-test-credential', 'read-only': 'read-only-test-credential' } as const

/** Everything an agent is served on connect, minus what the transports legitimately differ in. */
async function surface(client: Client) {
  const caps = client.getServerCapabilities() as any
  return {
    era: client.getProtocolEra(),
    protocolVersion: client.getNegotiatedProtocolVersion(),
    instructions: client.getInstructions(),
    capabilities: { ...caps, tools: { ...caps.tools, listChanged: undefined } },
    tools: (await client.listTools()).tools,
    resources: (await client.listResources()).resources,
  }
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['read_backend_state', {}],
  ['db_query', { table: 'posts' }],
  ['apply_migration', { sql: 'alter table posts add column title text' }],
  ['get_errors', {}],
  ['no_such_tool', {}],
  ['backend_chat', { message: 'drop posts' }],
  ['backend_chat', { message: 'build a shop' }],
  ['backend_chat', {}],
]

let backend: { server: http.Server; base: string }
let home: string

beforeAll(async () => {
  requireBuiltPackage()
  backend = await serveBackenly({
    'GET /api/mcp/health': healthGet as any,
    'GET /api/mcp/manifest': manifestGet as any,
    'POST /api/mcp/tool': toolPost as any,
    'POST /api/mcp/chat': chatPost as any,
  })
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-mcp-parity-'))
})
afterAll(() => {
  backend?.server.close()
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

describe.each<Era>(['legacy', 'modern'])('%s era', (era) => {
  describe.each(Object.keys(KEYS) as Array<keyof typeof KEYS>)('%s key', (which) => {
    let remote: Client
    let stdio: Client

    beforeAll(async () => {
      remote = await remoteClient(era, KEYS[which], remoteRoute)
      stdio = await stdioClient(era, KEYS[which], backend.base, home)
    }, 30_000)
    afterAll(async () => {
      await remote?.close()
      await stdio?.close()
    })

    it('serves the same instructions, capabilities, tools and resources', async () => {
      const [r, s] = await Promise.all([surface(remote), surface(stdio)])
      expect(s).toEqual(r)
      expect(r.era).toBe(era)
      expect(r.tools.length).toBeGreaterThan(3)
      expect(r.resources.length).toBeGreaterThan(0)
    })

    it.each(CALLS)('answers tools/call %s %j identically', async (name, args) => {
      const [r, s] = await Promise.all([
        remote.callTool({ name, arguments: args }),
        stdio.callTool({ name, arguments: args }),
      ])
      expect(comparable(s)).toEqual(comparable(r))
    })

    it('reads a resource identically', async () => {
      const [r, s] = await Promise.all([
        remote.readResource({ uri: 'backenly://tables' }),
        stdio.readResource({ uri: 'backenly://tables' }),
      ])
      expect(comparable(s)).toEqual(comparable(r))
    })

    it('refuses an unknown resource with the same error', async () => {
      const [r, s] = await Promise.all([
        remote.readResource({ uri: 'backenly://nope' }).catch((e) => ({ code: e.code, message: e.message })),
        stdio.readResource({ uri: 'backenly://nope' }).catch((e) => ({ code: e.code, message: e.message })),
      ])
      expect(r).toMatchObject({ code: -32602 })
      expect(s).toEqual(r)
    })
  })
})

describe('what the results carry', () => {
  let remote: Client
  beforeAll(async () => { remote = await remoteClient('modern', KEYS['read-write'], remoteRoute) })
  afterAll(async () => { await remote?.close() })

  it('keeps the trail of a failed brain run, and says it may be partly applied', async () => {
    const result: any = await remote.callTool({ name: 'backend_chat', arguments: { message: 'build a shop' } })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'RATE_LIMITED', retryable: true, toolsRun: ['create_table'] })
    expect(result.structuredContent.whatRanBeforeItFailed).toHaveLength(2)
    expect(result.structuredContent).not.toHaveProperty('events')
    expect(result.structuredContent).not.toHaveProperty('timing')
    expect(result.content[1].text).toMatch(/may already be applied/)
    expect(result.content[1].text).toMatch(/worth retrying after 30s/)
  })

  it('says a failure without a reason is a bug, rather than inventing one', async () => {
    const result: any = await remote.callTool({ name: 'get_errors', arguments: {} })
    expect(result.structuredContent).toEqual({ ok: false, code: 'TOOL_ERROR' })
    expect(result.content[1].text).toMatch(/without a reason/)
  })
})
