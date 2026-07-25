/**
 * The public docs must describe the tools that actually exist.
 *
 * ── Why this is a test and not a copy edit ───────────────────────────────────
 *
 * `public/llms.txt` is the file agents fetch to learn Backenly's vocabulary — via
 * `fetch_docs`, and directly, because the install snippet points at it. It had
 * drifted badly enough to send a real session down the wrong path (defect #19):
 *
 *   - It documented `create_table`, `add_column`, `create_index`, `add_rls`,
 *     `create_trigger`, `list_tables`, `get_backend_metadata`, `get_metrics` and
 *     `db_query` as the advertised surface. The 26→1 consolidation had removed
 *     all of them from the manifest.
 *   - It never mentioned `apply_migration`, `read_backend_state`, `branch`,
 *     `create_api_key`, `set_env_var` or `adopt_external_schema` — six of the
 *     twenty tools a host actually receives, including the only write door for
 *     schema changes.
 *   - It named `add_rls` as the way to set a policy. That is still dispatchable,
 *     but it is not advertised, so an agent reading the docs looked for a tool it
 *     could not see and concluded RLS was unreachable.
 *
 * A copy edit fixes today's drift and nothing else. This asserts the invariant,
 * so the next change to the catalog fails here instead of in a customer's
 * session six weeks later.
 */

import fs from 'fs'
import path from 'path'
import { buildCatalog, buildDispatchable } from '@/lib/mcp/catalog'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'

const LLMS_TXT = fs.readFileSync(path.join(process.cwd(), 'public', 'llms.txt'), 'utf8')

/** Tool names the doc mentions inside backticks. */
function mentionedTools(): Set<string> {
  const out = new Set<string>()
  for (const m of LLMS_TXT.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) out.add(m[1])
  return out
}

describe('llms.txt describes the real MCP surface', () => {
  const advertised = buildCatalog().map((t) => t.name)
  const dispatchable = new Set(buildDispatchable().map((t) => t.name))
  /**
   * Every tool name that really exists.
   *
   * The union of three sets, because no single one is complete:
   *   - BRAIN_TOOLS         — the brain's own vocabulary, including the destructive
   *                           tools `buildDispatchable` filters out.
   *   - buildDispatchable() — plus the SYNTHETIC MCP tools that have no brain
   *                           entry at all (backend_chat, apply_migration,
   *                           db_insert/update/delete, check_approval, fetch_docs).
   * Using either alone would flag half the real surface as invented.
   */
  const realTools = new Set<string>([
    ...BRAIN_TOOLS.map((t) => t.function?.name).filter((n): n is string => !!n),
    ...dispatchable,
  ])

  it('mentions every advertised tool', () => {
    const mentioned = mentionedTools()
    const missing = advertised.filter((name) => !mentioned.has(name))
    expect(missing).toEqual([])
  })

  it('states the advertised tool count correctly', () => {
    // The count is load-bearing copy: it is the justification for the allowlist.
    // A stale number undermines the paragraph it appears in.
    expect(LLMS_TXT).toMatch(new RegExp(`\\*\\*${advertised.length}\\*\\* tools are advertised`))
  })

  it('does not present a non-existent tool as callable', () => {
    // Every backticked snake_case token that LOOKS like a tool must correspond to
    // a real brain tool. Anything else is a tool the docs invented — which is the
    // failure that sent a session hunting for `add_rls` in a manifest that no
    // longer advertised it, and for `get_backend_metadata`, which the brain's own
    // response also referenced.
    //
    // `buildDispatchable` is not the right denominator on its own: it filters out
    // every destructive tool, and the docs legitimately NAME those to explain the
    // approval path. The real question is "does this tool exist in the brain?".
    const KNOWN_NON_TOOLS = new Set([
      // Identifiers that share the snake_case shape but are not tools: column
      // names, policy templates, function triggers, CLI binaries, SQL.
      'api_key', 'x_api_key', 'user_id', 'author_id', 'owner_id', 'created_by',
      'requester_id', 'addressee_id', 'user_a', 'user_b', 'sender_id',
      'recipient_id', 'organization_id', 'conversation_id', 'deleted_at',
      'created_at', 'updated_at', 'password_hash', 'jwt_secret', 'service_role',
      'not_null', 'group_by', 'on_delete', 'row_level_security',
      'owner_read_write', 'owned_via_parent', 'public_read', 'org_members',
      'admin_only', 'all_access', 'party_rows', 'own_rows', 'related_rows',
      'http_headers', 'search_path', 'gen_random_uuid', 'backenly_jwt_claim',
      'anon_key', 'project_id', 'pg_dump', 'pg_policies',
      'on_signup', 'on_insert', 'on_update', 'on_delete_row',
      'backenly_types', 'service_key', 'x_backenly_key',
    ])
    const suspicious = [...mentionedTools()].filter(
      (name) => name.includes('_') && !realTools.has(name) && !KNOWN_NON_TOOLS.has(name),
    )
    expect(suspicious).toEqual([])
  })

  it('every tool the docs name is dispatchable OR explained as retired/destructive', () => {
    const named = [...mentionedTools()].filter((n) => realTools.has(n))
    // A tool that is real but neither advertised nor explained is the worst case:
    // an agent reads it, cannot see it in tools/list, and has no way to know it is
    // still callable.
    const unexplained = named.filter(
      (name) =>
        !dispatchable.has(name) &&
        !new RegExp(`Older tool names[\\s\\S]{0,1200}\`${name}\``).test(LLMS_TXT) &&
        !new RegExp(`Destructive tools[\\s\\S]{0,600}\`${name}\``).test(LLMS_TXT) &&
        !new RegExp(`\`${name}\`[\\s\\S]{0,400}backend_chat`).test(LLMS_TXT),
    )
    expect(unexplained).toEqual([])
  })

  it('does not claim add_rls is advertised, since it is not', () => {
    // It IS dispatchable, and it is the tool an agent needs for a custom policy —
    // so the doc must route to it through backend_chat rather than imply the host
    // will offer it directly.
    expect(dispatchable.has('add_rls')).toBe(true)
    expect(advertised).not.toContain('add_rls')
    expect(LLMS_TXT).toMatch(/add_rls[\s\S]{0,200}backend_chat|backend_chat[\s\S]{0,200}add_rls/)
  })

  it('documents the party/participants template, which owner-only RLS cannot express', () => {
    expect(LLMS_TXT).toMatch(/participants/)
    expect(LLMS_TXT).toMatch(/custom/)
  })

  it('explains that REST endpoints need no generation step', () => {
    // An agent that believes a table needs generate_api to be reachable ships a
    // schema it thinks is unusable, or burns a call per table proving otherwise.
    expect(LLMS_TXT).toMatch(/REST endpoints are automatic/i)
  })

  it('distinguishes a failed approval from a partial one', () => {
    expect(LLMS_TXT).toMatch(/partial/)
  })
})
