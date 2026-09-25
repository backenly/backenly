/**
 * The remote MCP endpoint must hand the delegated handler the credential the
 * caller actually sent.
 *
 * `tools/call` on /api/mcp runs /api/mcp/tool or /api/mcp/chat in-process, and
 * those handlers authenticate again. The endpoint used to copy `x-api-key`
 * alone, so an OAuth host (which sends only `Authorization: Bearer`) could
 * initialize and list tools, then failed NO_AUTH on every call.
 *
 * The delegated handlers are replaced with recorders that capture the request
 * they were given. No database is mocked: nothing here reaches one.
 */

import '../helpers/next-request-polyfill'
import { NextRequest, NextResponse } from 'next/server'

const mockSeen: { path: string; authorization: string | null; apiKey: string | null }[] = []
let mockDelegatedStatus = 200

function mockRecorder(path: string) {
  return jest.fn(async (req: NextRequest) => {
    mockSeen.push({
      path,
      authorization: req.headers.get('authorization'),
      apiKey: req.headers.get('x-api-key'),
    })
    if (mockDelegatedStatus === 401) {
      return NextResponse.json(
        { ok: false, error: 'The access token is invalid or expired.', code: 'INVALID_TOKEN' },
        { status: 401, headers: { 'www-authenticate': 'Bearer realm="backenly", error="invalid_token"' } },
      )
    }
    return NextResponse.json({ ok: true, summary: 'done', data: null })
  })
}

jest.mock('@/app/api/mcp/tool/route', () => ({ POST: mockRecorder('/api/mcp/tool') }))
jest.mock('@/app/api/mcp/chat/route', () => ({ POST: mockRecorder('/api/mcp/chat') }))

import { forwardedCredentialHeaders } from '@/lib/mcp/forward-credential'
import { POST } from '@/app/api/mcp/route'

function call(headers: Record<string, string>, name = 'read_backend_state', args: object = {}) {
  return POST(
    new NextRequest('https://backenly.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  )
}

beforeEach(() => {
  mockSeen.length = 0
  mockDelegatedStatus = 200
})

describe('forwardedCredentialHeaders', () => {
  it('copies a Bearer token and an API key exactly as sent', () => {
    const h = new Headers({ authorization: 'Bearer tok', 'x-api-key': 'mcp_live_abc', cookie: 'auth-token=x' })
    expect(forwardedCredentialHeaders(h)).toEqual({ authorization: 'Bearer tok', 'x-api-key': 'mcp_live_abc' })
  })

  it('forwards no credential it was not given, and never an empty key', () => {
    expect(forwardedCredentialHeaders(new Headers({ authorization: 'Bearer tok' }))).toEqual({
      authorization: 'Bearer tok',
    })
    expect(forwardedCredentialHeaders(new Headers())).toEqual({})
  })

  it('does not treat a cookie as a credential for these routes', () => {
    expect(forwardedCredentialHeaders(new Headers({ cookie: 'auth-token=x' }))).toEqual({})
  })
})

describe('tools/call on the remote endpoint', () => {
  it('reaches the typed handler with the OAuth Bearer token the host sent', async () => {
    const res = await call({ authorization: 'Bearer oauth-access-token' })

    expect(res.status).toBe(200)
    expect(mockSeen).toEqual([{ path: '/api/mcp/tool', authorization: 'Bearer oauth-access-token', apiKey: null }])
  })

  it('reaches the brain handler with the Bearer token too', async () => {
    await call({ authorization: 'Bearer oauth-access-token' }, 'backend_chat', { message: 'hi' })

    expect(mockSeen).toEqual([{ path: '/api/mcp/chat', authorization: 'Bearer oauth-access-token', apiKey: null }])
  })

  it('still forwards an API key for key-based hosts', async () => {
    await call({ 'x-api-key': 'mcp_live_test_key' })

    expect(mockSeen).toEqual([{ path: '/api/mcp/tool', authorization: null, apiKey: 'mcp_live_test_key' }])
  })

  it('turns a delegated auth failure into a 401 challenge, so the host refreshes its token', async () => {
    mockDelegatedStatus = 401
    const res = await call({ authorization: 'Bearer expired' })

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('invalid_token')
    const body = await res.json()
    expect(body.error.code).toBe(-32001)
    expect(body.error.data).toEqual({ code: 'INVALID_TOKEN' })
  })

  it('reports a successful delegated call as a normal tool result', async () => {
    const res = await call({ 'x-api-key': 'mcp_live_test_key' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.result.isError).toBe(false)
  })
})
