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
    // The project's region: p-virginia is kept in us-east-1, every other one at home.
    project: { findUnique: jest.fn(async ({ where }: any) => ({ region: where.id === 'p-virginia' ? 'us-east-1' : null })) },
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
    // A placeholder the credential scan recognises as one; the shape is what matters.
    expect(withholdSecrets('postgresql://bkn_ro_abc:changeme@localhost:5432/backenly'))
      .toBe('postgresql://bkn_ro_abc:[withheld]@localhost:5432/backenly')
  })

  it('nothing from an ordinary summary, including a short key prefix shown for recognition', () => {
    const plain = 'Created table orders (4 columns). Key svc_live_a1a1... is active.'
    expect(withholdSecrets(plain)).toBe(plain)
  })
})

describe('wherever a key sits in the text', () => {
  // Stored copies are often JSON text, where a key on its own line follows the
  // two characters "\" and "n", and a key can run straight into "_" or another
  // word character. A word boundary sees neither as the edge of a key.
  const ISSUED: Array<[string, string]> = [
    ['a publishable project key', `proj_live_${'b2'.repeat(32)}`],
    ['a service-role key', `svc_live_${'a1'.repeat(32)}`],
    ['an MCP key', `mcp_live_${'c4'.repeat(32)}`],
    ['a dashboard key', `dk_admin_${'d5'.repeat(32)}`],
    ['a preview-branch key', `proj_preview_${'e6'.repeat(32)}`],
    ['a preview-branch service-role key', `svc_preview_${'f7'.repeat(32)}`],
    ['a legacy key', `sk_read_${'a8'.repeat(32)}`],
    ['a rotated key with the old prefix', `sk_live_${'c3'.repeat(24)}`],
    ['a webhook signing secret', `whsec_${'d4'.repeat(24)}`],
    ['a project admin key', `bk_admin_${'e5'.repeat(16)}`],
  ]
  const PROVIDER: Array<[string, string]> = [
    ['a Stripe secret key', `sk_live_${'Xy9'.repeat(10)}`],
    ['an Anthropic key', `sk-ant-api03-${'Xy9'.repeat(12)}`],
    ['an OpenAI project key', `sk-proj-${'Qw7'.repeat(10)}_${'Er4'.repeat(6)}-${'Ty2'.repeat(6)}`],
    ['a Resend key', `re_Ab12Cd34_${'Ef56Gh78'.repeat(3)}`],
    ['a SendGrid key', `SG.${'Xy9'.repeat(8)}.${'Zw4'.repeat(15)}`],
    ['a PostHog key', `phc_${'Gh5'.repeat(10)}`],
    ['a Replicate token', `r8_${'Jk6'.repeat(12)}`],
  ]

  it.each([...ISSUED, ...PROVIDER])('%s, after an escaped newline in JSON text', (_label, secret) => {
    const json = JSON.stringify({ summary: `Copy this key (shown once):\n${secret}\nKeep it safe.` })
    expect(json).toContain(`\\n${secret}`)
    const stored = withholdSecrets(json)
    expect(stored).not.toContain(secret)
    expect(stored).toContain('Keep it safe.')
  })

  it.each([...ISSUED, ...PROVIDER])('%s, followed by an underscore or another word character', (_label, secret) => {
    for (const after of ['_', '_backup', 'Z']) {
      const stored = withholdSecrets(`saved ${secret}${after} for later`)
      expect(stored).not.toContain(secret)
      expect(stored).toContain('for later')
    }
  })

  it('every occurrence of a provider key, not only the first', () => {
    const first = `sk_live_${'Xy9'.repeat(10)}`
    const second = `sk_live_${'Zw4'.repeat(10)}`
    expect(withholdSecrets(`old ${first}, new ${second}`)).toBe('old [KEY_REDACTED], new [KEY_REDACTED]')
  })

  it('nothing from identifiers that merely contain a provider prefix', () => {
    const plain = 'Renamed store_inventory_movements_history, future_release_notes and risk-assessmentproceduresforq3.'
    expect(withholdSecrets(plain)).toBe(plain)
  })
})

// recordMcpCall is fire-and-forget: its rows land once the project's region is read.
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('what recordMcpCall stores', () => {
  it('keeps the new key out of the usage row and the audit row', async () => {
    recordMcpCall(CTX, { statusCode: 200, tool: 'connect.create_api_key', mutation: true, summary: createSummary, data: { apiKey: KEY } })
    await flush()
    expect(JSON.stringify(mockUsageRows)).not.toContain(KEY)
    expect(JSON.stringify(mockAuditRows)).not.toContain(KEY)
    expect(mockUsageRows[0].metadata.summary).toContain('[withheld]')
    // `data` is used to find values, and never stored itself.
    expect(JSON.stringify(mockUsageRows[0])).not.toContain('"data"')
  })

  it('withholds the same way from an error', async () => {
    recordMcpCall(CTX, { statusCode: 400, tool: 'x', error: `failed near ${KEY}` })
    await flush()
    expect(mockUsageRows[0].metadata.error).toBe('failed near [withheld]')
  })

  it('keeps no summary or error at all for a project kept in another region, only what ran', async () => {
    // Both can quote the project's rows, which stay in its region (lib/data-plane/residency.ts).
    const virginia = { ...CTX, projectId: 'p-virginia' }
    recordMcpCall(virginia, { statusCode: 200, tool: 'db.insert', mutation: true, summary: 'Inserted alice@example.com' })
    recordMcpCall(virginia, { statusCode: 409, tool: 'db.insert', error: 'Key (email)=(alice@example.com) already exists' })
    await flush()
    expect(mockUsageRows.map((row) => row.metadata)).toEqual([
      { tool: 'db.insert', mutation: true, summary: undefined, error: undefined },
      { tool: 'db.insert', mutation: false, summary: undefined, error: undefined },
    ])
    expect(JSON.parse(mockAuditRows[0].details)).toMatchObject({ tool: 'db.insert' })
    expect(JSON.stringify([mockUsageRows, mockAuditRows])).not.toContain('alice@example.com')
  })

  it('still keeps an error code for a project kept in another region, which quotes nothing', async () => {
    // The admin agent-ops view tells a partly applied migration from a refusal by this code.
    const virginia = { ...CTX, projectId: 'p-virginia' }
    recordMcpCall(virginia, { statusCode: 500, tool: 'apply_migration', mutation: true, error: 'MIGRATION_FAILED', summary: 'migration: 3 statement(s), failed at alice@example.com' })
    recordMcpCall(virginia, { statusCode: 403, tool: 'db.delete', error: 'READ_ONLY_KEY' })
    await flush()
    expect(mockUsageRows.map((row) => row.metadata.error)).toEqual(['MIGRATION_FAILED', 'READ_ONLY_KEY'])
    expect(JSON.stringify(mockUsageRows)).not.toContain('alice@example.com')
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
