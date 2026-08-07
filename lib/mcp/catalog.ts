/**
 * MCP Tool Catalog — the public, MCP-shaped projection of the brain's tool
 * surface.
 *
 * The brain has 80 internal tools (lib/ai/brain/tools.ts). For MCP we expose a
 * curated subset that maps cleanly onto host-LLM tool calling, in four tiers:
 *
 *   Tier 1  backend_chat     — natural-language fall-through to runBrain.
 *                              The killer feature: a Claude Code user does NOT
 *                              need to know the tool vocabulary. They say
 *                              "add likes to my posts table" and Backenly's
 *                              brain orchestrates the rest.
 *
 *   Tier 2  read tools       — every READ_ONLY_TOOL in brain/tools.ts.
 *                              Safe by definition, no confirmation needed.
 *
 *   Tier 3  build tools      — non-destructive mutations (create/add/enable).
 *                              The full agentic surface for fine-grained
 *                              orchestration.
 *
 *   Tier 5  runtime data     — db_query / db_insert / db_update / db_delete.
 *                              CRUD on workspace tables for seeding, debugging,
 *                              and apps Claude Code might build.
 *
 *   Tier 4 (destructive)  — INTENTIONALLY OMITTED in v1. drop_table /
 *                            truncate_table / delete_bucket are dashboard-only.
 *                            We do not want a host LLM auto-confirming a drop.
 *
 * This file is the single source of truth — every MCP surface (manifest
 * endpoint, server-side tool dispatch, the published npm package) reads from
 * here so we never get the catalog out of sync with what's actually callable.
 */

import { BRAIN_TOOLS, READ_ONLY_TOOLS, isDestructiveTool } from '@/lib/ai/brain/tools'

export type McpTier = 'chat' | 'read' | 'build' | 'data'

export interface McpToolDescriptor {
  /** Public name the host LLM sees (snake_case). */
  name: string
  /** Tier label so the npm package and dashboard can group these. */
  tier: McpTier
  /** Human description carried straight through to the host LLM. */
  description: string
  /** JSON Schema for the tool's parameters. Always object-typed. */
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

/**
 * Brain tools we deliberately do NOT expose to MCP, beyond the destructive
 * set. These are control-loop tools that only make sense inside `runBrain`:
 *   - propose_plan / ask_user / answer_question / finish — terminal control,
 *     meaningful only when the LLM is steering the agent loop. From an MCP
 *     host's perspective, the host is doing the steering.
 *   - run_test / rollback — internal verifier hooks. The host LLM can call
 *     `get_metrics` or `get_errors` to verify itself.
 *   - fix_backend / apply_proposal — assume a backenly-resident agent context
 *     that doesn't exist on an MCP call.
 *   - add_oauth_provider / enable_push_notifications — credential-collection
 *     flows that need an interactive ask. The host LLM should `backend_chat`
 *     for these and let the brain run its credential flow.
 */
const MCP_EXCLUDE = new Set<string>([
  'propose_plan',
  'ask_user',
  'answer_question',
  'finish',
  'run_test',
  'rollback',
  'fix_backend',
  'apply_proposal',
  // Credential-gated tools — call backend_chat instead so brain can ask user.
  'add_oauth_provider',
  'enable_push_notifications',
])

/** Build tools (non-destructive mutations) — assigned to tier 'build'. */
const BUILD_TOOLS = new Set<string>([
  'create_branch', 'merge_branch',
  'create_table', 'add_column', 'create_index', 'rename_column', 'add_constraint',
  // (list_branches / diff_branch are read tools; all four are reachable through
  // the single advertised `branch` tool — see BRANCH_ACTIONS.)
  'generate_api', 'enable_auth', 'create_bucket', 'set_bucket_public', 'add_rls', 'set_rls',
  'create_trigger', 'enable_realtime', 'generate_function', 'enable_vector_search',
  'create_cron_job', 'set_rate_limit', 'generate_aggregate_api', 'enable_teams',
  'send_push', 'rotate_webhook_secret', 'connect_frontend',
  'set_env_var', 'reset_end_user_password', 'unblock_end_user',
  'create_api_key', 'set_key_permissions',
  'store_integration_key', 'toggle_ai_function', 'set_alert', 'set_autonomy_level',
  // Open loop: direct Postgres access + drift adoption. get_database_credentials
  // provisions a role (mutation) — READ_ONLY on demand; READ_WRITE only returns
  // after the human armed it in the dashboard. adopt_external_schema is
  // bookkeeping-only reconciliation (never DDL).
  'get_database_credentials', 'adopt_external_schema',
])

function tierOf(name: string): McpTier | null {
  if (READ_ONLY_TOOLS.has(name as any)) return 'read'
  if (BUILD_TOOLS.has(name)) return 'build'
  return null
}

/**
 * ── The advertised surface ───────────────────────────────────────────────────
 *
 * Everything below this comment used to be advertised: 71 tools, ~9,300 tokens
 * of JSON Schema pushed at the host LLM before the user typed a character. That
 * was the single largest cause of MCP unreliability, and it was self-inflicted.
 *
 * The evidence, measured on the live key and corroborated externally:
 *
 *   - Tool-selection accuracy degrades with catalog size. Sonnet-class models
 *     hold >=90% to ~20 tools and fall below by 30; past 50 it collapses. We
 *     were at 71.
 *   - Models misfire between tools whose NAMES are similar. We shipped `query`,
 *     `db_query` and `run_query` simultaneously — three doors to two behaviours.
 *   - Mature MCP database servers facing the same choice refuse to add ~20
 *     specialised tools and pick depth (SQL power) over breadth (a tool per
 *     operation) — keeping the whole database surface at around 5 tools.
 *
 * So the catalog is now an explicit ALLOWLIST, not a projection of everything
 * the brain can do. The rule for admission is not "is this useful" — nearly all
 * 71 were useful — but:
 *
 *     Is there exactly ONE tool here that answers a given request?
 *
 * Anything with a competing door is removed and reached through the door that
 * survived. Anything niche is reached through `backend_chat`, which is what it
 * has always been for. Capability is unchanged; the number of DECISIONS the
 * model must get right dropped by a factor of four.
 *
 * Tools not on this list remain DISPATCHABLE (see `buildDispatchable`) so that
 * already-configured clients pinned to an older @backenly/mcp-server keep
 * working — being unlisted costs an agent nothing, while being listed costs
 * every agent accuracy on every call.
 */
const MCP_SURFACE = new Set<string>([
  // Natural language — the fall-through for everything not listed here.
  'backend_chat',
  // One read door for state, one for data.
  'read_backend_state',
  'run_query',
  // ── Per-table detail, advertised on purpose ────────────────────────────────
  //
  // The 26→1 collapse folded every list_*/get_* into read_backend_state, and
  // this one went with them. That was a mistake, for a reason the collapse's own
  // logic supports: the argument for collapsing was that 26 tools all answered
  // "what is currently true?" and the choice between them was pure overhead.
  // This does not answer that question — it answers "what will this specific
  // table REJECT?", which is a different job and the one the whole workflow
  // depends on.
  //
  // Concretely, it returns each column's type/nullability/default, the foreign
  // keys, and the CHECK constraints WITH THEIR PERMITTED VALUES. An agent that
  // has not read those writes an insert that looks correct and fails on a
  // constraint it had no way to see. `read_backend_state {section:"schema"}`
  // spans every table and cannot carry that depth without flooding the context.
  //
  // It was also the only tool named in the "golden rule" the instructions have
  // always given — a rule that was literally unfollowable while this stayed
  // unadvertised.
  'get_table_schema',
  // One write door for schema, three unambiguous verbs for rows.
  'apply_migration',
  'db_insert',
  'db_update',
  'db_delete',
  // ── Preview branches — ONE door, four verbs ────────────────────────────────
  //
  // Leaving branches unadvertised had a specific cost: an agent doing schema
  // work had no way to try a migration first, so every change went straight at
  // live customer data. Asking for a branch produced "Backenly does not support
  // preview branches", which is false — the engine, the model, the API and the
  // dashboard page all exist. Only the door was missing.
  //
  // But four tools (create/list/diff/merge) would have taken the surface to 23,
  // past the ~20 where tool-selection accuracy starts to degrade — the exact
  // budget this allowlist exists to defend. So they collapse into one tool with
  // an `action` enum, the same trade `read_backend_state` makes: picking a
  // STRING inside a chosen tool is a far easier decision for a model than
  // picking between four similarly-named tools, and it costs a quarter of the
  // context. All four still dispatch individually for pinned clients.
  //
  // `discard` is deliberately not one of the actions: it is destructive, so it
  // routes through backend_chat → the human Review Queue like every other
  // irreversible operation.
  'branch',
  // ── set_rls — the deterministic door onto the one security-critical write ──
  //
  // RLS was reachable only through `backend_chat`. `add_rls` dispatches but was
  // never advertised, so from an MCP host's side it did not exist, and the only
  // way to write a policy was to describe it to a language model.
  //
  // That put the single operation where being wrong is a vulnerability behind
  // the single least deterministic path, and every consequence followed from it:
  // a request to change UPDATE and DELETE re-derived all four commands and
  // reverted SELECT; `P AND sender_id = sub` came back as `P`, dropping the
  // conjunct that restricted it; a cross-table EXISTS regressed to the
  // owner-column form the model knew best. All three are the same failure — a
  // predicate re-generated from prose instead of applied as written — and none
  // of them is fixable with a better prompt. It was also the only write with no
  // non-LLM fallback, so provider rate limiting blocked it outright.
  //
  // This tool takes the SQL verbatim, installs exactly the commands named, and
  // reads pg_policies back before reporting. `add_rls` remains for the named
  // templates and stays dispatchable.
  'set_rls',
  // Capabilities with no SQL expression and no competing tool.
  'enable_auth',
  'create_bucket',
  // ── Deliberately absent: generate_api ─────────────────────────────────────
  //
  // It contradicts what read_backend_state now says. Since the PostgREST
  // cutover the REST surface is derived from the catalog — `/db/<table>` is live
  // the moment a table exists — and the state report says so in those words
  // ("automatic — every table is served from the catalog", the defect #13 fix).
  //
  // Advertising a generation step beside that message asks an agent to believe
  // both. It writes an ApiDefinition metadata row and nothing that serves
  // traffic, so an agent that calls it has spent a turn to change nothing
  // observable, and one that DOESN'T call it may conclude its tables are
  // unreachable. Still dispatchable for pinned clients, per the note on
  // buildDispatchable — this removes a selection cost, not a capability.
  //
  // The slot it frees goes to generate_types, which the surface genuinely
  // lacked. Net advertised count is unchanged.
  'generate_function',
  'enable_realtime',
  'create_api_key',
  'set_env_var',
  // ── Deliberately absent: trigger_deploy, delete_ai_function ───────────────
  //
  // Both were reported as missing from a real build ("Project stuck
  // not_deployed with no MCP tool to deploy", "No way to delete a function via
  // MCP — my scratch diag-echo is stuck deployed"), and listing them here does
  // nothing: `buildDispatchable()` skips every tool `isDestructiveTool()` names,
  // so they would be filtered before reaching the manifest.
  //
  // That filter is the design, not an oversight. Shipping to production and
  // deleting a deployed function are outward-facing and hard to reverse, so
  // they route through backend_chat → the human Review Queue → check_approval.
  // The agent CAN do both; it just cannot do them unilaterally.
  //
  // What was actually broken was the documentation. get_instructions listed the
  // approval path as covering "drop_table / truncate_table / drop_column /
  // delete_bucket" — an incomplete list that did not include deploying or
  // deleting a function, so an agent looking for either concluded no path
  // existed. Fixed in the guide rather than by widening the surface: the answer
  // to "I could not find the door" is a sign, not a second door.
  //
  // Direct Postgres access.
  'get_database_credentials',
  // ── Deliberately absent: adopt_external_schema ────────────────────────────
  //
  // The slot pays for `set_rls`. This allowlist is capped at 20 by test, and the
  // cap is the point — every addition has to displace something rather than
  // quietly cost every other call its accuracy.
  //
  // This is the weakest tool on the list to give up. It is bookkeeping-only and
  // never emits DDL: it reconciles Backenly's metadata after someone changed the
  // schema directly over psql. So it changes nothing an end-user can observe,
  // and an agent that needs it is already inside an advanced workflow — it has
  // called get_database_credentials, connected with a Postgres client, and run
  // its own DDL. One `backend_chat` at the end of that is not the friction that
  // writing a security policy through a language model was.
  //
  // Still dispatchable for pinned clients, and get_database_credentials names it
  // in its own response so the door is signposted where it is actually needed.
  // Agent self-service.
  'fetch_docs',
  'check_approval',
  // ── generate_types ─────────────────────────────────────────────────────────
  //
  // The generator has existed for a long time (lib/typegen) and was reachable
  // from the CLI and the dashboard — never from MCP. So an agent building a typed
  // frontend against a Backenly project hand-wrote its row types, and those types
  // then drifted silently on the next schema change with nothing to detect it.
  //
  // That is the single cheapest high-value tool on this surface: one call, no
  // mutation, and it removes an entire class of stale-type bug from the workflow
  // this product is for. Competing platforms expose exactly this.
  'generate_types',
])

/**
 * The advertised catalog — what `GET /api/mcp/manifest` returns and what a host
 * LLM actually sees. Filtered from the full surface so there is exactly one
 * definition of every tool.
 */
export function buildCatalog(opts?: { readOnly?: boolean }): McpToolDescriptor[] {
  const advertised = buildDispatchable().filter((t) => MCP_SURFACE.has(t.name))
  if (!opts?.readOnly) return advertised
  return advertised.filter((t) => isReadOnlyTool(t.name))
}

/**
 * Synthetic tools that are safe on a read-only key.
 *
 * `READ_ONLY_TOOLS` covers the brain's own vocabulary, but the catalog also
 * hand-writes descriptors that have no BRAIN_TOOLS entry, so membership there
 * cannot answer for them. Rather than infer from the tier — which is 'data' for
 * both db_query and db_delete — each one is decided explicitly here.
 *
 * Deliberately excluded, with reasons:
 *   • backend_chat    — the brain can apply non-destructive changes (create_table
 *                       and friends) without ever reaching the destructive gate.
 *                       A read-only key that can reach it is not read-only.
 *   • branch          — `list`/`diff` are reads but `create`/`merge` are not, and
 *                       the action is a runtime string. A tool that is
 *                       conditionally safe is not safe to advertise as read-only.
 *   • apply_migration — DDL by definition.
 *   • db_insert/update/delete — writes by definition.
 *   • get_database_credentials — provisions a Postgres role. It is in BUILD_TOOLS
 *                       already; named here so the omission reads as deliberate
 *                       rather than forgotten.
 */
const READ_ONLY_SYNTHETIC = new Set(['fetch_docs', 'generate_types', 'check_approval', 'db_query'])

/** True when `name` may be served to a read-only key. */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name as any) || READ_ONLY_SYNTHETIC.has(name)
}

/**
 * Every tool `/api/mcp/tool` will still execute, advertised or not.
 *
 * Kept deliberately wider than the catalog: an agent configured against an
 * older manifest still has `list_tables` in its context, and 404-ing that call
 * would break a working setup to buy nothing. Unlisted-but-callable removes the
 * selection cost without the breakage.
 */
export function buildDispatchable(): McpToolDescriptor[] {
  const out: McpToolDescriptor[] = []

  out.push({
    name: 'backend_chat',
    tier: 'chat',
    description:
      'Run a natural-language request through the Backenly brain — the same agent that powers backenly.com. ' +
      'Use this whenever the user describes WHAT they want without naming specific tools ("create a blog backend", ' +
      '"add likes and comments to my posts table", "make the orders API faster"). The brain decides the steps, ' +
      'executes them, and returns a human summary. Prefer this over chaining individual tools unless you have a ' +
      'specific reason. Long-running multi-step plans take 5-30s. If the request involves a destructive operation ' +
      '(dropping tables/columns, deleting buckets), it is NOT executed — the response includes an `approval` object ' +
      'with a pending request id: the human approves it in the Backenly Review Queue, and you poll `check_approval` ' +
      'until it is executed or rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The natural-language request. Be specific — e.g. "create a table called posts with id, title, body, author_id (FK users), and timestamps" works better than "make a posts table".',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  })

  // fetch_docs — self-serve documentation for the connected agent (§9.3).
  // Cheap, high-leverage: the host LLM pulls current Backenly API/tool docs at
  // run time instead of hallucinating a vocabulary. Read-only, no brain call.
  out.push({
    name: 'fetch_docs',
    tier: 'read',
    description:
      'Fetch Backenly documentation as Markdown so you can answer questions and use the right tools without guessing. ' +
      'Call with no arguments for the full agent guide (capabilities, API shape, tool vocabulary), or pass `topic` ' +
      '(e.g. "auth", "database", "storage", "realtime", "functions", "mcp") to get just that section. ' +
      'Prefer this over assuming endpoint shapes or tool names.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional section to narrow the docs, e.g. "auth", "database", "storage", "realtime", "functions", "integrations", "mcp".',
        },
      },
      additionalProperties: false,
    },
  })

  // generate_types — TypeScript row types straight from the live catalog.
  //
  // Read-only, one call, no brain. It closes the loop between "the agent changed
  // the schema" and "the frontend's types still describe the old one": before
  // this, an agent building a typed client had to hand-write row types, and
  // nothing detected that they had gone stale on the next migration.
  out.push({
    name: 'generate_types',
    tier: 'read',
    description:
      'Generate TypeScript types for every table in this project, read from the live PostgreSQL catalog. ' +
      'Returns ready-to-save source — write it to a file (conventionally `src/backenly.types.ts`) and import ' +
      '`Database`, `Row<T>`, `Insert<T>`, `Update<T>` and `TableName` from it. ' +
      'format="dts" (default) is the type declarations; format="client" additionally emits a typed client ' +
      'bound to this project; format="openapi" emits an OpenAPI 3.1 spec of the REST surface. ' +
      'ALWAYS call this instead of hand-writing row types — hand-written types drift silently the next time ' +
      'the schema changes, and the response carries `schemaHash` so you can tell whether a regeneration ' +
      'actually changed anything. Side-effect free.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['dts', 'client', 'openapi'],
          description:
            'dts = type declarations only (default). client = declarations plus a typed client for this ' +
            'project. openapi = OpenAPI 3.1 description of the REST endpoints.',
        },
      },
      additionalProperties: false,
    },
  })

  // check_intent_conformance — does the backend match what was ASKED for?
  // Every other read tool reports what EXISTS, which cannot reveal a column
  // built as the wrong type: `integer` looks healthy in the catalog whether or
  // not `timestamp` was requested. This compares the intent ledger against the
  // live catalog, so an agent can verify its own work instead of assuming a
  // successful call produced the intended shape.
  out.push({
    name: 'check_intent_conformance',
    tier: 'read',
    description:
      'Verify the backend matches what was REQUESTED, not merely that it exists. Compares every recorded ' +
      'column intent (type, nullability, foreign key) against the live PostgreSQL catalog and returns any ' +
      'drift: a column requested as `timestamp` that was built as `integer`, a column requested nullable ' +
      'that is NOT NULL, a requested foreign key that was never created. Call this after a build to confirm ' +
      'the schema is what you asked for — a successful create_table does NOT guarantee it. Side-effect free. ' +
      'Note `unverifiable`: columns with no recorded intent are unchecked, not proven healthy.',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: {
          type: 'string',
          description: 'Optional — limit the check to one table. Omit to check the whole project.',
        },
      },
      additionalProperties: false,
    },
  })

  // check_sensor_health — are the autonomy probes still able to detect anything?
  out.push({
    name: 'check_sensor_health',
    tier: 'read',
    description:
      'Report whether this project\'s autonomy probes can still detect problems. Distinguishes a probe that is ' +
      'verifiably clean from one that has NEVER produced a finding — whose silence proves nothing, because a ' +
      'broken probe and a healthy backend look identical. Also reports probes that errored, meaning the loop is ' +
      'blind to those invariants. Use this before trusting a green health report. Side-effect free.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })

  // check_approval — poll an escalated destructive request (see backend_chat).
  out.push({
    name: 'check_approval',
    tier: 'read',
    description:
      'Check the status of a destructive-operation approval request created by backend_chat. ' +
      'Returns pending | executed | partial | failed | rejected | expired plus a result summary once decided. ' +
      'Poll every 15-30s while pending; stop on any terminal status. Only the human can approve — ' +
      'from the Backenly dashboard Review Queue. ' +
      'The distinction that matters: `failed` means NOTHING was applied and the backend is unchanged, ' +
      'so it is safe to retry; `partial` means some changes DID land before the run stopped, so you must ' +
      'read resultSummary and verify current state rather than replaying the request.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The approval request id returned by backend_chat.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  })

  for (const t of BRAIN_TOOLS) {
    const fn = t.function
    if (!fn || !fn.name) continue
    const name = fn.name
    if (MCP_EXCLUDE.has(name)) continue
    if (isDestructiveTool(name)) continue
    const tier = tierOf(name)
    if (!tier) continue

    const params = (fn.parameters ?? {}) as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    out.push({
      name,
      tier,
      description: fn.description ?? '',
      inputSchema: {
        type: 'object',
        properties: params.properties ?? {},
        ...(params.required && params.required.length ? { required: params.required } : {}),
        additionalProperties: false,
      },
    })
  }

  out.push(
    // NOTE: run_query is NOT listed here. It is a real brain tool
    // (READ_ONLY_TOOLS), so the generated loop above already emits it from its
    // single definition in lib/ai/brain/tools.ts. Adding it here too would ship
    // two descriptions of one tool, free to drift apart — the exact failure this
    // catalog exists to prevent.
    {
      name: 'db_query',
      tier: 'data',
      description:
        'Read rows from a single workspace table by simple column = value filter. Returns whole rows. ' +
        'For joins, aggregates, GROUP BY, or any multi-table question use `run_query` instead — this tool cannot express them. ' +
        'Owner/admin maintenance tool: validates table and column shapes, but intentionally bypasses end-user RLS, triggers, and AI function side effects.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name (snake_case).' },
          filter: {
            type: 'object',
            description: 'Optional column=value filter, e.g. {"status":"published"}. Operators ($gt, $lt, $in, $contains) supported.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Row cap. Default 50.' },
          offset: { type: 'integer', minimum: 0, description: 'Offset for pagination.' },
          orderBy: { type: 'object', description: 'e.g. {"created_at":"desc"}.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'db_insert',
      tier: 'data',
      description:
        'Insert one row into a workspace table. Owner/admin maintenance tool: bypasses end-user RLS, triggers, and AI function side effects. ' +
        'Returns the created row including auto-generated id and timestamps.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          row: { type: 'object', description: 'Column → value pairs for the new row. Omit id/timestamps — they are auto-generated.' },
        },
        required: ['table', 'row'],
        additionalProperties: false,
      },
    },
    {
      name: 'db_update',
      tier: 'data',
      description:
        'Patch one or more rows in a workspace table. `filter` selects which rows to update; `patch` is the column → value diff. ' +
        'Owner/admin maintenance tool: bypasses end-user RLS, triggers, and AI function side effects. Returns the count of rows updated.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          filter: { type: 'object', description: 'WHERE clause as column=value pairs (must not be empty — global updates are refused).' },
          patch: { type: 'object', description: 'Columns to set on the matched rows.' },
        },
        required: ['table', 'filter', 'patch'],
        additionalProperties: false,
      },
    },
    {
      name: 'db_delete',
      tier: 'data',
      description:
        'Delete rows from a workspace table matching `filter`. `filter` is REQUIRED and non-empty — there is no "delete all rows" path here. ' +
        'Owner/admin maintenance tool: bypasses end-user RLS, triggers, and AI function side effects. For destructive table-wide operations use the dashboard.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          filter: { type: 'object', description: 'WHERE clause as column=value pairs. Must not be empty.' },
        },
        required: ['table', 'filter'],
        additionalProperties: false,
      },
    },
  )

  // ── branch — the staging door, one tool with four verbs ────────────────────
  // Routes to create_branch / list_branches / diff_branch / merge_branch via
  // BRANCH_ACTIONS, which the dispatcher reads from the same table this schema
  // advertises — so an action the manifest offers can never be one dispatch
  // cannot serve.
  out.push({
    name: 'branch',
    tier: 'build',
    description:
      'Work with preview branches: a clone of this project\'s SCHEMA in an isolated PostgreSQL schema, with its own ' +
      'row-security policies and its own sequences. Use one before any migration you are not certain about — build ' +
      'against the clone, diff it, then merge.\n' +
      'A branch starts EMPTY. It does not copy production rows unless you pass includeData:true, which protects your ' +
      'real data from whatever the experiment does to it. Seed what you need instead.\n' +
      'To run an app against a branch, issue a key bound to it: create_api_key with that branchId. The environment is ' +
      'a property of the KEY — no header switches it, and a key on a merged or discarded branch is refused rather ' +
      'than falling back to production.\n' +
      'Actions: "list" (existing branches + their ids) · "create" (needs `name`, lowercase kebab-case, max 5 active) · ' +
      '"diff" (needs `branchId` — exactly what would land) · "merge" (needs `branchId` — new tables apply through the ' +
      'governed kernel; added columns, type changes and drops come back as review items rather than reshaping a live ' +
      'column silently). Discarding a branch is destructive — ask via backend_chat and it goes to the Review Queue.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: Object.keys(BRANCH_ACTIONS),
          description: 'What to do. Start with "list" if you do not have a branchId.',
        },
        name: { type: 'string', description: 'For action:"create" — the branch name, e.g. "add-payments".' },
        branchId: { type: 'string', description: 'For action:"diff" / "merge" — the id from action:"list".' },
        includeData: {
          type: 'boolean',
          description:
            'For action:"create". Default false — the branch is schema-only. True copies every production row into ' +
            'it, which is occasionally useful for reproducing a data-shaped bug and is otherwise a liability.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  })

  // ── apply_migration — the SQL write door ───────────────────────────────────
  // Writes used to be reachable only as typed tools (create_table, add_column,
  // …), a vocabulary no model has ever seen. Agents sent DDL to `run_query`
  // instead and got NOT_READ_ONLY — the single largest error class on the live
  // key. This accepts the grammar the model already knows and translates it into
  // those same typed actions, so the governance kernel is unchanged and only the
  // ergonomics move. See lib/mcp/migration-parser.ts.
  out.push({
    name: 'apply_migration',
    tier: 'build',
    description:
      'Apply a schema migration written as ordinary PostgreSQL DDL. Supports CREATE TABLE, ' +
      'ALTER TABLE (ADD COLUMN / RENAME COLUMN / ALTER COLUMN SET NOT NULL / ADD CONSTRAINT) and CREATE INDEX; ' +
      'multiple statements in one call are applied in order. Write bare table names — your project schema is ' +
      'already in scope. `id`, `created_at` and `updated_at` are provisioned automatically; declaring them is ' +
      'harmless and they are skipped. Each statement is translated into a governed action, so the change stays ' +
      'planned, verified and reversible — this is NOT raw SQL execution. Anything it cannot govern is refused ' +
      'with the exact tool to use instead, and a migration is all-or-nothing: if one statement is unsupported, ' +
      'none are applied. For row changes use db_insert/db_update/db_delete; for reads use run_query; for drops ' +
      'and anything else use backend_chat.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'One or more DDL statements, semicolon-separated. e.g. ' +
            '"CREATE TABLE posts (title text NOT NULL, author_id uuid REFERENCES users(id)); CREATE INDEX ON posts (author_id);"',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  })

  // ── read_backend_state — one read door, replacing ~20 ───────────────────────
  // list_tables / list_apis / list_buckets / list_files / list_api_keys /
  // list_end_users / list_permissions / list_triggers / list_ai_functions /
  // list_cron_jobs / list_integration_keys / list_connected_apps / list_env_vars
  // / list_webhook_deliveries / list_findings / get_pending_incidents /
  // get_metrics / get_errors / get_usage / get_deploy_status / get_readiness /
  // get_autonomy_status / get_realtime_status / get_project_overview /
  // get_backend_metadata / get_instructions were 26 separate tools that all
  // answered "what is currently true?".
  //
  // Collapsing them into one tool with a `section` enum is not cosmetic. Picking
  // a STRING from an enum inside a chosen tool is a far easier decision for a
  // model than picking between 26 similarly-named tools, and it costs a fraction
  // of the context. The underlying tools are unchanged and still dispatchable.
  const stateIndex = out.findIndex((t) => t.name === 'read_backend_state')
  const stateDescriptor: McpToolDescriptor = {
    name: 'read_backend_state',
    tier: 'read',
    description:
      'Read what is currently true about this backend. Call with no arguments for the grounding overview ' +
      '(tables, APIs, auth, storage, RLS) — do this FIRST on any non-trivial task. Pass `section` to drill into ' +
      'one area. This is the single read-state tool: there is no list_tables/list_apis/etc. to choose between. ' +
      'For anything expressible as a query over your own data, use run_query instead. Side-effect free.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: Object.keys(STATE_SECTIONS),
          description:
            'Which slice of state to read. Omit for the overview. ' +
            '"schema" is the full table/column/FK map; "instructions" is the recommended agent workflow.',
        },
      },
      additionalProperties: false,
    },
  }
  if (stateIndex === -1) out.push(stateDescriptor)
  else out[stateIndex] = stateDescriptor

  return out
}

/**
 * `section` → the brain tool that answers it.
 *
 * Exported so the dispatcher routes from the same table the schema advertises;
 * a section the manifest offers but dispatch cannot serve would be a blind
 * error of exactly the kind this redesign exists to remove.
 */
/**
 * `branch { action }` → the brain tool that performs it.
 *
 * Exported for the same reason as STATE_SECTIONS: the dispatcher routes from
 * the table the manifest advertises, so the two cannot drift. `discard` is
 * absent on purpose — it is destructive and belongs on the approval path.
 */
export const BRANCH_ACTIONS: Record<string, string> = {
  list: 'list_branches',
  create: 'create_branch',
  diff: 'diff_branch',
  merge: 'merge_branch',
}

export const STATE_SECTIONS: Record<string, string> = {
  schema: 'get_backend_metadata',
  instructions: 'get_instructions',
  tables: 'list_tables',
  apis: 'list_apis',
  buckets: 'list_buckets',
  files: 'list_files',
  keys: 'list_api_keys',
  users: 'list_end_users',
  rls: 'list_permissions',
  triggers: 'list_triggers',
  functions: 'list_ai_functions',
  cron: 'list_cron_jobs',
  integrations: 'list_integration_keys',
  apps: 'list_connected_apps',
  env: 'list_env_vars',
  webhooks: 'list_webhook_deliveries',
  findings: 'list_findings',
  incidents: 'get_pending_incidents',
  metrics: 'get_metrics',
  errors: 'get_errors',
  usage: 'get_usage',
  deploy: 'get_deploy_status',
  readiness: 'get_readiness',
  autonomy: 'get_autonomy_status',
  realtime: 'get_realtime_status',
}

/**
 * Dispatch-time lookup. Built from the DISPATCHABLE set, not the advertised
 * catalog, so an older client calling an unlisted tool still executes.
 */
export function catalogByName(): Map<string, McpToolDescriptor> {
  const m = new Map<string, McpToolDescriptor>()
  for (const t of buildDispatchable()) m.set(t.name, t)
  return m
}

/** True when a tool is advertised, as opposed to merely still callable. */
export function isAdvertised(name: string): boolean {
  return MCP_SURFACE.has(name)
}
