/**
 * A credential a tool hands the agent is not also kept in the logs.
 *
 * recordMcpCall stores the first 200 characters of a tool summary in
 * api_key_usage and the first 240 in audit_logs. create_api_key's summary
 * carries the new key about sixty characters in, so every key minted over MCP,
 * service role included, was stored in plaintext twice, although the key table
 * itself keeps no plaintext at all. The agent must still receive the key in its
 * response; only the stored copies change.
 */

import '../helpers/next-request-polyfill'
import { NextRequest } from 'next/server'

const mockUsageRows: any[] = []
const mockAuditRows: any[] = []

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    apiKeyUsage: { create: jest.fn(async (a: any) => { mockUsageRows.push(a.data); return a.data }) },
    auditLog: { create: jest.fn(async (a: any) => { mockAuditRows.push(a.data); return a.data }) },
  },
}))

const KEY = `svc_live_${'a1'.repeat(24)}`
const mockDispatch = jest.fn()

jest.mock('@/lib/mcp/guard', () => {
  const actual = jest.requireActual('@/lib/mcp/guard')
  return {
    ...actual,
    mcpGuard: jest.fn(async () => ({
      auth: { keyId: 'k1', projectId: 'p1', userId: 'u1', scope: 'mcp', readOnly: false },
    })),
  }
})

jest.mock('@/lib/ai/brain/tools', () => {
  const actual = jest.requireActual('@/lib/ai/brain/tools')
  return { ...actual, dispatchTool: (...a: unknown[]) => mockDispatch(...a) }
})

import { withholdSecrets, namedSecrets } from '@/lib/mcp/withhold-secrets'
import { recordMcpCall } from '@/lib/mcp/guard'
import { POST } from '@/app/api/mcp/tool/route'

const CTX = { keyId: 'k1', projectId: 'p1', userId: 'u1', endpoint: '/api/mcp/tool', startedAt: Date.now() }
const createSummary = `✅ Created API key: svc_live_a1a1...\n\n**Copy this key (shown once):**\n\`\`\`\n${KEY}\n\`\`\``

beforeEach(() => {
  mockUsageRows.length = 0
  mockAuditRows.length = 0
  mockDispatch.mockReset()
})

describe('what is withheld', () => {
  it.each([
    ['a publishable project key', `proj_live_${'b2'.repeat(24)}`],
    ['a service-role key', KEY],
    ['a rotated key with the old prefix', `sk_live_${'c3'.repeat(24)}`],
    ['a webhook signing secret', `whsec_${'d4'.repeat(24)}`],
    ['a project admin key', `bk_admin_${'e5'.repeat(16)}`],
  ])('%s, by its shape', (_label, secret) => {
    expect(withholdSecrets(`here it is: ${secret} keep it safe`)).toBe('here it is: [withheld] keep it safe')
  })

  it('a value the tool names in its data, whatever it looks like', () => {
    const secret = 'f6'.repeat(32) // a project webhook secret: bare hex, no prefix
    expect(namedSecrets({ webhook: { id: 'w1', secret } })).toEqual([secret])
    expect(withholdSecrets(`Secret: ${secret}`, { webhook: { id: 'w1', secret } })).toBe('Secret: [withheld]')
  })

  it('the password in a connection string, leaving the rest readable', () => {
    expect(withholdSecrets('postgresql://bkn_ro_abc:s3cretpassw0rd@db.host:5432/backenly'))
      .toBe('postgresql://bkn_ro_abc:[withheld]@db.host:5432/backenly')
  })

  it('nothing from an ordinary summary, including a short key prefix shown for recognition', () => {
    const plain = 'Created table orders (4 columns). Key svc_live_a1a1... is active.'
    expect(withholdSecrets(plain)).toBe(plain)
  })
})

describe('what recordMcpCall stores', () => {
  it('keeps the new key out of the usage row and the audit row', () => {
    recordMcpCall(CTX, { statusCode: 200, tool: 'connect.create_api_key', mutation: true, summary: createSummary, data: { apiKey: KEY } })
    expect(JSON.stringify(mockUsageRows)).not.toContain(KEY)
    expect(JSON.stringify(mockAuditRows)).not.toContain(KEY)
    expect(mockUsageRows[0].metadata.summary).toContain('[withheld]')
    // `data` is used to find values, and never stored itself.
    expect(JSON.stringify(mockUsageRows[0])).not.toContain('"data"')
  })

  it('withholds the same way from an error', () => {
    recordMcpCall(CTX, { statusCode: 400, tool: 'x', error: `failed near ${KEY}` })
    expect(mockUsageRows[0].metadata.error).toBe('failed near [withheld]')
  })
})

describe('through the tool route', () => {
  it('still hands the agent its key, and stores neither copy of it', async () => {
    mockDispatch.mockResolvedValue({ ok: true, summary: createSummary, data: { apiKey: KEY, keyId: 'key-1' } })
    const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
      body: JSON.stringify({ tool: 'connect', args: { action: 'create_api_key', name: 'web' } }),
    }))
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain(KEY)
    await new Promise((r) => setImmediate(r))
    expect(mockUsageRows).toHaveLength(1)
    expect(JSON.stringify(mockUsageRows)).not.toContain(KEY)
    expect(JSON.stringify(mockAuditRows)).not.toContain(KEY)
  })
})
