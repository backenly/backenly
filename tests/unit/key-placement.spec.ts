/**
 * Where a key may be used, proved without a server.
 *
 * The runtime refuses two misplaced keys (lib/security/key-placement.ts): an MCP
 * key anywhere on the runtime API, and a service-role key from a browser. This
 * pins the parts that decide and explain it: which rows count as an MCP
 * credential, which codes are placement refusals (403, never 401), and the
 * refusal itself, in each surface's own error vocabulary.
 *
 * The refusal is read by a developer or an agent at the moment it can act, so it
 * also has to name a fix that exists. The call it tells an agent to make is
 * checked against the MCP catalog here, so the message cannot drift from the
 * tool it names. And because a refusal is the last line, the first one is pinned
 * too: every surface an agent reads before writing app code says which key an
 * app uses.
 *
 * The doors themselves, over a real socket and a real database, are in
 * tests/integration/key-placement-surfaces.spec.ts.
 */

import {
  MCP_KEY_HINT,
  MCP_KEY_IN_APP,
  isKeyPlacementRefusal,
  isMcpCredential,
  mcpKeyInAppRefusal,
  mcpKeyRefusalMessage,
  serviceRoleInBrowserRefusal,
} from '@/lib/security/key-placement'
import fs from 'fs'
import path from 'path'
import { SERVICE_ROLE_IN_BROWSER } from '@/lib/security/service-role-exposure'
import { getDomainTool } from '@/lib/mcp/domains'
import { BRAIN_TOOLS, dispatchTool } from '@/lib/ai/brain/tools'
import { buildMcpInstructions } from '@/lib/mcp/protocol/shared'

describe('isMcpCredential', () => {
  it('is true for a key minted on Connect → Agents', () => {
    // The exact shape app/api/projects/[id]/mcp/keys/route.ts writes.
    expect(isMcpCredential({ scope: 'mcp', keyType: 'mcp' })).toBe(true)
  })

  it('is true for an OAuth connection, which shares the row', () => {
    expect(isMcpCredential({ scope: 'mcp', keyType: 'mcp_oauth' })).toBe(true)
  })

  it('is true when only one of the two fields says so', () => {
    expect(isMcpCredential({ scope: 'mcp', keyType: 'public' })).toBe(true)
    expect(isMcpCredential({ scope: 'runtime', keyType: 'mcp' })).toBe(true)
  })

  it('is false for project keys, publishable or service-role', () => {
    // Service role is a separate rule (browsers only); it must not be read as MCP.
    expect(isMcpCredential({ scope: 'runtime', keyType: 'public' })).toBe(false)
    expect(isMcpCredential({ scope: null, keyType: null })).toBe(false)
    expect(isMcpCredential({})).toBe(false)
  })
})

describe('isKeyPlacementRefusal', () => {
  it('covers both rules', () => {
    expect(isKeyPlacementRefusal(MCP_KEY_IN_APP)).toBe(true)
    expect(isKeyPlacementRefusal(SERVICE_ROLE_IN_BROWSER)).toBe(true)
  })

  it('leaves real authentication failures as 401s', () => {
    for (const code of ['INVALID_API_KEY', 'API_KEY_EXPIRED', 'NO_PROJECT_ID', 'BRANCH_INACTIVE', '', undefined, null]) {
      expect(isKeyPlacementRefusal(code)).toBe(false)
    }
  })
})

describe('the MCP refusal', () => {
  it('names the key and says it is refused from anywhere, not only browsers', () => {
    const msg = mcpKeyRefusalMessage('MCP Key')
    expect(msg).toContain('"MCP Key"')
    expect(msg).toMatch(/is an MCP key/)
    expect(msg).toMatch(/never accepts it, from a browser or from a server/)
  })

  it('still reads correctly for an unnamed key', () => {
    expect(mcpKeyRefusalMessage(null)).toMatch(/^This key is an MCP key/)
  })

  it('tells the caller which key to use instead, from either side', () => {
    expect(MCP_KEY_HINT).toContain('connect { action: "create_api_key", description: "web app" }')
    expect(MCP_KEY_HINT).toContain('Settings → API keys → New key → Client')
    expect(MCP_KEY_HINT).toContain('X-User-Token')
    expect(MCP_KEY_HINT).toContain('serviceRole: true')
    // And what to do about the key that leaked.
    expect(MCP_KEY_HINT).toMatch(/revoke it in Connect → Agents/)
  })

  it('names a call the MCP catalog really has', () => {
    const connect = getDomainTool('connect')
    expect(connect?.actions.create_api_key?.tool).toBe('create_api_key')
    const createKey = BRAIN_TOOLS.find((t) => t.function?.name === 'create_api_key')
    const params = Object.keys(((createKey?.function?.parameters as any)?.properties ?? {}) as object)
    expect(params).toEqual(expect.arrayContaining(['description', 'serviceRole']))
  })
})

describe('the refusal body speaks the surface it answers on', () => {
  it('answers /api/v1 with { error, code, hint }', () => {
    const r = mcpKeyInAppRefusal('MCP Key', '/api/v1/7f1c0e4e-0000-4000-8000-000000000000/db/posts')
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: mcpKeyRefusalMessage('MCP Key'), code: MCP_KEY_IN_APP, hint: MCP_KEY_HINT })
  })

  it('answers /api/v2 with PostgREST’s { code, message, hint }', () => {
    const r = mcpKeyInAppRefusal('MCP Key', '/api/v2/7f1c0e4e-0000-4000-8000-000000000000/posts?select=*')
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: MCP_KEY_IN_APP, message: mcpKeyRefusalMessage('MCP Key'), hint: MCP_KEY_HINT })
  })

  it('reads the surface from the path alone, not from a look-alike', () => {
    expect(mcpKeyInAppRefusal(null, '/api/v2').body.message).toBeDefined()
    expect(mcpKeyInAppRefusal(null, '/api/v1/things?next=/api/v2/x').body.error).toBeDefined()
    expect(mcpKeyInAppRefusal(null, '/api/v20/things').body.error).toBeDefined()
  })

  it('refuses a service-role key from a browser the same way, with its own code', () => {
    const r = serviceRoleInBrowserRefusal('server key', '/api/v1/7f1c0e4e-0000-4000-8000-000000000000/storage/files')
    expect(r.status).toBe(403)
    expect(r.body.code).toBe(SERVICE_ROLE_IN_BROWSER)
    expect(r.body.error).toMatch(/service-role key and this request came from a browser/)
  })
})

describe('an agent is told which key an app uses, before it writes one', () => {
  // The refusal is the safety net. This is the first line: every surface an
  // agent reads before writing app code says its own key is not an app key and
  // how to get the one that is. Nothing said so when the MCP key was shipped in a
  // frontend, so the wording is pinned here rather than trusted to survive edits.
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
  const CREATE = 'connect { action: "create_api_key"'

  it('in the brief every MCP host injects on connect', () => {
    const brief = buildMcpInstructions('Demo', 20)
    expect(brief).toContain('mcp_live_')
    expect(brief).toMatch(/the runtime API refuses it/)
    expect(brief).toContain(CREATE)
  })

  it('in the workflow guide', async () => {
    const res = await dispatchTool('get_instructions', {}, {
      projectId: '00000000-0000-4000-8000-000000000000',
      userId: 'test',
      sessionToken: undefined,
      destructiveConfirmed: false,
      mcpOwnerConfirmed: false,
      createdThisTurn: new Set<string>(),
    } as any)
    expect(res.summary).toMatch(/Never use your own MCP key/)
    expect(res.summary).toContain(CREATE)
    expect(res.summary).toContain(MCP_KEY_IN_APP)
  })

  it.each([
    { file: 'public/llms.txt' },
    { file: 'public/skill.md' },
    { file: 'public/docs/agents/client-setup.md' },
  ])('in $file', ({ file }) => {
    const text = read(file)
    expect(text).toMatch(/project key is (never your|not the) MCP key/i)
    expect(text).toContain(CREATE)
    expect(text).toContain(MCP_KEY_IN_APP)
  })

  it('and the SDK quickstart does not read the app key from the MCP key’s variable', () => {
    // BACKENLY_API_KEY is where @backenly/mcp-server and the CLI read the MCP key
    // from, so an app reading the same name picks up the agent's key.
    const readme = read('packages/sdk/README.md')
    expect(readme).not.toMatch(/apiKey:\s*process\.env\.BACKENLY_API_KEY\b/)
    expect(readme).toContain('mcp_live_')
  })
})
