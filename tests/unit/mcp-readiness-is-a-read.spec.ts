/**
 * Readiness over MCP is a read.
 *
 * The readiness executor applies fixes (JWT generation, default RLS policies)
 * unless it is passed `autoFix: false`, and it defaults to fixing. MCP serves it
 * as `read_backend_state {section:"readiness"}` — side-effect free by contract,
 * and offered to read-only keys — so a plain read could install RLS policies,
 * including from a key whose owner chose read-only.
 *
 * The guard and the brain's dispatcher are replaced with recorders; nothing
 * here reaches a database.
 */

import '../helpers/next-request-polyfill'
import { NextRequest, NextResponse } from 'next/server'

let mockReadOnly = false
const mockDispatched: { name: string; args: Record<string, unknown> }[] = []

jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { success: true, projectId: 'p1', userId: 'u1', keyId: 'k1', readOnly: mockReadOnly },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() =>
    NextResponse.json({ ok: false, code: 'READ_ONLY_KEY' }, { status: 403 }),
  ),
}))

jest.mock('@/lib/ai/brain/tools', () => {
  const actual = jest.requireActual('@/lib/ai/brain/tools')
  return {
    ...actual,
    dispatchTool: jest.fn(async (name: string, args: Record<string, unknown>) => {
      mockDispatched.push({ name, args: { ...args } })
      return { ok: true, summary: 'ok' }
    }),
  }
})

import { POST } from '@/app/api/mcp/tool/route'

function call(tool: string, args: Record<string, unknown>) {
  return POST(
    new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_0123456789abcdef' },
      body: JSON.stringify({ tool, args }),
    }),
  )
}

beforeEach(() => {
  mockReadOnly = false
  mockDispatched.length = 0
})

describe('readiness over MCP', () => {
  it('fixes nothing when read through read_backend_state', async () => {
    const res = await call('read_backend_state', { section: 'readiness' })
    expect(res.status).toBe(200)
    expect(mockDispatched).toEqual([{ name: 'get_readiness', args: { autoFix: false } }])
  })

  it('fixes nothing from a read-only key, even when asked to', async () => {
    mockReadOnly = true
    await call('read_backend_state', { section: 'readiness' })
    await call('get_readiness', { autoFix: true })
    expect(mockDispatched.map((d) => d.args.autoFix)).toEqual([false, false])
  })

  it('applies fixes only when a read-write key asks for them explicitly', async () => {
    await call('get_readiness', { autoFix: true })
    await call('get_readiness', {})
    expect(mockDispatched.map((d) => d.args.autoFix)).toEqual([true, false])
  })
})
