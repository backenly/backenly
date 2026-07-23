/**
 * The agent workflow guide may only name tools the manifest advertises.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `get_instructions` is the document an agent reads to learn how to drive this
 * backend. It told agents to call `get_backend_metadata`, `get_table_schema`,
 * `list_tables`, `create_table`, `add_column`, `create_index`, `add_rls`,
 * `create_trigger`, `db_query`, `get_metrics`, `get_errors`, `get_readiness`,
 * `get_deploy_status`, `create_cron_job`, `enable_teams` and `connect_frontend`
 * — sixteen tools, none of which the manifest advertised after the 26→1 read
 * collapse.
 *
 * The drift was invisible from inside because every one of those names still
 * DISPATCHES: `catalogByName()` is deliberately wider than `buildCatalog()` so
 * a client pinned to an old manifest keeps working. Nothing errored, no test
 * failed, and any internal call succeeded. But an MCP host can only call what
 * the manifest advertises, so from the agent's side those tools did not exist.
 * It read a "Golden rule: get_backend_metadata → get_table_schema before you
 * write" that was impossible to follow, in the one document whose purpose is to
 * stop it guessing. Reported from a real build on 2026-07-22.
 *
 * A doc drifting from its implementation is not a thing to fix once. This is
 * the check that keeps it fixed.
 */

import { buildCatalog, STATE_SECTIONS } from '@/lib/mcp/catalog'
import { dispatchTool } from '@/lib/ai/brain/tools'

/**
 * Pull every `tool_name`-shaped token out of the guide.
 *
 * Deliberately generous: snake_case identifiers in backticks are how the guide
 * names tools, and over-matching costs a line in the allowlist below while
 * under-matching costs another silent drift.
 */
function toolLikeTokens(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    const token = m[1]
    // Multi-word snake_case only — `sql`, `id`, `token` are argument names and
    // prose, not tool names.
    if (token.includes('_')) found.add(token)
  }
  return [...found]
}

/**
 * Identifiers that look like tools but are not: argument names, section values,
 * header names and response fields. Listed explicitly so a genuinely new tool
 * reference cannot hide among them.
 */
const NOT_TOOLS = new Set([
  'project_id', 'user_id', 'author_id', 'created_at', 'updated_at', 'deleted_at',
  'table_name', 'jwt_secret', 'api_key', 'x_api_key', 'x_user_token',
  'service_role', 'last_error', 'run_count', 'trigger_type', 'trigger_table',
  'information_schema', 'pg_catalog', 'row_number', 'generated_code',
  'payment_status', 'order_items', 'record_id', 'content_range',
  // The guide's own worked example of the kebab-case rename
  // ("`list_products` deploys as `list-products`") — a user's function name,
  // not a Backenly tool.
  'list_products',
])

describe('get_instructions names only advertised tools', () => {
  let guide: string
  let advertised: Set<string>

  beforeAll(async () => {
    advertised = new Set(buildCatalog().map(t => t.name))
    const res = await dispatchTool(
      'get_instructions',
      {},
      {
        projectId: '00000000-0000-4000-8000-000000000000',
        userId: 'test',
        sessionToken: undefined,
        destructiveConfirmed: false,
        mcpOwnerConfirmed: false,
        createdThisTurn: new Set<string>(),
      } as any,
    )
    guide = res.summary ?? ''
  })

  it('produces a guide', () => {
    expect(guide.length).toBeGreaterThan(500)
  })

  it('references no tool the manifest does not advertise', () => {
    const referenced = toolLikeTokens(guide).filter(t => !NOT_TOOLS.has(t))
    const unadvertised = referenced.filter(t => !advertised.has(t))

    // Named individually so the failure says WHICH tool drifted, not just that
    // one did — the whole cost of the original bug was not knowing.
    expect(unadvertised).toEqual([])
  })

  it('states the golden rule using tools that exist', () => {
    expect(guide).toMatch(/golden rule/i)
    expect(advertised.has('read_backend_state')).toBe(true)
    expect(advertised.has('get_table_schema')).toBe(true)
  })

  it('documents the /db/ CRUD path and no bare-table alternative', () => {
    // Three different surfaces once claimed three different paths: the guide
    // said `/db/<table>`, generate_api's response said "live at /products", and
    // a 404 body said "CRUD is /{table} and /{table}/{id}". Exactly one of those
    // is real.
    expect(guide).toContain('/db/<table>')
    expect(guide).toMatch(/no bare `?\/<table>`? route/i)
  })

  it('warns that function names are kebab-cased', () => {
    expect(guide).toMatch(/kebab-case/i)
  })

  it('every read_backend_state section it advertises is dispatchable', () => {
    for (const m of guide.matchAll(/section:\s*"([a-z_]+)"/g)) {
      expect(Object.keys(STATE_SECTIONS)).toContain(m[1])
    }
  })
})

/**
 * The unregistered-schema fault must be auto-repaired, not merely noticed.
 *
 * The registration itself is now enforced in three places, but the reason this
 * shipped was not that a mechanism failed — it was that nothing was asking the
 * question. A probe classified `notify_only` would restore only half of that:
 * the platform would know a customer's data plane was dead and wait for a human
 * to read a dashboard.
 */
describe('schema_not_registered is a first-class, auto-healed finding', () => {
  it('is classified auto, so the loop repairs it without a human', async () => {
    const { classifyFix } = await import('@/lib/core/fix-classifier')
    const c = classifyFix('schema_not_registered', { reason: 'x' } as any)
    expect(c.decision).toBe('auto')
    expect(c.suggestedAction).toBeTruthy()
  })

  it('survives finding-type normalization as itself', async () => {
    const { normalizeFindingType } = await import('@/lib/core/types')
    expect(normalizeFindingType('schema_not_registered').base).toBe('schema_not_registered')
  })

  it('is one of the invariants the desired-state spec reconciles toward', async () => {
    const { INVARIANTS } = await import('@/lib/autonomy/desired-state')
    const ids = INVARIANTS.map(i => i.id)
    expect(ids).toContain('data_plane_is_registered')
  })
})
