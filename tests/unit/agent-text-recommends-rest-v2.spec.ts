/**
 * WHAT AN AGENT IS TOLD TO BUILD ON: /api/v2 OR THE SDK, NEVER /db
 * ================================================================
 *
 * /api/v2/{projectId}/{table} is the one REST API (production QA, #22: two
 * dialects over the same tables); /db is deprecated, kept for existing apps
 * (lib/api/v1/deprecation.ts). The guide every MCP session reads
 * (get_instructions) gave /db as the "one form only" for CRUD and v2 as "also
 * available", and the brain's capabilities, the overview read_backend_state
 * prints and a preview branch's instructions pointed at /db the same way.
 *
 * The rule pinned here: each text names /api/v2 for tables, and any line that
 * still mentions /db says it is deprecated, kept for existing apps.
 */

jest.mock('@/lib/data-plane/regional', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional')
  return { ...actual, projectApiOrigin: async () => 'https://api.example.test' }
})

import { dispatchTool } from '@/lib/ai/brain/tools'
import { OPERATOR_MODEL, PLATFORM_SURFACE_MAP, TOOL_CAPABILITIES } from '@/lib/ai/brain/capabilities'
import { formatProof, type ProofBlock } from '@/lib/ai/proof-system'
import { previewAgentInstructions, previewCurl, previewEndpoint } from '@/lib/branches/preview'

const P = '6f1c2a8e-4b3d-4c5e-9f60-718293a4b5c6'

/** Lines that mention /db and do not say it is only for existing apps. */
function recommendsDb(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /\/db\b/.test(line))
    .filter((line) => !/deprecated|existing apps/i.test(line))
}

describe('the MCP guide (get_instructions)', () => {
  let guide = ''
  beforeAll(async () => {
    const r = await dispatchTool('get_instructions', {}, { projectId: P, createdThisTurn: new Set<string>() })
    expect(r.ok).toBe(true)
    guide = r.summary
  })

  it('gives /api/v2 as the REST API for tables, with the SDK', () => {
    expect(guide).toContain(`Tables over REST: \`https://api.example.test/api/v2/${P}/<table>\``)
    expect(guide).toContain('the REST API is `/api/v2/<projectId>/<table>`, in PostgREST\'s grammar')
    expect(guide).toContain('`@backenly/sdk`')
  })

  it('names /db only as deprecated, kept for existing apps', () => {
    expect(recommendsDb(guide)).toEqual([])
    expect(guide).toMatch(/`\/db\/<table>` under the base URL is deprecated: it is kept for existing apps/)
  })
})

describe('the brain’s own picture of the platform', () => {
  it('lists the REST endpoints on /api/v2', () => {
    const listApis = TOOL_CAPABILITIES.find((c) => c.name === 'List REST endpoints (read)')!
    expect(listApis.what).toContain('/api/v2/{projectId}/{table}')
    expect(recommendsDb(listApis.what)).toEqual([])
  })

  it('never offers /db without saying it is deprecated', () => {
    const all = [OPERATOR_MODEL, PLATFORM_SURFACE_MAP, ...TOOL_CAPABILITIES.map((c) => c.what)].join('\n')
    expect(recommendsDb(all)).toEqual([])
  })
})

describe('read_backend_state’s overview', () => {
  it('names the tables on /api/v2', () => {
    const proof = {
      tables: ['orders', 'products'],
      apis: [
        { method: 'REST', path: '/orders', tableName: 'orders' },
        { method: 'REST', path: '/products', tableName: 'products' },
      ],
      authEnabled: false,
      authProviders: [],
      rlsPolicies: [],
      rlsByTable: [],
      buckets: [],
      integrations: [],
      realtimeTables: [],
      nothingBuilt: false,
    } as unknown as ProofBlock
    const text = formatProof(proof)
    expect(text).toContain('REST endpoints at /api/v2/{projectId}/<table>')
    expect(recommendsDb(text)).toEqual([])
  })
})

describe('a preview branch’s endpoint', () => {
  const endpoint = previewEndpoint(P, { id: 'b1', name: 'add-orders' }, 'https://backenly.test')

  it('smoke-tests the REST API', () => {
    expect(previewCurl(endpoint, 'orders')).toContain(`https://backenly.test/api/v2/${P}/orders?limit=5`)
  })

  it('tells a test to use /api/v2, and /db only as deprecated', () => {
    const text = previewAgentInstructions(endpoint)
    expect(text).toContain(`REST API: https://backenly.test/api/v2/${P}/{table}`)
    expect(recommendsDb(text)).toEqual([])
  })
})
