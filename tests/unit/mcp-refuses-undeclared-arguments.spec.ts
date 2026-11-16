/**
 * AN ARGUMENT A TOOL DOES NOT TAKE IS REFUSED, NOT DROPPED
 * ========================================================
 *
 * Production QA re-test (2026-11-16): get_table_schema { tableName, branchId }
 * described production's table. The tool took no branchId, /api/mcp/tool
 * handed the call over as sent, and the argument was dropped without a word,
 * so the agent read production while it believed it was reading its branch.
 * Every tool in tools/list says additionalProperties: false; only the db_*
 * tools held to it.
 *
 * Now /api/mcp/tool refuses such a call with UNKNOWN_PARAMS before anything
 * runs or waits for approval, naming the arguments it refused and the ones the
 * call takes (lib/mcp/tool-arguments.ts). A section tool is held to the action
 * it runs, not to the union tools/list shows. The guard and the brain's
 * dispatcher are recorders; nothing here reaches a database.
 */

import '../helpers/next-request-polyfill'
import { NextRequest, NextResponse } from 'next/server'

let mockReadOnly = false
const mockDispatched: { name: string; args: Record<string, unknown> }[] = []
const mockParked: unknown[] = []

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

// A call that waits for a person is recorded here instead of being stored.
jest.mock('@/lib/mcp/approval-describe', () => ({ describeApproval: jest.fn(async () => null) }))
jest.mock('@/lib/mcp/approvals', () => ({
  createApprovalRequest: jest.fn(async (row: unknown) => {
    mockParked.push(row)
    return { id: 'apr_1', status: 'pending', expiresAt: new Date('2026-11-18T00:00:00Z') }
  }),
}))

import { POST } from '@/app/api/mcp/tool/route'

async function call(tool: string, args: Record<string, unknown>) {
  const res = await POST(
    new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
      body: JSON.stringify({ tool, args }),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeEach(() => {
  mockReadOnly = false
  mockDispatched.length = 0
  mockParked.length = 0
})

describe('a call carrying an argument its tool does not take', () => {
  it('is refused with UNKNOWN_PARAMS, naming it and what the tool takes, and nothing runs', async () => {
    const r = await call('get_table_schema', { tableName: 'orders', bogus: 1 })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ ok: false, code: 'UNKNOWN_PARAMS', unsupported: ['bogus'] })
    // What the tool takes, read from its schema, so a new argument does not break this.
    expect(r.body.supported).toContain('tableName')
    expect(r.body.supported).not.toContain('bogus')
    expect(r.body.error).toBe('get_table_schema does not take bogus. Nothing ran.')
    expect(mockDispatched).toEqual([])
  })

  it('refuses a branchId on a read that has no branch form, instead of answering for production', async () => {
    const r = await call('run_query', { sql: 'SELECT count(*) FROM orders', branchId: 'b1' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('UNKNOWN_PARAMS')
    expect(r.body.unsupported).toEqual(['branchId'])
    expect(r.body.hint).toMatch(/without branchId it acts on production/)
    expect(mockDispatched).toEqual([])
  })

  it('refuses a branchId on a write that has no branch form, so production is never changed', async () => {
    const r = await call('set_rls', { tableName: 'orders', select: { using: 'true' }, branchId: 'b1' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('UNKNOWN_PARAMS')
    expect(mockDispatched).toEqual([])
  })

  it('holds a section tool to the action it runs, not to every action’s arguments', async () => {
    // clientId is add_oauth_provider's; enable_auth takes nothing.
    const r = await call('auth', { action: 'enable', clientId: 'abc' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'UNKNOWN_PARAMS', unsupported: ['clientId'], supported: ['action'] })
    expect(r.body.error).toBe('auth action "enable" does not take clientId. Nothing ran.')
    expect(mockDispatched).toEqual([])
  })

  it('holds branch to the action it runs', async () => {
    const r = await call('branch', { action: 'list', branchId: 'b1' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'UNKNOWN_PARAMS', unsupported: ['branchId'] })
    expect(mockDispatched).toEqual([])
  })

  it('refuses it before a person is asked to approve it', async () => {
    const r = await call('deploy', { action: 'deploy', note: 'ship it' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('UNKNOWN_PARAMS')
    expect(mockParked).toEqual([])
    expect(mockDispatched).toEqual([])
  })
})

describe('a call carrying only what its tool takes', () => {
  it('runs a section read with the arguments of the tool it reads', async () => {
    const r = await call('read_backend_state', { section: 'files', bucketName: 'avatars', limit: 5 })
    expect(r.status).toBe(200)
    expect(mockDispatched).toEqual([{ name: 'list_files', args: { bucketName: 'avatars', limit: 5 } }])
  })

  it('runs a branch action with its own arguments', async () => {
    const r = await call('branch', { action: 'diff', branchId: 'b1' })
    expect(r.status).toBe(200)
    expect(mockDispatched).toEqual([{ name: 'diff_branch', args: { branchId: 'b1' } }])
  })

  it('takes the description an agent gives the code it deploys', async () => {
    // Sent in 5 of the 16 Nov QA run's deploy_code calls, and stored by the handler.
    const r = await call('functions', {
      action: 'deploy_code', name: 'hello', trigger: 'http', code: 'export async function POST() {}', description: 'Says hello',
    })
    expect(r.status).toBe(200)
    expect(mockDispatched[0]).toMatchObject({ name: 'deploy_function_code', args: { description: 'Says hello' } })
  })

  it('treats an argument sent as null as not sent', async () => {
    // Hosts that fill every property of a schema send null for the unused ones.
    const r = await call('storage', { action: 'list_buckets', bucketName: null, isPublic: null })
    expect(r.status).toBe(200)
    expect(mockDispatched.map((d) => d.name)).toEqual(['list_buckets'])
  })
})

describe('a projectId argument', () => {
  // The connection decides the project; agents name it as well.
  it('is accepted when it names the connection’s own project, and dropped before the tool runs', async () => {
    const r = await call('get_table_schema', { tableName: 'orders', projectId: 'p1' })
    expect(r.status).toBe(200)
    expect(mockDispatched).toEqual([{ name: 'get_table_schema', args: { tableName: 'orders' } }])
  })

  it('is accepted on a section action as well', async () => {
    const r = await call('functions', { action: 'list', projectId: 'p1' })
    expect(r.status).toBe(200)
    expect(mockDispatched).toEqual([{ name: 'list_ai_functions', args: {} }])
  })

  it('naming another project is refused with PROJECT_MISMATCH, and nothing runs', async () => {
    const r = await call('get_table_schema', { tableName: 'orders', projectId: 'p2' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ ok: false, code: 'PROJECT_MISMATCH' })
    expect(r.body.hint).toMatch(/connect with a key for the other project/)
    expect(mockDispatched).toEqual([])
  })
})

describe('what other checks answer first', () => {
  it('a read-only key is refused the write before it learns the write’s arguments', async () => {
    mockReadOnly = true
    const r = await call('auth', { action: 'set_smtp', bogus: 1 })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('READ_ONLY_KEY')
  })

  it('an unknown action is still UNKNOWN_ACTION, with the actions there are', async () => {
    const r = await call('auth', { action: 'nope', bogus: 1 })
    expect(r.body.code).toBe('UNKNOWN_ACTION')
  })

  it('the row tools keep their own refusal', async () => {
    const r = await call('db_query', { table: 'posts', colour: 'red' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'UNKNOWN_PARAMS', unsupported: ['colour'] })
    expect(r.body.error).toBe('db_query received unknown parameter(s): colour.')
  })
})
