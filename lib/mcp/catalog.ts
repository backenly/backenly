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
import { DOMAIN_TOOLS, domainDescription, domainInputSchema, getDomainTool, readOnlyView } from '@/lib/mcp/domains'
import { AGENT_DOC_TOPICS, docsPointer } from '@/lib/mcp/agent-docs'

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
  /** MCP tool annotations, derived once in `annotationsFor`. */
  annotations?: McpToolAnnotations
}

/**
 * The MCP `ToolAnnotations` a host reads to tell a read from a write before it
 * calls anything: whether to ask the user first, whether a retry is safe,
 * whether the tool reaches outside this project.
 *
 * Both transports serve these from here, so the stdio package and the remote
 * endpoint can never describe the same tool differently.
 */
export interface McpToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/**
 * Writes that can remove or overwrite existing rows with no approval step in
 * between. Everything else that mutates is additive, or reaches anything
 * irreversible only through the human Review Queue (destructive brain tools are
 * never dispatchable here at all).
 */
// `branch` too, for its discard action: it drops the branch's rows.
const OVERWRITES_DATA = new Set(['db_update', 'db_delete', 'branch', 'discard_branch'])

/** Writes that leave the same end state however many times they run. */
const IDEMPOTENT_WRITES = new Set(['set_rls', 'set_env_var'])

/** Titles where the name alone would read badly as a label. */
const TITLES: Record<string, string> = {
  backend_chat: 'Ask Backenly to build or change the backend',
  run_query: 'Run a read-only SQL query',
  get_table_schema: "Get a table's schema",
  db_query: 'Read rows',
  db_insert: 'Insert a row',
  db_update: 'Update rows',
  db_delete: 'Delete rows',
  set_rls: 'Set row-level security',
  set_env_var: 'Set an environment variable',
  get_database_credentials: 'Get Postgres connection credentials',
  generate_types: 'Generate TypeScript types',
  branch: 'Preview branches',
}

/**
 * Tools that reach a system outside this project: storing a provider key asks
 * the provider whether it works, send_push delivers through OneSignal, and
 * backend_chat can do either on the agent's behalf. Everything else acts on
 * this project's own database and config.
 */
const OPEN_WORLD = new Set(['backend_chat', 'store_integration_key', 'send_push'])

export function annotationsFor(name: string): McpToolAnnotations {
  // A domain tool never performs a destructive update itself: its destructive
  // and high-risk actions park the exact call for a human (lib/mcp/domains.ts).
  // One whose every action only reads is a read (isReadOnlyTool).
  const domain = getDomainTool(name)
  if (domain) {
    const readOnly = isReadOnlyTool(name)
    return {
      title: domain.title,
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: !!domain.openWorld,
    }
  }
  const readOnly = isReadOnlyTool(name)
  const words = name.replace(/_/g, ' ')
  return {
    title: TITLES[name] ?? words.charAt(0).toUpperCase() + words.slice(1),
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && OVERWRITES_DATA.has(name),
    idempotentHint: readOnly || IDEMPOTENT_WRITES.has(name),
    openWorldHint: OPEN_WORLD.has(name),
  }
}

/**
 * Brain tools we deliberately do NOT expose to MCP, beyond the destructive
 * set. These are control-loop tools that only make sense inside `runBrain`:
 *   - propose_plan / ask_user / answer_question / finish — terminal control,
 *     meaningful only when the LLM is steering the agent loop. From an MCP
 *     host's perspective, the host is doing the steering.
 *   - run_test — an internal verifier hook. The host LLM can call
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
  'fix_backend',
  'apply_proposal',
  // Credential-gated tools — call backend_chat instead so brain can ask user.
  'add_oauth_provider',
  'enable_push_notifications',
])

/** Build tools (non-destructive mutations) — assigned to tier 'build'. */
const BUILD_TOOLS = new Set<string>([
  'create_branch', 'connect_branch', 'merge_branch', 'discard_branch',
  'create_table', 'add_column', 'create_index', 'rename_column', 'add_constraint',
  // (list_branches / diff_branch are read tools; all six are reachable through
  // the single advertised `branch` tool — see BRANCH_ACTIONS.)
  'generate_api', 'enable_auth', 'create_bucket', 'set_bucket_public', 'set_bucket_policy', 'add_rls', 'set_rls',
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
 * What tools/list says for the advertised tools defined in lib/ai/brain/tools.ts.
 *
 * Their schema stays the brain's, so the arguments an agent may pass are the
 * ones dispatch runs. Their text does not: the brain's own model reads the long
 * form there, while tools/list is sent to every session before the user types
 * anything (production QA 2026-11-09, report 99). This keeps what an agent needs
 * to call the tool correctly, its refusals and where else to go, and names the
 * docs topic with the rest.
 */
const MCP_TEXT: Record<string, { description: string; args: Record<string, string> }> = {
  run_query: {
    description:
      'Read-only SQL on this project\'s tables: SELECT with joins, GROUP BY, aggregates, window functions, CTEs, ' +
      'EXPLAIN. Bare table names (SELECT * FROM posts), one statement per call. The system catalogs (pg_*, ' +
      'information_schema) are refused: use get_table_schema. Writes: apply_migration for schema, db_insert / ' +
      `db_update / db_delete for rows. ${docsPointer('database')}`,
    args: {
      sql: 'One read-only SQL statement.',
    },
  },
  get_table_schema: {
    description:
      'One table from the live catalog: columns, keys, foreign keys, indexes, CHECK constraints with their allowed ' +
      'values, triggers, and RLS policies with their roles. Read it before writing to a table. To edit a policy with ' +
      'set_rls, send back its editableUsing / editableCheck (raw using / withCheck are refused). A USING (true) policy ' +
      `for an internal role only is not open access. Side-effect free. ${docsPointer('database')}`,
    args: { tableName: 'The table.' },
  },
  set_rls: {
    description:
      'Row-level security as exact SQL, one rule per command: predicates are installed verbatim and read back from ' +
      'pg_policies, with no model involved. Use it instead of backend_chat whenever you can write the predicate. ' +
      'Commands you do not name stay as they are; naming a subset while a FOR ALL policy exists is refused. A ' +
      'predicate may use this table\'s columns, backenly_jwt_claim(\'sub\') (the end-user\'s id), comparisons, ' +
      'AND/OR/NOT, IN, IS NULL, casts and pure functions, and reach a parent row only via EXISTS (SELECT 1 FROM parent ' +
      'p WHERE p.id = this_table.parent_id AND …). USING: rows a command may target; CHECK: rows it may produce. Give ' +
      `CHECK whenever writing is narrower than reading. ${docsPointer('database')}`,
    args: {
      tableName: 'The table.',
      select: 'SELECT rule: { using }.',
      insert: 'INSERT rule: { check }.',
      update:
        'UPDATE rule: { using, check }. Give both when they differ: using alone lets a caller target a row and ' +
        'rewrite its owner column to themselves.',
      delete: 'DELETE rule: { using }.',
      role: 'Default authenticated.',
    },
  },
}

/** `properties` with each argument's text replaced where `args` has one. */
function withArgText(properties: Record<string, unknown>, args: Record<string, string> | undefined): Record<string, unknown> {
  if (!args) return properties
  return Object.fromEntries(Object.entries(properties).map(([k, schema]) =>
    [k, k in args ? { ...(schema as object), description: args[k] } : schema]))
}

/** A preview branch argument, as the row tools and apply_migration take it. */
const BRANCH_ID_ARG = { type: 'string', description: 'A preview branch id: act on it, not production.' }

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
/**
 * The most tools the manifest may advertise. Asserted by test: raising it is a
 * decision about every agent's selection accuracy, not a side effect.
 */
export const ADVERTISED_CAP = 23

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
  // `discard` drops the branch's schema and ends its keys, and runs at once:
  // it removes a scratch copy, never anything of production's, as Supabase's
  // and Neon's delete_branch do. Production QA (2026-11-09) watched an agent
  // pay AI credits and wait on a person to tidy up its own experiments.
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
  // ── One door per dashboard section (lib/mcp/domains.ts) ────────────────────
  //
  // These replaced the single-purpose capability tools (enable_auth,
  // create_bucket, generate_function, enable_realtime, create_api_key,
  // set_env_var, get_database_credentials), each of which covered one button of
  // its section and left the rest behind backend_chat. Each is now one tool with
  // an `action` enum, routed to the same brain tools; the old names stay
  // dispatchable for pinned clients. Destructive and high-risk actions park the
  // exact call for a human instead of running.
  'auth',
  'storage',
  'functions',
  'realtime',
  'integrations',
  'monitoring',
  'autonomy',
  'webhooks',
  'deploy',
  'connect',
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
  //
  // ── Deploying and deleting a function: through their domain tools ─────────
  //
  // Both were reported missing from a real build ("Project stuck not_deployed
  // with no MCP tool to deploy", "No way to delete a function via MCP"). The
  // answer then was a sign pointing at backend_chat, because trigger_deploy and
  // delete_ai_function are destructive and never dispatch directly. They are
  // now `deploy {action:"deploy"}` and `functions {action:"delete"}`, which park
  // the exact call for a human and run it verbatim once approved. The agent can
  // request them deterministically; it still cannot do them unilaterally.
  //
  // ── Deliberately absent: adopt_external_schema ────────────────────────────
  //
  // The slot paid for `set_rls` when this allowlist was capped at 20. The cap is
  // now ADVERTISED_CAP (the domain tools cost three net slots), and it is still
  // the point: every addition has to displace something rather than quietly
  // cost every other call its accuracy.
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
  // A read-only key keeps each section's door, narrowed to its read actions:
  // enum, description and schema are rebuilt from those alone, so no write
  // action is ever shown. Everything else is served only if it is a read.
  return advertised.flatMap((t) => {
    if (isReadOnlyTool(t.name)) return [t]
    const domain = getDomainTool(t.name)
    const view = domain ? readOnlyView(domain) : null
    if (!view) return []
    return [{
      ...t,
      description: domainDescription(view),
      inputSchema: domainInputSchema(view, { readOnly: true }),
      annotations: {
        ...annotationsFor(t.name),
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }]
  })
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

/**
 * True when `name` may be served to a read-only key. A domain tool is when
 * every action behind it only reads: a read-only key may call each of them
 * (the route judges the action's own tool), so the whole tool is a read.
 * `monitoring` was advertised to hosts as writing (production QA, 2026-11-09).
 */
export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY_TOOLS.has(name as any) || READ_ONLY_SYNTHETIC.has(name)) return true
  const domain = getDomainTool(name)
  return !!domain && Object.values(domain.actions).every((a) => READ_ONLY_TOOLS.has(a.tool as any))
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
      'Describe a change in plain words and Backenly\'s own model plans and applies it through the same governed ' +
      'tools; it draws AI credits. For a whole schema, apply_migration is faster and exact. A destructive step is ' +
      'NOT executed: the answer carries an `approval` id for check_approval. Whenever an answer carries `next`, make ' +
      `that call. ${docsPointer('autonomy')}`,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The request: name the tables, columns and relations.',
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
      'Backenly\'s docs as Markdown, so you use the right tools and endpoints without guessing. No arguments: the ' +
      'index; `topic`: one area in full.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          // Not an enum: older clients send the section names the single-file
          // guide had ("mcp", …), which resolve through lib/mcp/agent-docs.ts.
          description: `One of: ${AGENT_DOC_TOPICS.map((t) => t.id).join(', ')}.`,
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
      'TypeScript types for every table, from the live catalog: Database, Row<T>, Insert<T>, Update<T>, ' +
      'TableName. Use them instead of hand-written row types. Side-effect free. ' +
      docsPointer('database'),
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['dts', 'client', 'openapi'],
          description: 'Default dts; client adds a typed client; openapi is an OpenAPI 3.1 spec.',
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
      'Status of a call parked for a person (approval id) or of a backend_chat run (run id): pending, approved, ' +
      'executed, failed, rejected or expired. Poll every 15-30s while pending; only a person approves. failed (or ' +
      'an older partial) may have changed something: read resultSummary and the state before asking again. ' +
      docsPointer('autonomy'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'An approval id or a backend_chat run id.' },
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
    const text = MCP_TEXT[name]
    out.push({
      name,
      tier,
      description: text?.description ?? fn.description ?? '',
      inputSchema: {
        type: 'object',
        properties: withArgText(params.properties ?? {}, text?.args),
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
        'Read whole rows from one table by a column = value filter; for joins, aggregates or GROUP BY use `run_query`. ' +
        'The db_* tools act as the owner: they check table and column shapes but bypass end-user RLS and app ' +
        'triggers. Row-event functions and row webhooks still fire, since they are captured inside PostgreSQL.',
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
          branchId: { type: 'string', description: 'A preview branch id (branch action:"list"): use that branch instead of production.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    // The three row writes are advertised and db_query is not, so each says
    // what "as the owner" means itself instead of pointing at db_query.
    {
      name: 'db_insert',
      tier: 'data',
      description:
        'Insert one row as the project owner, for seeding and repair: end-user RLS does not apply; row-event ' +
        `functions and row webhooks still fire. Returns the row. ${docsPointer('database')}`,
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The table.' },
          row: { type: 'object', description: 'Column → value pairs; omit id and timestamps.' },
          branchId: { ...BRANCH_ID_ARG },
        },
        required: ['table', 'row'],
        additionalProperties: false,
      },
    },
    {
      name: 'db_update',
      tier: 'data',
      description:
        'Set `patch` on the rows `filter` matches, as the project owner (no end-user RLS; row-event functions and ' +
        `row webhooks fire). An empty filter is refused. ${docsPointer('database')}`,
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The table.' },
          filter: { type: 'object', description: 'Column = value pairs. Must not be empty.' },
          patch: { type: 'object', description: 'Columns to set.' },
          branchId: { ...BRANCH_ID_ARG },
        },
        required: ['table', 'filter', 'patch'],
        additionalProperties: false,
      },
    },
    {
      name: 'db_delete',
      tier: 'data',
      description:
        'Delete the rows `filter` matches, as the project owner (no end-user RLS; row-event functions and row ' +
        `webhooks fire). An empty filter is refused: there is no delete-all. ${docsPointer('database')}`,
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The table.' },
          filter: { type: 'object', description: 'Column = value pairs. Must not be empty.' },
          branchId: { ...BRANCH_ID_ARG },
        },
        required: ['table', 'filter'],
        additionalProperties: false,
      },
    },
  )

  // ── branch — the staging door, one tool with five verbs ────────────────────
  // Routes to create_branch / connect_branch / list_branches / diff_branch /
  // merge_branch via
  // BRANCH_ACTIONS, which the dispatcher reads from the same table this schema
  // advertises — so an action the manifest offers can never be one dispatch
  // cannot serve.
  out.push({
    name: 'branch',
    tier: 'build',
    description:
      'Preview branches: a copy of this project\'s schema to build and test a change on while production keeps ' +
      'serving. It starts EMPTY unless includeData. Change it with apply_migration { sql, branchId }. ' +
      `${docsPointer('branches')}\n` +
      'Required arguments in parentheses:\n' +
      '- create (name): kebab-case; at most 5 active\n' +
      '- connect (branchId): a preview key\n' +
      '- diff (branchId): what a merge would replay\n' +
      '- merge (branchId): replays its migrations onto production; refused while production changed a table they ' +
      'touch [waits for approval]\n' +
      '- discard (branchId): drops the branch, its rows and keys at once; no approval, no undo',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: Object.keys(BRANCH_ACTIONS),
          description: 'Start with "list" for ids.',
        },
        name: { type: 'string', description: 'For create, e.g. "add-payments".' },
        branchId: { type: 'string', description: 'From list.' },
        includeData: { type: 'boolean', description: 'For create: also copy every production row.' },
        serviceRole: {
          type: 'boolean',
          description: 'For connect: a server-side key that bypasses RLS on the branch.',
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
    // Not "all or nothing": every statement is checked before any runs, but one
    // that fails while running stops the migration with `applied` and
    // `remaining` (lib/mcp/apply-migration.ts), as the docs say.
    description:
      'Schema changes as PostgreSQL DDL: CREATE TABLE; ALTER TABLE (ADD / DROP / RENAME COLUMN, ALTER COLUMN … TYPE ' +
      '[USING], SET|DROP NOT NULL, SET|DROP DEFAULT, ADD / DROP CONSTRAINT); CREATE [UNIQUE] INDEX; DROP INDEX. Bare ' +
      'table names. Anything else is refused with the tool to use. All statements are checked before any runs; one ' +
      'that fails while running stops it, and the answer lists `applied` (in effect: do not replay) and `remaining`. ' +
      'Every table gets id, "createdAt", "updatedAt" and "deleted_at"; a declared id, created_at or updated_at ' +
      'gives way to them. On production, dropping a column, a constraint or a unique index, or changing a type, waits ' +
      'for a person (status "awaiting_approval"; poll check_approval). With branchId it changes that preview branch ' +
      'only; protected production refuses a migration without one (BRANCH_REQUIRED). Rows: db_insert / db_update / ' +
      `db_delete; dropping a table: backend_chat. ${docsPointer('database')}`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One or more DDL statements, separated by semicolons.' },
        branchId: { ...BRANCH_ID_ARG },
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
  // ── Domain tools — one door per dashboard section (lib/mcp/domains.ts) ─────
  // Description and schema are generated from the brain tools each action
  // routes to, so the advertised arguments can never drift from what runs.
  for (const domain of DOMAIN_TOOLS) {
    out.push({
      name: domain.name,
      tier: 'build',
      description: domainDescription(domain),
      inputSchema: domainInputSchema(domain),
    })
  }

  const stateIndex = out.findIndex((t) => t.name === 'read_backend_state')
  const stateDescriptor: McpToolDescriptor = {
    name: 'read_backend_state',
    tier: 'read',
    description:
      'What is currently true about this backend. No arguments: the overview (tables, APIs, auth, storage, RLS); ' +
      `read it FIRST on any non-trivial task. \`section\`: one area in full. Side-effect free. ${docsPointer('database')}`,
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: Object.keys(STATE_SECTIONS),
          description: 'Omit for the overview; "schema" maps every table, column and foreign key.',
        },
        branchId: { type: 'string', description: 'With section "schema": that preview branch.' },
      },
      additionalProperties: false,
    },
  }
  if (stateIndex === -1) out.push(stateDescriptor)
  else out[stateIndex] = stateDescriptor

  return out.map((t) => ({ ...t, annotations: annotationsFor(t.name) }))
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
 * the table the manifest advertises, so the two cannot drift. `merge` waits
 * for a person (it changes production); `discard` does not (it drops only the
 * branch).
 */
export const BRANCH_ACTIONS: Record<string, string> = {
  list: 'list_branches',
  create: 'create_branch',
  connect: 'connect_branch',
  diff: 'diff_branch',
  merge: 'merge_branch',
  discard: 'discard_branch',
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
  // The Webhooks PAGE: configured endpoints, their health. This once pointed
  // at list_webhook_deliveries — the AppTrigger delivery log, which is empty
  // unless legacy /database/* routes fired — so an agent grounding itself on a
  // project with three live webhook endpoints was told there were none.
  webhooks: 'list_webhooks',
  deliveries: 'list_webhook_deliveries',
  findings: 'list_findings',
  incidents: 'get_pending_incidents',
  metrics: 'get_metrics',
  errors: 'get_errors',
  usage: 'get_usage',
  deploy: 'get_deploy_status',
  readiness: 'get_readiness',
  autonomy: 'get_autonomy_status',
  // Read-only. Granting consent for a schema-rewriting ladder stays with a
  // person: an agent that could approve its own work defeats the tier system.
  maintenance: 'get_maintenance_ladder',
  // Read-only, for the maintenance ladder's reason: an architecture change
  // restructures production tables, and its consent belongs to a person.
  evolution: 'get_evolution_proposals',
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
