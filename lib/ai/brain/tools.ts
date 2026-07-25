/**
 * BRAIN TOOLS
 * ===========
 * The typed tool surface the new brain calls. Replaces lib/ai/agent/agent-tools.ts.
 *
 * Design rules:
 *   - Every mutation tool is a thin wrapper over the existing `executeAction`
 *     (the 80-action executor in lib/ai/minimal-executor.ts). We REUSE it.
 *   - New control tools (propose_plan, ask_user, answer_question, run_test,
 *     rollback) live here and orchestrate brain-level concerns.
 *   - Tools return a compact JSON-safe summary the model can reason over.
 *   - Destructive tools are flagged so the agent loop can gate them.
 */

import type { OpenAI } from 'openai'
import { executeAction } from '../minimal-executor'
import type { AIAction } from '../minimal-executor'
import { collectProof, formatProof } from '../proof-system'
import { getOpenAIClient, trackCompletionCost } from '../openai-service'
import { getModel } from '../model-router'
import { answererPrompt } from './prompts'
import { kickReconciler, shouldKickFor } from '@/lib/autonomy/event-trigger'

export type ToolName =
  // Read (live state)
  | 'read_backend_state'
  | 'get_instructions'
  | 'get_backend_metadata'
  | 'get_project_overview'
  | 'get_table_schema'
  | 'run_query'
  | 'list_tables'
  | 'list_apis'
  | 'list_buckets'
  | 'list_files'
  | 'generate_signed_url'
  | 'list_api_keys'
  | 'list_end_users'
  | 'list_permissions'
  | 'list_triggers'
  | 'list_ai_functions'
  | 'list_cron_jobs'
  | 'list_branches'
  | 'diff_branch'
  | 'create_branch'
  | 'merge_branch'
  | 'discard_branch'
  | 'list_integration_keys'
  | 'list_connected_apps'
  | 'get_deploy_status'
  | 'get_readiness'
  | 'list_env_vars'
  | 'get_metrics'
  | 'get_errors'
  | 'get_usage'
  | 'get_autonomy_status'
  | 'get_realtime_status'
  // Build
  | 'create_table'
  | 'add_column'
  | 'create_index'
  | 'rename_column'
  | 'add_constraint'
  | 'generate_api'
  | 'enable_auth'
  | 'add_oauth_provider'
  | 'disable_oauth_provider'
  | 'create_bucket'
  | 'set_bucket_public'
  | 'add_rls'
  | 'create_trigger'
  | 'enable_realtime'
  | 'generate_function'
  | 'enable_vector_search'
  | 'create_cron_job'
  | 'set_rate_limit'
  | 'generate_aggregate_api'
  | 'run_data_migration'
  | 'enable_teams'
  | 'enable_push_notifications'
  | 'send_push'
  | 'rotate_webhook_secret'
  | 'list_webhook_deliveries'
  | 'replay_webhook_delivery'
  // Connect Frontend
  | 'connect_frontend'
  | 'disconnect_frontend'
  // Publish / Deploy
  | 'trigger_deploy'
  | 'rollback_deploy'
  | 'set_env_var'
  | 'delete_env_var'
  // Auth lifecycle
  | 'reset_end_user_password'
  | 'block_end_user'
  | 'unblock_end_user'
  | 'remove_permission'
  // IAM (platform API keys)
  | 'create_api_key'
  | 'revoke_api_key'
  | 'rotate_api_key'
  | 'set_key_permissions'
  // Integrations
  | 'store_integration_key'
  | 'remove_integration_key'
  | 'delete_trigger'
  // Functions lifecycle
  | 'toggle_ai_function'
  | 'delete_ai_function'
  | 'delete_cron_job'
  // Monitoring
  | 'set_alert'
  // Autonomy
  | 'set_autonomy_level'
  // Agent-native operator surface (open loop / 24-7 brain)
  | 'get_pending_incidents'
  | 'get_database_credentials'
  | 'adopt_external_schema'
  // Repair / proposal
  | 'fix_backend'
  | 'apply_proposal'
  | 'list_findings'
  | 'resolve_finding'
  // Destructive
  | 'drop_table'
  | 'truncate_table'
  | 'drop_column'
  | 'disable_realtime'
  | 'delete_bucket'
  | 'delete_file'
  // Control / brain
  | 'propose_plan'
  | 'ask_user'
  | 'answer_question'
  | 'run_test'
  | 'rollback'
  | 'finish'

/**
 * Tools whose effect is data loss, breaks live consumers, or reverts production.
 * The agent loop refuses to call these without `destructiveConfirmed=true` on
 * the BrainInput (which is set from a "yes / confirm / drop / revoke" message).
 * The executor also has its own approval-gate as defence-in-depth.
 */
const DESTRUCTIVE_TOOLS = new Set<ToolName>([
  // Data loss
  'drop_table',
  'truncate_table',
  'drop_column',
  'delete_bucket',
  'delete_file',
  // NOTE: run_data_migration is NOT here — dry-runs must flow freely, and the
  // executor's RUN_DATA_MIGRATION handler has its own confirmation gate that
  // shows affected-row counts before a real run (destructiveConfirmed still
  // forwards as params.confirmed so an explicit "confirm" applies it).
  // Breaks live SSE subscribers
  'disable_realtime',
  // Ships to / reverts production (engine also has its own "Type DEPLOY /
  // ROLLBACK" prompt — brain DESTRUCTIVE gate is the first-line check).
  'trigger_deploy',
  'rollback_deploy',
  // Breaks live API consumers
  'revoke_api_key',
  'rotate_api_key',
  // Breaks AI functions that consume the secret
  'delete_env_var',
  // Breaks integrations / scheduled work
  'delete_trigger',
  'delete_ai_function',
  'delete_cron_job',
  'remove_integration_key',
  // DROP SCHEMA CASCADE on the branch — every experiment in it is gone.
  'discard_branch',
  // Affects end-users / data exposure
  'block_end_user',
  'remove_permission',
  // Breaks live sign-in flow for end-users using this provider
  'disable_oauth_provider',
])

/**
 * Tools that do NOT mutate state. Used by the agent loop to decide whether the
 * turn needs a post-mutation verification pass. Everything not in this set OR
 * the control-tool list is treated as a mutation.
 */
export const READ_ONLY_TOOLS = new Set<ToolName>([
  'read_backend_state',
  'run_query',
  'get_instructions',
  'get_backend_metadata',
  'get_project_overview',
  'get_table_schema',
  'list_tables',
  'list_apis',
  'list_buckets',
  'list_files',
  'generate_signed_url',
  'list_api_keys',
  'list_end_users',
  'list_permissions',
  'list_triggers',
  'list_ai_functions',
  'list_cron_jobs',
  'list_branches',
  'diff_branch',
  'list_integration_keys',
  'list_connected_apps',
  'list_webhook_deliveries',
  'get_deploy_status',
  'get_readiness',
  'list_env_vars',
  'get_metrics',
  'get_errors',
  'get_usage',
  'get_autonomy_status',
  'get_realtime_status',
  'list_findings',
  'get_pending_incidents',
])

export function isDestructiveTool(name: string): boolean {
  return DESTRUCTIVE_TOOLS.has(name as ToolName)
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name as ToolName)
}

export interface ToolDispatchContext {
  projectId: string
  /** Owner of the project — required for autonomy + audit-log writes. */
  userId?: string
  sessionToken?: string
  /** The user's most recent message — needed for answer_question. */
  userMessage?: string
  /** Pre-formatted project understanding block (from memory.formatUnderstanding). */
  understandingBlock?: string
  /**
   * True when the user's message in this turn explicitly authorised a destructive
   * action ("yes drop it", "confirm revoke"). Forwarded to the executor as
   * `params.confirmed=true` so its approval gate doesn't double-prompt.
   */
  destructiveConfirmed?: boolean
  /**
   * True for the direct /api/mcp/tool surface, where an owner-held MCP key is
   * operating the backend programmatically and destructive tools are already
   * refused upstream (isDestructiveTool → 403). Forwards `confirmed:true` for the
   * remaining NON-destructive medium-risk build actions (set_env_var,
   * connect_frontend, …) so they execute instead of dead-ending on an opaque
   * APPROVAL_REQUIRED with no path forward. Does NOT apply to backend_chat, which
   * keeps parking destructive ops in the human Review Queue.
   */
  mcpOwnerConfirmed?: boolean
  /**
   * In-turn ledger of tables this turn has CREATED. Used to block the LLM
   * from calling fix_backend(target='table', tableName=X) immediately after
   * create_table(X) succeeded — that was the "Repairing table" loop where
   * the model misread a 42501 RLS test failure as a real schema break and
   * tried to "repair" tables it had just built.
   */
  createdThisTurn?: Set<string>
  onToolEvent?: (e: {
    phase: 'start' | 'done' | 'fail'
    tool: ToolName
    title: string
    detail?: string
  }) => void
}

export interface ToolResult {
  ok: boolean
  summary: string
  data?: unknown
  /** Stops the loop when true (finish, ask_user, propose_plan). */
  terminal?: boolean
  /** When set, the brain signals needsUser at termination. */
  needsUser?: boolean
  /**
   * Machine-readable failure code for MCP agents to branch on (agent-native
   * ergonomics — an agent shouldn't have to regex the summary). Stable slugs,
   * e.g. WRITE_ACCESS_NOT_ARMED. Only meaningful when ok=false.
   */
  code?: string
}

// ── OpenAI tool schema ────────────────────────────────────────────────────────

export const BRAIN_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  fn('read_backend_state',
    'Read the live backend state: tables, REST APIs, auth status, storage buckets, RLS policies, integrations. Call this FIRST to ground every decision in reality. Side-effect free.',
    {}),
  fn('get_instructions',
    'Read this FIRST when you connect. Returns the recommended workflow for operating this Backenly backend as an agent: the order to call tools in, how RLS + the X-User-Token contract work, how to seed/read data, how destructive operations are gated behind human approval, and the runtime API shape for the app you build. Grounds you so you stop guessing. Side-effect free.',
    {}),
  fn('get_backend_metadata',
    'Structured, one-call map of the ENTIRE backend: every table with its exact record count, column count, whether RLS is enabled, and policy count; every foreign-key relationship (from → to); plus auth, storage, realtime, and function state. Call this FIRST on any non-trivial task so you can reason about schemas and relationships without guessing. Record counts let you spot one-to-many joins (avoid COUNT(*) row multiplication). Side-effect free.',
    {}),
  fn('get_project_overview',
    'Alias of get_backend_metadata — a complete structured overview of the project backend (tables + counts + relationships + auth/storage/realtime/functions). Use to confirm the connection and ground your plan. Side-effect free.',
    {}),
  fn('get_table_schema',
    'Complete, RLS-aware schema for ONE table: every column (type, nullable, default, primary key, max length), the primary key, foreign keys (with ON DELETE), indexes (with UNIQUE and the full column tuple), CHECK constraints (with the ACTUAL allowed values so you never violate them), triggers, whether RLS/FORCE-RLS is on, the live row-level-security policies (command, ROLES the policy applies to, PERMISSIVE/RESTRICTIVE, USING + WITH CHECK), and the exact record count. The policy roles matter: a `USING (true)` policy is not open access if it is granted only to an internal role, so read `roles` before concluding a table is exposed. Call this before writing any query, insert, or migration against a table. Reads the live PostgreSQL catalog — never stale. Side-effect free.',
    { tableName: { type: 'string', description: 'The table to describe (snake_case).' } },
    ['tableName']),
  fn('create_table',
    'Create a new database table with columns. Columns: {name, type (text|int|bigint|boolean|timestamp|uuid|jsonb|numeric, or an array of any of them such as text[]), nullable?, unique?, fkTo? (other table name), default?}. `id`, `createdAt` and `updatedAt` are provisioned automatically — do not declare them. CHECK constraints are not part of this contract: create the table, then add them with add_constraint (or send the whole thing as SQL to apply_migration, which does both). RLS is applied automatically from the schema and the chosen policy is reported in the result — read it, because a two-party table gets `participants` rather than owner-only access.',
    {
      tableName: { type: 'string' },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            nullable: { type: 'boolean' },
            unique: { type: 'boolean' },
            fkTo: { type: 'string' },
          },
          required: ['name', 'type'],
        },
      },
    },
    ['tableName', 'columns']),
  fn('add_column',
    'Add a column to an existing table.',
    {
      tableName: { type: 'string' },
      column: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          nullable: { type: 'boolean' },
          default: { type: 'string' },
        },
        required: ['name', 'type'],
      },
    },
    ['tableName', 'column']),
  fn('create_index',
    'Create an index on one or more columns for query performance, or a UNIQUE index to enforce ' +
    'uniqueness across a combination of columns (which is how PostgreSQL implements a composite ' +
    'UNIQUE constraint). Every field below is honoured exactly as given — a multi-column `columns` ' +
    'array creates one composite index, not several single-column ones, and `unique: true` is ' +
    'never downgraded.',
    {
      tableName: { type: 'string' },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered column list. Several columns create ONE composite index over that exact tuple.',
      },
      unique: { type: 'boolean', description: 'Enforce uniqueness over the whole column tuple.' },
      indexName: { type: 'string', description: 'Optional explicit index name. Omit and one is derived from the table and columns.' },
      method: {
        type: 'string',
        enum: ['btree', 'gin', 'gist', 'hash', 'brin'],
        description: 'Index method. Defaults to btree; use gin for array or jsonb containment queries.',
      },
      where: { type: 'string', description: 'Optional predicate for a PARTIAL index — only rows matching it are indexed.' },
    },
    ['tableName', 'columns']),
  fn('generate_api',
    'Generate (or regenerate) the REST CRUD API for an existing table.',
    { tableName: { type: 'string' } },
    ['tableName']),
  fn('enable_auth',
    'Enable end-user authentication (JWT, email + password) for this project.',
    {}),
  fn('add_oauth_provider',
    'Add an OAuth sign-in provider (Google, GitHub, etc.) for the project\'s end-users. ' +
    'Requires the project owner\'s OAuth Client ID and Client Secret for that provider. ' +
    'If you do NOT have them, call this tool with only `provider` — it stops the turn and asks the user to paste their credentials. ' +
    'Once the user provides them, call again with `clientId` + `clientSecret` and it configures the provider.',
    {
      provider: { type: 'string', enum: ['google', 'github', 'discord', 'facebook', 'apple'] },
      clientId: { type: 'string', description: 'OAuth Client ID from the provider\'s developer console.' },
      clientSecret: { type: 'string', description: 'OAuth Client Secret from the provider\'s developer console.' },
    },
    ['provider']),
  fn('disable_oauth_provider',
    'DESTRUCTIVE. Turn off an OAuth sign-in provider — end-users using it lose the ability to sign in. The stored Client ID and Secret are kept so re-enabling later is a one-step toggle without re-pasting credentials. Requires confirmation.',
    { provider: { type: 'string', enum: ['google', 'github', 'discord', 'facebook', 'apple'] } },
    ['provider']),
  fn('create_bucket',
    'Create a storage bucket for file uploads.',
    { bucketName: { type: 'string' }, isPublic: { type: 'boolean' } },
    ['bucketName']),
  fn('add_rls',
    'Add a row-level-security policy to a table. Templates:\n' +
    '  • auto — RECOMMENDED DEFAULT. Reads the table\'s columns and foreign keys and installs the policy the schema implies: one owner column → owner_read_write, TWO OR MORE user columns → participants, ownership through a parent (order_items → orders → users) → owned_via_parent, reference data → public_read. Refuses with an explanation rather than guessing when ownership is genuinely ambiguous.\n' +
    '  • owner_read_write — each user can read/write only rows they own (table has ONE user column)\n' +
    '  • participants — the row belongs to SEVERAL users and each of them can read and modify it. Use for every two-party table: connections(requester_id, addressee_id), conversations(user_a, user_b), messages(sender_id, recipient_id), follows, matches, invitations. owner_read_write is WRONG on these — it grants access to one side and locks the other out of their own row. Pass `partyColumns` to be explicit, or omit it and the foreign keys are read.\n' +
    '  • owned_via_parent — the row belongs to whoever owns its PARENT row. Use for tables with no user column of their own but a foreign key to a user-owned table: line items, shipping addresses, saved cards, messages in a conversation. Works when the parent is itself two-party, so a message is visible to both participants. Without this such tables are readable by any API key.\n' +
    '  • public_read — anyone can read, only the owner can write (blogs, marketplaces)\n' +
    '  • org_members — multi-tenant B2B: users can access rows where organization_id matches an org they belong to. REQUIRES the table to have an organization_id column AND the project to have enable_teams already run.\n' +
    '  • admin_only — only service-role API keys (server-side jobs) can access\n' +
    '  • all_access — every authenticated user can read/write everything (rare; use with care)\n' +
    '  • custom — THE ESCAPE HATCH. Your own predicate when no template fits. REQUIRES `using`: a boolean expression over this table\'s columns where backenly_jwt_claim(\'sub\') is the calling end-user\'s id, e.g. "owner_id::text = backenly_jwt_claim(\'sub\') OR is_public". Subqueries are refused — if the rule has to read another table, use owned_via_parent, which builds that lookup for you.\n' +
    'This tool NEVER substitutes a different policy for the one you asked for: an unrecognised template is refused with the list of real ones, and applying `participants` where you asked for `owner_read_write` is reported in the result.',
    {
      tableName: { type: 'string' },
      policy: {
        type: 'string',
        enum: [
          'auto', 'owner_read_write', 'participants', 'owned_via_parent', 'public_read',
          'org_members', 'admin_only', 'all_access', 'admin_read_all', 'role_based',
          'moderator_access', 'custom',
        ],
      },
      partyColumns: {
        type: 'array',
        items: { type: 'string' },
        description: 'For `participants`: the columns naming each user party to a row, e.g. ["requester_id","addressee_id"].',
      },
      using: {
        type: 'string',
        description: 'For `custom`: the predicate a row must satisfy to be readable. Use backenly_jwt_claim(\'sub\') for the caller\'s user id.',
      },
      withCheck: {
        type: 'string',
        description: 'For `custom`: an optional separate predicate for INSERT/UPDATE. Defaults to `using`.',
      },
    },
    ['tableName']),
  fn('create_trigger',
    'Create an event trigger on a table (insert|update|delete) — webhook or NOTIFY.',
    {
      tableName: { type: 'string' },
      on: { type: 'string', enum: ['insert', 'update', 'delete'] },
      kind: { type: 'string', enum: ['webhook', 'notify'] },
    },
    ['tableName', 'on', 'kind']),
  fn('enable_realtime',
    'Enable realtime change events for a table.',
    { tableName: { type: 'string' } },
    ['tableName']),
  fn('generate_function',
    'Create a backend function. Backenly functions are EVENT-DRIVEN or HTTP — pick the `trigger` that matches what the user described:\n' +
    '  • on_signup — runs automatically every time an end-user signs up (welcome emails, default rows, tier assignment, analytics identify).\n' +
    '  • on_insert / on_update / on_delete — runs automatically every time a row is inserted / updated / deleted in `table` ' +
    '(denormalised counters, audit rows, notifications — "when an order is created…", "when a post is published…"). REQUIRES `table`.\n' +
    '  • http — a callable REST endpoint at /api/v1/{projectId}/fn/{name} that a frontend or another service hits directly ' +
    '("an endpoint to export orders as CSV", "a /checkout/session endpoint").\n' +
    '  • manual — only runs when fired from the Functions dashboard (occasional maintenance / recompute tasks).\n' +
    'Whenever the user describes something that should happen AUTOMATICALLY in response to an event, use on_signup / on_insert / ' +
    'on_update / on_delete — NOT http. An http function never auto-fires. For recurring time-based jobs use create_cron_job instead.',
    {
      name: { type: 'string', description: 'Short snake_case or kebab-case function name, e.g. "send_welcome_email".' },
      description: { type: 'string', description: 'Precise plain-English spec of what the function does — name the tables it reads/writes and any integrations (Stripe, email, etc.) it calls.' },
      trigger: {
        type: 'string',
        enum: ['on_signup', 'on_insert', 'on_update', 'on_delete', 'http', 'manual'],
        description: 'What fires the function. Use an event type for automatic behaviour; http for a directly-callable endpoint.',
      },
      table: { type: 'string', description: 'Required for on_insert / on_update / on_delete — the table whose row events fire the function.' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'For trigger=http only — the HTTP verb of the endpoint. Defaults to POST.',
      },
    },
    ['name', 'description', 'trigger']),
  fn('enable_vector_search',
    'Enable semantic / similarity search (pgvector + OpenAI text-embedding-3-small) on a table. Adds an embedding column, builds a cosine-similarity index, registers the /vector-search endpoint, and auto-embeds new and updated rows. Use this whenever the user wants RAG, similarity recommendations, semantic search, "find similar X", or any AI-app feature that needs embeddings. sourceColumns are the human-readable text columns the embedding is built from (defaults to title/name/body/description/content/text if omitted).',
    {
      tableName: { type: 'string' },
      sourceColumns: { type: 'array', items: { type: 'string' } },
    },
    ['tableName']),
  fn('create_cron_job',
    'Schedule a recurring background job. Describe WHAT the job should do in plain English, and WHEN it should run (e.g. "every day at 9am", "every 15 minutes", or a standard 5-field cron like "0 * * * *"). The platform generates the function code and wires it to the schedule.',
    {
      description: { type: 'string', description: 'Natural-language description of what the job does, e.g. "send each subscriber a daily summary email of their unread notifications".' },
      schedule: { type: 'string', description: 'When to run: "daily at 9am" / "every 15 minutes" / "0 9 * * *". Both natural language and 5-field cron accepted.' },
    },
    ['description', 'schedule']),
  fn('set_rate_limit',
    'Set a per-API rate limit (requests per minute) for a specific table\'s endpoints. Use to protect expensive endpoints or hostile-traffic surfaces. The limit is enforced per-API-key (or per-user / per-IP for unauthenticated endpoints).',
    {
      tableName: { type: 'string' },
      requestsPerMinute: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    ['tableName', 'requestsPerMinute']),
  fn('generate_aggregate_api',
    'Generate a dashboard-style aggregate / stats endpoint named "/stats/{name}". Returns totals, counts, and recent rows summarised across the project (e.g. "summary" → totals for products, orders, revenue, pending orders, low stock, recent orders). Use this for dashboards, KPIs, and at-a-glance reporting.',
    {
      name: { type: 'string', description: 'Short slug for the endpoint, e.g. "summary" or "metrics". Final path is /api/v1/{projectId}/stats/{name}.' },
    },
    ['name']),
  fn('run_data_migration',
    'Transform EXISTING data safely — the schema-evolution tool for "change the data, not just the columns". A checkpoint copy of each affected table is taken automatically and the whole migration is one atomic transaction. Operations (combine up to 20):\n' +
    '  • backfill — fill NULLs (or all rows) of a column with a constant or another column\'s value: {op:"backfill", table, column, value?|fromColumn?, onlyNull?}\n' +
    '  • split_column — split "First Last" style text into new columns: {op:"split_column", table, source, separator, targets:["first_name","last_name"]} (source column is kept)\n' +
    '  • merge_columns — concatenate columns into one: {op:"merge_columns", table, sources:[…], target, separator}\n' +
    '  • cast_column — change a column\'s type converting live data: {op:"cast_column", table, column, toType:"integer|bigint|numeric|boolean|timestamptz|date|text|uuid|jsonb", onError:"fail"|"null"}\n' +
    '  • normalize_values — rewrite values via a mapping (unify "Active"/"ACTIVE"→"active"): {op:"normalize_values", table, column, mapping:{from:to}}\n' +
    'ALWAYS call with dryRun:true first and show the user the affected-row counts before running it for real.',
    {
      operations: {
        type: 'array',
        description: 'The typed operations to apply, in order.',
        items: { type: 'object' },
      },
      dryRun: { type: 'boolean', description: 'true = report affected-row counts without changing anything. Always do this first.' },
    },
    ['operations']),
  fn('enable_teams',
    'Wire up first-class team / organization multi-tenancy. Creates organizations, organization_members, and organization_invitations tables with standard CRUD APIs, plus an /orgs/accept-invite endpoint. Use this whenever the user wants B2B SaaS, "users belong to a company / team / workspace", invitable seats, or anything multi-tenant where rows must be scoped to an org.',
    {},
    []),
  fn('enable_push_notifications',
    'Connect OneSignal so the project can send mobile / web push notifications. Creates device_tokens + push_notifications tables and a register-device function. If the user has NOT pasted credentials yet (appId + restApiKey), call this with empty args — the tool returns a needsCredentials prompt that the brain should relay via ask_user.',
    {
      appId: { type: 'string', description: 'OneSignal App ID (UUID). Omit to start the credential-collection flow.' },
      restApiKey: { type: 'string', description: 'OneSignal REST API Key. Omit to start the credential-collection flow.' },
    },
    []),
  fn('send_push',
    'Send a push notification via OneSignal. Specify exactly ONE of: externalUserIds (your own user ids — your mobile app must have mapped these in OneSignal), playerIds (raw OneSignal player ids from device_tokens), or broadcast:true to notify everyone. data is optional structured payload delivered to the device.',
    {
      title: { type: 'string' },
      message: { type: 'string' },
      externalUserIds: { type: 'array', items: { type: 'string' } },
      playerIds: { type: 'array', items: { type: 'string' } },
      broadcast: { type: 'boolean' },
      data: { type: 'object' },
    },
    ['message']),
  fn('rotate_webhook_secret',
    'Rotate the HMAC signing secret for a webhook trigger. Returns the new secret in plaintext exactly once — relay it to the user so they can update their receiver. Use after suspected leakage, on a regular cadence, or when a trigger has none configured yet.',
    {
      triggerName: { type: 'string', description: 'The trigger\'s name. Either triggerName or triggerId is required.' },
      triggerId: { type: 'string', description: 'The trigger\'s id. Use when there are multiple triggers with overlapping names.' },
    },
    []),
  fn('list_webhook_deliveries',
    'Read-only view of recent webhook deliveries: each attempt, status (SUCCESS / FAILED / DEAD), HTTP code, last error, attempt count. Use when the user asks "is my webhook working?" / "show recent deliveries" / "why did the X integration miss events?". Optional status filter narrows to failures or dead-letter rows.',
    {
      status: { type: 'string', enum: ['SUCCESS', 'FAILED', 'DEAD'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    []),
  fn('replay_webhook_delivery',
    'Resend a previously-failed (DEAD) webhook delivery, signed with the trigger\'s current secret. Use when the user says "retry that delivery" / "replay the failed webhook" / "send that event again". The id comes from list_webhook_deliveries.',
    { id: { type: 'string', description: 'Delivery log id from list_webhook_deliveries.' } },
    ['id']),
  fn('fix_backend',
    'Repair a broken subsystem. target: auth | api | table | deploy | realtime | storage | integration | workflow. Use when read_backend_state shows something is broken.',
    {
      target: {
        type: 'string',
        enum: ['auth', 'api', 'table', 'deploy', 'realtime', 'storage', 'integration', 'workflow'],
      },
      tableName: { type: 'string' },
    },
    ['target']),
  fn('apply_proposal',
    "Apply the project's active Proposal (recommendation list the agent emitted earlier). scope: executable_only | all. Use when the user says 'apply' / 'implement all those'.",
    { scope: { type: 'string', enum: ['executable_only', 'all'] } }),
  fn('list_findings',
    'List open / pending health findings (issues the platform detected) for this project — id, type, severity, target table/column, reason. Use to map a problem (e.g. a pasted error screenshot or "fix this") to a concrete issue before resolve_finding. Side-effect free.',
    {}),
  fn('resolve_finding',
    'Resolve a detected health finding through the governed fix engine. Pass findingId (from list_findings or the diagnostic context). If you only know the kind of problem, pass findingType and/or tableName/columnName and the closest match is resolved. Safe/additive fixes (FK, RLS, index, API) apply immediately and are verified; auth/destructive/irreversible fixes return a confirmation request — relay it to the user and only call again after they confirm.',
    {
      findingId: { type: 'string', description: 'Exact finding id (preferred — from list_findings or the diagnostic context).' },
      findingType: { type: 'string', description: 'e.g. missing_fk, missing_rls, integration_smtp_unreachable — used to match a finding when no id is known.' },
      tableName: { type: 'string' },
      columnName: { type: 'string' },
    }),
  fn('get_pending_incidents',
    "The backend briefing: everything Backenly's autonomous operator detected, fixed, or queued while nobody was watching. Returns open findings with evidence, changes awaiting human approval in the Review Queue, fixes auto-applied in the last 24h, pending external schema drift, and the latest restore point. Call this FIRST when starting a session on an existing backend, or when the user asks \"what happened?\" / \"any issues?\". Side-effect free.",
    {}),
  fn('get_database_credentials',
    "Get a real PostgreSQL connection string (host, port, database, role, password) for this project's schema — for psql, ORMs, BI tools, or running your own migrations. mode=READ_ONLY (default) provisions instantly and is SELECT-only. mode=READ_WRITE is returned only after the project owner enables write access in the dashboard (Connect → Direct); DDL you run over it is observed by the drift watch and adopted into the governed contract — call adopt_external_schema afterwards. Treat the returned connection string as a secret: use it, do not print it into files or logs.",
    {
      mode: { type: 'string', enum: ['READ_ONLY', 'READ_WRITE'], description: 'Access level. Default READ_ONLY.' },
    }),
  fn('adopt_external_schema',
    "Adopt schema changes made over a direct database connection (psql / migration tool) into Backenly's governed contract: registers new tables (REST API + RLS + realtime), refreshes altered ones, prunes dropped ones, re-baselines the schema snapshot, re-syncs access grants. Bookkeeping only — never executes DDL. Call after running your own migrations via the READ_WRITE connection string so the platform and your schema agree.",
    {}),
  // ── Read tools (live state of every section) ──────────────────────────────
  fn('run_query',
    "Run read-only SQL against this project's workspace schema. This is THE way to read data: full PostgreSQL SELECT including joins, GROUP BY, aggregates, window functions, CTEs, subqueries, and EXPLAIN (without ANALYZE). Tables are already in scope: write `SELECT * FROM posts`, not `workspace_x.posts`. Executes as a SELECT-only role inside a READ ONLY transaction — it cannot write, and it cannot read another project's DATA (Postgres grants refuse it, not a SQL check). The PostgreSQL system catalogs (`pg_*`, `information_schema`) are instance-wide rather than per-project, so they are refused outright; use read_backend_state or get_table_schema to inspect this project's schema. One statement per call. Results are capped (default 200 rows, max 1000) and `truncated` tells you whether more exist. Password, token and API-key columns come back as '[redacted]'. To change SCHEMA use apply_migration (ordinary DDL); to change ROWS use db_insert / db_update / db_delete.",
    {
      sql: { type: 'string', description: 'A single read-only SQL statement, e.g. "SELECT status, count(*) FROM orders GROUP BY status".' },
      limit: { type: 'number', description: 'Row cap. Default 200, max 1000.' },
    },
    ['sql']),
  fn('list_tables',
    'List every table in this project with its column count and row count. Use to answer "what tables do I have?" or before suggesting changes to existing tables.',
    {}),
  fn('list_apis',
    'List every REST endpoint generated for this project (method + path). Use to answer "what APIs do I have?" or to verify an endpoint exists before recommending it.',
    {}),
  fn('list_buckets',
    'List storage buckets in this project (name, public/private, file count).',
    {}),
  fn('list_files',
    'List files in a storage bucket. Use to answer "what files are in X?" before delete_file or generate_signed_url.',
    { bucketName: { type: 'string' }, prefix: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
    ['bucketName']),
  fn('generate_signed_url',
    'Generate a short-lived signed URL for a private file in a bucket. Use when the user asks for a shareable download link.',
    {
      bucketName: { type: 'string' },
      path: { type: 'string', description: 'Path of the file within the bucket.' },
      expiresInSeconds: { type: 'integer', minimum: 30, maximum: 86400 },
    },
    ['bucketName', 'path']),
  fn('list_api_keys',
    'List platform API keys for this project (id, label, permissions, created at). Never returns secret material.',
    {}),
  fn('list_end_users',
    'List authenticated end-users of the project (id, email, created at, blocked flag). Use before block_end_user / reset_end_user_password to resolve identity.',
    { limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  fn('list_permissions',
    'List every row-level-security policy in this project (table → template). Use to answer "what is locked down?" before recommending add_rls / remove_permission.',
    {}),
  fn('list_triggers',
    'List event triggers (insert/update/delete + webhook/notify). Use before create_trigger / delete_trigger / rotate_webhook_secret.',
    {}),
  fn('list_ai_functions',
    'List AI / serverless functions in this project (name, trigger type, active flag).',
    {}),
  fn('list_cron_jobs',
    'List scheduled background jobs (name, schedule, last run, next run).',
    {}),
  // ── Preview branches ────────────────────────────────────────────────────────
  // A branch is one CREATE SCHEMA plus per-table LIKE-clones, so it costs
  // essentially nothing on this architecture. These were reachable only from the
  // dashboard, which meant an agent doing schema work had no staging environment
  // and every migration landed on live customer data — reported as the single
  // riskiest gap in the surface. lib/branches/engine.ts is the implementation.
  fn('create_branch',
    'Create a preview branch: a full structural + data clone of this project\'s schema in an isolated PostgreSQL schema. Use it before any migration you are not certain about — experiment there, diff it against main, then merge. Max 5 active branches. Names are lowercase kebab-case.',
    { name: { type: 'string', description: 'Branch name, e.g. "add-payments". Lowercase kebab-case.' } },
    ['name']),
  fn('list_branches',
    'List this project\'s preview branches with their status, schema name and creation time. Side-effect free.',
    {}),
  fn('diff_branch',
    'Compare a preview branch against main: tables added/removed, columns added/removed, and type changes. Read this before merging so you know exactly what would land. Side-effect free.',
    { branchId: { type: 'string', description: 'The branch id from list_branches.' } },
    ['branchId']),
  fn('merge_branch',
    'Merge a preview branch back into main through the governed path. NEW TABLES are applied via the same kernel a direct create uses (metadata, REST exposure, auto-RLS, reconciler all fire). Added columns, type changes and drops are NOT auto-applied — they come back as review items, because silently reshaping a live column is exactly what a branch exists to prevent. Call diff_branch first.',
    { branchId: { type: 'string', description: 'The branch id from list_branches.' } },
    ['branchId']),
  fn('discard_branch',
    'DESTRUCTIVE. Drop a preview branch and everything in it. Requires explicit human approval. Main is untouched.',
    { branchId: { type: 'string', description: 'The branch id from list_branches.' } },
    ['branchId']),
  fn('list_integration_keys',
    'List which third-party integrations have credentials configured (stripe, resend, openai, anthropic, …). Never returns the secret itself.',
    {}),
  fn('list_connected_apps',
    'List frontends connected to this backend (active + previously disconnected). The canonical Connect-Frontend surface. Use before connect_frontend / disconnect_frontend.',
    {}),
  fn('get_deploy_status',
    'Read current deployment state: last deploy time, status (BUILDING / LIVE / FAILED), commit, environment. Use before trigger_deploy / rollback_deploy.',
    {}),
  fn('get_metrics',
    'Read live performance metrics (request rate, p50/p95 latency, error rate, top endpoints) over a window. Use for "is the API healthy?" / "what is slow?".',
    {
      windowMinutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'Lookback window. Default 60 minutes.' },
    }),
  fn('get_errors',
    'Read recent error log entries (5xx + uncaught exceptions) — endpoint, status, message, count, last seen.',
    { limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  fn('get_usage',
    'Read usage and quota burn for this project (AI credits used, storage MB, request count, plan limits). Use for "how close am I to my plan limit?".',
    {}),
  fn('get_autonomy_status',
    'Read the autonomy dial + Trust Report for this project: current level (OFF/CONSERVATIVE/BALANCED/AGGRESSIVE), recent self-applied actions, pending approvals, and the autonomy circuit-breaker state. Use before set_autonomy_level.',
    { windowDays: { type: 'integer', minimum: 1, maximum: 90 } }),
  fn('get_realtime_status',
    'Read realtime streaming state from the live database: which tables push live INSERT/UPDATE/DELETE events to subscribed clients over SSE, which tables are idle (realtime not enabled), how many end-users are online right now, and the Postgres NOTIFY channel. Side-effect free. Call this to answer "is realtime working?" / "what is streaming?" / "how many users are online?", and ALWAYS before enable_realtime / disable_realtime / fix_backend(target="realtime") so you act on real state instead of guessing.',
    {}),

  // ── Schema edit (beyond create) ───────────────────────────────────────────
  fn('rename_column',
    'Rename an existing column on a table. Generated APIs are regenerated automatically; existing API consumers that hard-code the old name will break — warn the user.',
    {
      tableName: { type: 'string' },
      oldName: { type: 'string' },
      newName: { type: 'string' },
    },
    ['tableName', 'oldName', 'newName']),
  fn('add_constraint',
    'Add or relax a constraint on an existing table: NOT NULL, UNIQUE, CHECK (single- OR multi-column), ' +
    'FOREIGN KEY, and column DEFAULTs. Use to tighten data integrity after a table has been in use. ' +
    'A CHECK spanning several columns (`start_date < end_date`, `requester_id <> addressee_id`) is a ' +
    'table-level constraint — pass every column it references in `columns`.',
    {
      tableName: { type: 'string' },
      columnName: {
        type: 'string',
        description: 'The column the constraint applies to. Required for every type except a multi-column CHECK.',
      },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'For a CHECK spanning several columns: every column the expression references.',
      },
      constraintType: {
        type: 'string',
        enum: ['not_null', 'drop_not_null', 'unique', 'check', 'foreign_key', 'set_default', 'drop_default'],
      },
      expression: {
        type: 'string',
        description:
          'For CHECK: the boolean expression. For FOREIGN KEY: "otherTable(column)". ' +
          'For set_default: the default expression.',
      },
      constraintName: {
        type: 'string',
        description:
          'Optional explicit constraint name. Give one when a table needs two constraints on the same ' +
          'column — without it a name is derived from the table, columns AND the expression, so distinct ' +
          'constraints never collide.',
      },
      referencedTable: { type: 'string', description: 'For FOREIGN KEY: the table being referenced.' },
    },
    ['tableName', 'constraintType']),

  // ── Storage edit / delete ─────────────────────────────────────────────────
  fn('set_bucket_public',
    'Flip a bucket public ↔ private. Public buckets serve files at a stable URL; private buckets require a signed URL. Changes apply immediately to all files.',
    { bucketName: { type: 'string' }, isPublic: { type: 'boolean' } },
    ['bucketName', 'isPublic']),
  fn('delete_bucket',
    'DESTRUCTIVE. Delete a storage bucket AND every file inside it. Requires explicit user confirmation in the same turn.',
    { bucketName: { type: 'string' } },
    ['bucketName']),
  fn('delete_file',
    'DESTRUCTIVE. Delete a single file from a bucket. Requires explicit user confirmation in the same turn.',
    { bucketName: { type: 'string' }, path: { type: 'string' } },
    ['bucketName', 'path']),

  // ── Connect Frontend ──────────────────────────────────────────────────────
  fn('connect_frontend',
    'Connect a deployed frontend to this backend. Pass the frontend URL the user gave you ("app.acme.com", "https://app.replit.com/x", "localhost:3000"). The engine normalizes it to an exact origin, verifies the backend has been deployed, and (unless force=true) returns a confirmation prompt — the user must type CONNECT to proceed. Pin to the deployed backend version. Use whenever the user says "hook up my app at <url>", "connect my Replit / Lovable / Vercel frontend", "let app.x.com call my APIs".',
    {
      url: { type: 'string', description: 'The frontend URL the user named. Will be normalized to a CORS origin.' },
      force: { type: 'boolean', description: 'Set true ONLY when the user has already typed CONNECT in this turn — skips the confirmation gate.' },
    },
    ['url']),
  fn('disconnect_frontend',
    'DESTRUCTIVE-ish. Disconnect a previously-connected frontend. Its browser requests will start failing CORS preflight immediately — warn the user. Unless force=true, returns a confirmation prompt requiring the user to type DISCONNECT.',
    {
      url: { type: 'string', description: 'The origin to disconnect. Will be normalized.' },
      force: { type: 'boolean', description: 'Set true ONLY when the user has typed DISCONNECT in this turn.' },
    },
    ['url']),

  // ── Publish / Deploy ──────────────────────────────────────────────────────
  fn('trigger_deploy',
    'DESTRUCTIVE-grade. Publish the current backend (tables, APIs, auth, storage, triggers, RLS become publicly callable). The engine runs a readiness gate and a "Type DEPLOY to confirm" prompt — surface the prompt verbatim to the user. Re-call with force:true ONLY after the user replies DEPLOY. Use when the user says "ship it" / "publish" / "go live".',
    {
      environment: { type: 'string', enum: ['production', 'staging'], description: 'Default production.' },
      force: { type: 'boolean', description: 'Set true ONLY when the user has typed DEPLOY verbatim this turn.' },
    }),
  fn('rollback_deploy',
    'DESTRUCTIVE. Revert the live backend to a previous published version. Engine returns a "Type ROLLBACK to confirm" prompt unless force:true. Always call get_deploy_status / list_apis first so you know which version you would be reverting to.',
    {
      version: { type: 'integer', description: 'Target published version number (e.g. 2). Either version OR deploymentId is required.' },
      deploymentId: { type: 'string', description: 'Specific deployment id to roll back to.' },
      force: { type: 'boolean', description: 'Set true ONLY when the user has typed ROLLBACK verbatim this turn.' },
    }),
  fn('get_readiness',
    'Read the production-readiness scorecard for this project (0-100). Returns blockers, warnings, and auto-fixable items. Call before trigger_deploy so you can tell the user exactly what is missing.',
    { autoFix: { type: 'boolean', description: 'Apply safe auto-fixes (JWT generation, default RLS) during the scan. Default true.' } }),
  fn('set_env_var',
    'Save an encrypted env var for this project. Available to AI functions as ctx.env.<KEY>. Keys must be UPPER_SNAKE_CASE. Values are encrypted at rest (AES-256-GCM). Use for third-party secrets the user has (STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, etc). Do NOT use for first-party platform secrets (JWT_SECRET, DATABASE_URL).',
    {
      key: { type: 'string', description: 'UPPER_SNAKE_CASE identifier, e.g. STRIPE_WEBHOOK_SECRET.' },
      value: { type: 'string', description: 'The secret value. Will be encrypted before storage.' },
      description: { type: 'string', description: 'Optional human-readable note about what this secret is for.' },
    },
    ['key', 'value']),
  fn('list_env_vars',
    'List the env vars saved for this project. Returns keys + 4-character previews — never the full plaintext. Call before set_env_var (to confirm whether a key already exists) or before delete_env_var.',
    {}),
  fn('delete_env_var',
    'DESTRUCTIVE. Permanently delete a project env var. AI functions reading ctx.env.<KEY> will start getting undefined on next invocation. Confirmation required.',
    { key: { type: 'string' } },
    ['key']),

  // ── Auth lifecycle ────────────────────────────────────────────────────────
  fn('reset_end_user_password',
    'Reset an end-user\'s password. Generates a secure temporary password and returns it so the project owner can hand it to the user out-of-band — it does NOT email the user. Accepts either userId or email.',
    { userId: { type: 'string' }, email: { type: 'string' } }),
  fn('block_end_user',
    'DESTRUCTIVE. Block an end-user — their existing JWT tokens stop working immediately and they cannot sign in. Reversible via unblock_end_user. Requires confirmation.',
    { userId: { type: 'string' }, email: { type: 'string' } }),
  fn('unblock_end_user',
    'Lift a block previously set by block_end_user — the user can sign in again. Accepts either userId or email.',
    { userId: { type: 'string' }, email: { type: 'string' } }),
  fn('remove_permission',
    'DESTRUCTIVE. Remove ALL row-level-security policies from a table. After this call the table is unprotected unless you add a new policy. Requires confirmation.',
    { tableName: { type: 'string' } },
    ['tableName']),

  // ── IAM (platform API keys) ───────────────────────────────────────────────
  fn('create_api_key',
    'Issue a new platform API key for server-to-server / scripted access to this project. Returns the secret in plaintext ONCE — relay it to the user. Permissions default to read-only unless overridden.',
    {
      description: { type: 'string', description: 'Human label, e.g. "cron worker".' },
      permissions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["read:posts","write:posts"]. Default ["read:*"].' },
    }),
  fn('revoke_api_key',
    'DESTRUCTIVE. Permanently revoke an API key — every client using it stops working immediately. Requires confirmation.',
    { keyId: { type: 'string' } },
    ['keyId']),
  fn('rotate_api_key',
    'DESTRUCTIVE. Issue a new secret for an existing key — the OLD secret stops working immediately. Returns the new secret once; tell the user to update their clients. Requires confirmation.',
    { keyId: { type: 'string' } },
    ['keyId']),
  fn('set_key_permissions',
    'Update the permission set on an existing API key (e.g. add write access to a new table).',
    {
      keyId: { type: 'string' },
      permissions: { type: 'array', items: { type: 'string' } },
    },
    ['keyId', 'permissions']),

  // ── Integrations ──────────────────────────────────────────────────────────
  fn('store_integration_key',
    'Store a third-party integration credential (stripe, resend, sendgrid, openai, anthropic, twilio, posthog, replicate, runway, stability, onesignal, …). The secret is encrypted at rest and never echoed back. ' +
    'Use whenever the user says "here\'s my Stripe key" / "connect Resend for me". ' +
    'If you do NOT have the key yet, call this with ONLY `integrationId` (omit apiKey) — it returns an inline "paste your key here" prompt to relay in chat. Collect the key IN THE CHAT; never redirect the user to the dashboard / Controls hamburger / Integrations panel. When they paste it, call again with `apiKey`. ' +
    'After it is stored, do not stop at "connected" — wire it into their app (generate_function + create_trigger) so it actually runs on a real event.',
    {
      integrationId: { type: 'string', description: 'Provider id, e.g. "stripe", "resend", "openai", "replicate".' },
      apiKey: { type: 'string', description: 'The secret to store (encrypted). Omit to trigger the inline "paste your key" prompt.' },
      label: { type: 'string', description: 'Optional human label, e.g. "Stripe live key".' },
    },
    ['integrationId']),
  fn('remove_integration_key',
    'DESTRUCTIVE. Disconnect a third-party integration — any feature that relied on it (email sending, payments, AI) stops working immediately. Requires confirmation.',
    { integrationId: { type: 'string' } },
    ['integrationId']),
  fn('delete_trigger',
    'DESTRUCTIVE. Permanently delete an event trigger. Active webhooks and NOTIFY listeners on it stop firing immediately. Requires confirmation.',
    { triggerId: { type: 'string' }, name: { type: 'string' } }),

  // ── Functions lifecycle ───────────────────────────────────────────────────
  fn('toggle_ai_function',
    'Enable or disable an AI / serverless function. Disabled functions stop firing on their trigger but are preserved.',
    {
      functionId: { type: 'string' },
      name: { type: 'string' },
      active: { type: 'boolean' },
    },
    ['active']),
  fn('delete_ai_function',
    'DESTRUCTIVE. Permanently delete an AI / serverless function and its history. Requires confirmation.',
    { functionId: { type: 'string' }, name: { type: 'string' } }),
  fn('delete_cron_job',
    'DESTRUCTIVE. Permanently delete a scheduled job — it stops running immediately. Requires confirmation.',
    { jobId: { type: 'string' }, name: { type: 'string' } }),

  // ── Monitoring ────────────────────────────────────────────────────────────
  fn('set_alert',
    'Configure a monitoring alert. Supported channels: email + dashboard. Trigger types: error_rate, latency_p95, request_rate, integration_failure.',
    {
      type: { type: 'string', enum: ['error_rate', 'latency_p95', 'request_rate', 'integration_failure'] },
      threshold: { type: 'number', description: 'Numeric threshold (e.g. 5 for "5% error rate", 800 for "800ms p95").' },
      windowMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
      channel: { type: 'string', enum: ['email', 'dashboard', 'both'] },
    },
    ['type', 'threshold']),

  // ── Autonomy ──────────────────────────────────────────────────────────────
  fn('set_autonomy_level',
    'Change the project\'s autonomy dial. OFF = observe-only, CONSERVATIVE = auto Tier-0, BALANCED = auto Tier-0+1, AGGRESSIVE = auto Tier-0+1 with higher per-window ceiling. Tier-2+ (auth, external, destructive) is NEVER auto-applied at any level. The dial is clamped to the project\'s plan ceiling.',
    { level: { type: 'string', enum: ['OFF', 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'] } },
    ['level']),

  fn('drop_table',
    'DESTRUCTIVE. Permanently drop a table and all its data. Requires explicit user confirmation in the same turn.',
    { tableName: { type: 'string' } },
    ['tableName']),
  fn('truncate_table',
    'DESTRUCTIVE. Delete every row in a table but keep the table and schema. Requires explicit user confirmation in the same turn.',
    { tableName: { type: 'string' } },
    ['tableName']),
  fn('drop_column',
    'DESTRUCTIVE. Permanently drop a column and ALL of its data from a table. Reserved columns (id, createdAt, updatedAt) cannot be dropped — to remove the whole table use drop_table. Regenerates the table\'s REST API so the column disappears from CRUD payloads. Requires explicit user confirmation in the same turn.',
    { tableName: { type: 'string' }, columnName: { type: 'string' } },
    ['tableName', 'columnName']),
  fn('disable_realtime',
    'DESTRUCTIVE (for live subscribers). Stop streaming realtime change events. Pass a tableName to disable a single table, or omit to disable realtime project-wide. Any client currently subscribed via SSE stops receiving events the moment the trigger is dropped. The shared NOTIFY function is preserved so re-enabling later is instant. Requires explicit user confirmation in the same turn.',
    { tableName: { type: 'string', description: 'Optional. If omitted, disables realtime on every workspace table.' } }),
  fn('propose_plan',
    "Emit a structured build plan and STOP the loop awaiting user confirmation. Use when the request will create 2+ resources OR includes destructive ops OR touches >1 subsystem. The next user message ('yes' / 'go ahead') resumes execution.",
    {
      title: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            tool: { type: 'string' },
            destructive: { type: 'boolean' },
          },
          required: ['label', 'tool'],
        },
      },
      blastRadius: { type: 'string', enum: ['small', 'medium', 'large'] },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    ['title', 'steps']),
  fn('ask_user',
    'Ask the user a single focused clarifying question and STOP the loop. Use when the request is unclear or a required input is missing. Provide 2-3 short option strings if there are obvious choices.',
    {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
    },
    ['question']),
  fn('answer_question',
    'Answer a capability / concept / comparison question WITHOUT building anything. Use for "what is Backenly?", "are you agentic?", "what are competitors?", "explain RLS", etc. Returns prose the user sees; ends the turn.',
    { question: { type: 'string' } },
    ['question']),
  fn('run_test',
    "Verify a generated REST endpoint actually works by calling it with a sample payload and asserting the response. Use after generate_api on tables where freshness matters. Returns ok:false with status code + body on failure.",
    {
      tableName: { type: 'string' },
      operation: { type: 'string', enum: ['list', 'create', 'get'] },
    },
    ['tableName', 'operation']),
  fn('rollback',
    'Undo the last N agent actions in this turn when verification fails or the user explicitly asks to rollback. Use sparingly — most failures should be fixed forward.',
    { steps: { type: 'integer', minimum: 1, maximum: 10 } }),
  fn('finish',
    "End the turn. Call this when the user's request is fully satisfied OR when you need the user to answer a question / provide a credential before continuing. Provide a concise, product-voice summary.",
    {
      summary: { type: 'string' },
      needsUser: { type: 'boolean' },
    },
    ['summary']),
]

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        ...(required && required.length ? { required } : {}),
      },
    },
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Brain tool → executor action.
 *
 * Exported so `tests/unit/tool-arg-forwarding.spec.ts` can assert that every
 * DECLARED property of a tool's schema survives the hop. A mapper that quietly
 * drops one is the most expensive bug this file can carry, and it carried two:
 * `create_index` declared `unique` and did not forward it, and forwarded only
 * `columns[0]`'s worth of information downstream — so a UNIQUE composite index
 * arrived as a plain single-column one and reported success (defects #4 and #5).
 * Neither showed up in any test, because both sides type-checked fine.
 */
export const TOOL_TO_ACTION: Record<string, (args: any) => AIAction> = {
  adopt_external_schema: () => ({ action: 'ADOPT_EXTERNAL_SCHEMA', params: {} }),
  create_table: (a) => ({ action: 'CREATE_TABLE', params: { tableName: a.tableName, columns: a.columns } }),
  add_column: (a) => ({
    action: 'ADD_COLUMN',
    params: {
      tableName: a.tableName,
      // The MCP/brain arg shape is { column: { name, type, nullable, default } }.
      // executeAddColumn reads columnName/columnType — map explicitly so the
      // column is actually created (spreading ...a.column produced name/type and
      // left columnName undefined → a real column literally named "undefined").
      columnName: a.column?.name ?? a.columnName,
      columnType: a.column?.type ?? a.columnType ?? 'TEXT',
      nullable: a.column?.nullable,
      default: a.column?.default,
      column: a.column,
    },
  }),
  // Every declared field is forwarded. A mapper that quietly drops one is the
  // most expensive bug this table can carry: `unique` and the tail of `columns`
  // were both absent here, so a UNIQUE composite index arrived at the executor
  // as a plain single-column one and reported success (defects #4 and #5).
  create_index: (a) => ({
    action: 'CREATE_INDEX',
    params: {
      tableName: a.tableName,
      columns: a.columns,
      unique: !!a.unique,
      indexName: a.indexName,
      method: a.method,
      where: a.where,
    },
  }),
  rename_column: (a) => ({ action: 'RENAME_COLUMN', params: { tableName: a.tableName, oldName: a.oldName, newName: a.newName } }),
  add_constraint: (a) => ({
    action: 'ADD_CONSTRAINT',
    params: {
      tableName: a.tableName,
      columnName: a.columnName,
      columns: a.columns,
      constraintType: a.constraintType,
      expression: a.expression,
      constraintName: a.constraintName,
      referencedTable: a.referencedTable,
    },
  }),
  generate_api: (a) => ({ action: 'GENERATE_API', params: { tableName: a.tableName } }),
  enable_auth: () => ({ action: 'ENABLE_AUTH', params: {} }),
  // add_oauth_provider is NOT here — it has a dedicated dispatch branch in
  // dispatchTool() that handles the "no credentials yet → ask the user" flow.
  create_bucket: (a) => ({ action: 'CREATE_BUCKET', params: { bucketName: a.bucketName, isPublic: !!a.isPublic } }),
  set_bucket_public: (a) => ({ action: 'SET_BUCKET_PUBLIC', params: { bucketName: a.bucketName, isPublic: !!a.isPublic } }),
  add_rls: (a) => ({
    action: 'SET_PERMISSION',
    params: {
      tableName: a.tableName,
      // Brain-side policy names map onto the executor's validated template names.
      // The brain names are friendlier; the executor names predate this work.
      //
      // ── An OMITTED policy resolves to 'auto'. An UNRECOGNISED one does not ──
      //
      // Both used to collapse to 'auto', and that difference is defect #3. When a
      // model asked for a policy this table has no name for, the request was
      // silently replaced by "read the schema and pick" — so the engine installed
      // its own inferred owner-only policy and reported "Applied 2 change(s) ·
      // auto RLS". Three requests to replace a policy on three tables all came
      // back successful with all three policies unchanged.
      //
      // Omission genuinely means "you decide" and still maps to 'auto'. A NAME
      // this table does not know is passed through unchanged so the executor
      // refuses it and lists what exists — one recoverable error instead of a
      // silent substitution. `custom` carries the caller's predicate.
      template: a.policy === undefined || a.policy === null || a.policy === ''
        ? 'auto'
        : ({
            auto: 'auto',
            owner_read_write: 'own_rows',
            own_rows: 'own_rows',
            participants: 'party_rows',
            party_rows: 'party_rows',
            owned_via_parent: 'related_rows',
            related_rows: 'related_rows',
            public_read: 'public_read',
            org_members: 'org_members',
            admin_only: 'admin_only',
            all_access: 'all_access',
            admin_read_all: 'admin_read_all',
            role_based: 'role_based',
            moderator_access: 'moderator_access',
            custom: 'custom',
          } as Record<string, string>)[String(a.policy)] ?? String(a.policy),
      ...(Array.isArray(a.partyColumns) ? { partyColumns: a.partyColumns } : {}),
      ...(a.using ? { using: a.using } : {}),
      ...(a.withCheck ? { withCheck: a.withCheck } : {}),
    },
  }),
  create_trigger: (a) => {
    // The brain emits a high-level (tableName, on, kind) tuple — translate it
    // to the AppTrigger schema the executor actually understands: { name,
    // sourceTable, event, actionType, targetTable, webhookUrl, ... }.
    //
    // kind='notify' is shorthand for "fan out into the project's notifications
    // table" — the canonical pattern for social/feed apps where every
    // follow/like/comment/message should produce an in-app notification row.
    // We auto-wire field mappings so the trigger is callable without the model
    // having to spell out every column relationship. Tables that do not match
    // a known social-shape (e.g. follows, likes, comments, messages, mentions)
    // fall through to a permissive default: copy the source row's actor column
    // into the notification's from_user_id, and let the notifications row's
    // remaining columns rely on their defaults.
    //
    // kind='webhook' requires webhookUrl from the caller — pass it through.
    const sourceTable = String(a.tableName ?? '')
    const event = String(a.on ?? 'insert')
    const kind = String(a.kind ?? 'notify')
    const name = `${kind}_on_${event}_${sourceTable}`

    if (kind === 'webhook') {
      return {
        action: 'CREATE_TRIGGER',
        params: {
          name,
          description: `Fire webhook when ${sourceTable}.${event}`,
          sourceTable,
          event,
          actionType: 'webhook',
          webhookUrl: a.webhookUrl,
        },
      }
    }

    // kind='notify' → insert a notification row in the project's notifications
    // table. The exact column mapping depends on what the source table looks
    // like — these are the conventions the social-media / chat blueprints emit.
    const NOTIFY_FIELD_MAPPINGS: Record<string, Record<string, string>> = {
      // social: actor=user_id, target=followed_user_id (the followee receives it)
      follows:  { user_id: 'followed_user_id', from_user_id: 'user_id' },
      // social: actor=user_id, target=post owner (need post lookup, but as a
      // first-pass we still store the actor + post_id as target context)
      likes:    { from_user_id: 'user_id', target_id: 'post_id' },
      comments: { from_user_id: 'user_id', target_id: 'post_id' },
      // chat: actor=sender_id, target=conversation
      messages: { from_user_id: 'sender_id', target_id: 'conversation_id' },
      // mentions: actor=mentioned_by, target=mentioned user
      mentions: { user_id: 'mentioned_user_id', from_user_id: 'mentioned_by' },
    }

    const fieldMappings = NOTIFY_FIELD_MAPPINGS[sourceTable] ?? { from_user_id: 'user_id' }
    const staticFields: Record<string, string> = {
      type: sourceTable.replace(/s$/, ''), // "follows" → "follow", "likes" → "like"
      target_type: sourceTable === 'messages' ? 'message' : sourceTable === 'comments' ? 'comment' : 'post',
    }

    return {
      action: 'CREATE_TRIGGER',
      params: {
        name,
        description: `Create a notification when ${sourceTable}.${event}`,
        sourceTable,
        event,
        actionType: 'insert_row',
        targetTable: 'notifications',
        fieldMappings,
        staticFields,
      },
    }
  },
  enable_realtime: (a) => ({ action: 'ENABLE_REALTIME', params: { tableName: a.tableName } }),
  get_realtime_status: () => ({ action: 'GET_REALTIME_STATUS', params: {} }),
  generate_function: (a) => {
    const trigger = String(a.trigger || 'http').toLowerCase()
    // http → a Next.js route-handler module. Runs via the route-module runner
    // and is callable at /api/v1/{projectId}/fn/{name}.
    if (trigger === 'http') {
      return {
        action: 'GENERATE_FUNCTION',
        params: {
          functionName: a.name,
          name: a.name,
          description: a.description,
          method: String(a.method || 'POST').toUpperCase(),
        },
      }
    }
    // on_* / manual → a ctx-sandbox function. Runs in the Worker sandbox and is
    // auto-fired by the signup / insert / update / delete runtime hooks.
    const EVENT_TRIGGER: Record<string, string> = {
      on_signup: 'on_signup',
      on_insert: 'on_db_insert',
      on_update: 'on_db_update',
      on_delete: 'on_db_delete',
      manual: 'manual',
    }
    const triggerType = EVENT_TRIGGER[trigger] || 'manual'
    // triggerTable is only meaningful for db-row events — it names the table.
    const isDbEvent = triggerType === 'on_db_insert' || triggerType === 'on_db_update' || triggerType === 'on_db_delete'
    return {
      action: 'CREATE_AI_FUNCTION',
      params: {
        name: a.name,
        description: a.description,
        triggerType,
        triggerTable: isDbEvent ? (a.table || null) : null,
      },
    }
  },
  enable_vector_search: (a) => ({ action: 'ENABLE_VECTOR_SEARCH', params: { tableName: a.tableName, sourceColumns: a.sourceColumns } }),
  create_cron_job: (a) => ({ action: 'CREATE_CRON_JOB', params: { description: a.description, schedule: a.schedule } }),
  set_rate_limit: (a) => ({ action: 'SET_RATE_LIMIT', params: { tableName: a.tableName, requestsPerMinute: a.requestsPerMinute } }),
  generate_aggregate_api: (a) => ({ action: 'GENERATE_AGGREGATE_API', params: { name: a.name } }),
  run_data_migration: (a) => ({
    action: 'RUN_DATA_MIGRATION',
    params: { operations: a.operations, dryRun: !!a.dryRun },
  }),
  enable_teams: () => ({ action: 'ENABLE_TEAMS', params: {} }),
  send_push: (a) => ({ action: 'SEND_PUSH', params: a }),
  rotate_webhook_secret: (a) => ({ action: 'ROTATE_WEBHOOK_SECRET', params: { triggerName: a.triggerName, triggerId: a.triggerId } }),
  drop_table: (a) => ({ action: 'DROP_TABLE', params: { tableName: a.tableName } }),
  truncate_table: (a) => ({ action: 'TRUNCATE_TABLE', params: { tableName: a.tableName } }),
  drop_column: (a) => ({ action: 'DROP_COLUMN', params: { tableName: a.tableName, columnName: a.columnName } }),
  disable_realtime: (a) => ({ action: 'DISABLE_REALTIME', params: { tableName: a.tableName } }),

  // Reads — pure executor passthrough (no special handling)
  list_tables: () => ({ action: 'LIST_TABLES', params: {} }),
  list_apis: () => ({ action: 'LIST_APIS', params: {} }),
  list_buckets: () => ({ action: 'LIST_BUCKETS', params: {} }),
  list_files: (a) => ({ action: 'LIST_FILES', params: { bucketName: a.bucketName, prefix: a.prefix, limit: a.limit } }),
  generate_signed_url: (a) => ({ action: 'GENERATE_SIGNED_URL', params: { bucketName: a.bucketName, path: a.path, expiresInSeconds: a.expiresInSeconds } }),
  list_api_keys: () => ({ action: 'LIST_KEYS', params: {} }),
  list_end_users: (a) => ({ action: 'LIST_USERS', params: { limit: a.limit } }),
  list_permissions: () => ({ action: 'LIST_PERMISSIONS', params: {} }),
  list_triggers: () => ({ action: 'LIST_TRIGGERS', params: {} }),
  list_ai_functions: () => ({ action: 'LIST_AI_FUNCTIONS', params: {} }),
  list_cron_jobs: () => ({ action: 'LIST_CRON_JOBS', params: {} }),
  list_integration_keys: () => ({ action: 'LIST_INTEGRATION_KEYS', params: {} }),
  list_connected_apps: () => ({ action: 'LIST_CONNECTED_APPS', params: {} }),
  get_deploy_status: () => ({ action: 'GET_DEPLOY_STATUS', params: {} }),
  get_metrics: (a) => ({ action: 'GET_METRICS', params: { windowMinutes: a.windowMinutes } }),
  get_errors: (a) => ({ action: 'GET_ERRORS', params: { limit: a.limit } }),
  get_usage: () => ({ action: 'GET_USAGE', params: {} }),

  // Storage delete (gated by executor)
  delete_bucket: (a) => ({ action: 'DELETE_BUCKET', params: { bucketName: a.bucketName } }),
  delete_file: (a) => ({ action: 'DELETE_FILE', params: { bucketName: a.bucketName, path: a.path } }),

  // Connect Frontend
  connect_frontend: (a) => ({ action: 'CONNECT_FRONTEND', params: { url: a.url, force: !!a.force } }),
  disconnect_frontend: (a) => ({ action: 'DISCONNECT_FRONTEND', params: { url: a.url, force: !!a.force } }),

  // Publish / Deploy
  trigger_deploy: (a) => ({ action: 'TRIGGER_DEPLOY', params: { environment: a.environment || 'production', force: !!a.force } }),
  rollback_deploy: (a) => ({ action: 'ROLLBACK_DEPLOY', params: { version: a.version, deploymentId: a.deploymentId, force: !!a.force } }),
  get_readiness: (a) => ({ action: 'GET_READINESS', params: { autoFix: a.autoFix } }),
  set_env_var: (a) => ({ action: 'SET_ENV_VAR', params: { key: a.key, value: a.value, description: a.description } }),
  list_env_vars: () => ({ action: 'LIST_ENV_VARS', params: {} }),
  delete_env_var: (a) => ({ action: 'DELETE_ENV_VAR', params: { key: a.key } }),

  // Auth lifecycle
  reset_end_user_password: (a) => ({ action: 'RESET_PASSWORD', params: { userId: a.userId, email: a.email } }),
  block_end_user: (a) => ({ action: 'BLOCK_USER', params: { userId: a.userId, email: a.email } }),
  unblock_end_user: (a) => ({ action: 'UNBLOCK_USER', params: { userId: a.userId, email: a.email } }),
  disable_oauth_provider: (a) => ({ action: 'DISABLE_PROVIDER', params: { provider: a.provider } }),
  remove_permission: (a) => ({ action: 'REMOVE_PERMISSION', params: { tableName: a.tableName } }),

  // IAM (platform API keys)
  create_api_key: (a) => ({ action: 'CREATE_KEY', params: { description: a.description, permissions: a.permissions } }),
  revoke_api_key: (a) => ({ action: 'REVOKE_KEY', params: { keyId: a.keyId } }),
  rotate_api_key: (a) => ({ action: 'ROTATE_KEY', params: { keyId: a.keyId } }),
  set_key_permissions: (a) => ({ action: 'SET_KEY_PERMISSIONS', params: { keyId: a.keyId, permissions: a.permissions } }),

  // Integrations
  store_integration_key: (a) => ({ action: 'STORE_INTEGRATION_KEY', params: { integrationId: a.integrationId, apiKey: a.apiKey, label: a.label } }),
  remove_integration_key: (a) => ({ action: 'REMOVE_INTEGRATION_KEY', params: { integrationId: a.integrationId } }),
  delete_trigger: (a) => ({ action: 'DELETE_TRIGGER', params: { triggerId: a.triggerId, name: a.name } }),

  // Functions lifecycle
  toggle_ai_function: (a) => ({ action: 'TOGGLE_AI_FUNCTION', params: { functionId: a.functionId, name: a.name, active: !!a.active } }),
  delete_ai_function: (a) => ({ action: 'DELETE_AI_FUNCTION', params: { functionId: a.functionId, name: a.name } }),
  delete_cron_job: (a) => ({ action: 'DELETE_CRON_JOB', params: { jobId: a.jobId, name: a.name } }),

  // Monitoring
  set_alert: (a) => ({
    action: 'SET_ALERT',
    params: { type: a.type, threshold: a.threshold, windowMinutes: a.windowMinutes, channel: a.channel || 'dashboard' },
  }),
}

const FIX_TARGET_TO_ACTION: Record<string, AIAction['action']> = {
  auth: 'FIX_AUTH',
  api: 'FIX_API',
  table: 'FIX_TABLE',
  deploy: 'FIX_DEPLOY',
  realtime: 'FIX_REALTIME',
  storage: 'FIX_STORAGE',
  integration: 'FIX_INTEGRATION',
  workflow: 'FIX_WORKFLOW',
}

/**
 * Pre-flight argument validation. Runs BEFORE the user-visible tool_start
 * event, so a malformed model call (e.g. fix_backend without a tableName) is
 * caught privately — the model receives a corrective tool response and the
 * user never sees a misleading "Repairing X — tableName is required" line in
 * their chat. This is the standard funded-platform pattern: the model gets to
 * iterate against the validator in private; users only see real work.
 */
function preflightValidate(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext,
): ToolResult | null {
  switch (name) {
    case 'fix_backend': {
      const target = typeof args.target === 'string' ? args.target : ''
      if (!target) {
        return { ok: false, summary: 'fix_backend requires `target` (auth|api|table|deploy|realtime|storage|integration|workflow).' }
      }
      // Targets that act on a SPECIFIC resource must name that resource.
      // 'auth' / 'deploy' / 'storage' are project-scoped and need no tableName.
      const needsTable = new Set(['table', 'api', 'realtime', 'workflow'])
      if (needsTable.has(target) && !args.tableName) {
        return {
          ok: false,
          summary:
            `fix_backend(target="${target}") needs a tableName. ` +
            `Either pass tableName, or — if no table is broken — use create_table / generate_api / enable_realtime to BUILD instead of fix_backend.`,
        }
      }
      // ── In-turn gate ──────────────────────────────────────────────────
      // If this same turn just created the table, fix_backend on it is the
      // "repair what I just built" anti-pattern: the model saw run_test fail
      // (usually a 42501 RLS-denied, which is correct behaviour) and concluded
      // the table is broken. It is not.
      const tn = typeof args.tableName === 'string' ? args.tableName : ''
      if (tn && ctx.createdThisTurn?.has(tn)) {
        return {
          ok: false,
          summary:
            `fix_backend rejected: \`${tn}\` was created in this same turn. ` +
            `If run_test returned 401/403/permission_denied (Postgres code 42501), that is RLS doing its job — the table is healthy and the API is wired. Call finish with a truthful summary.`,
        }
      }
      return null
    }
    case 'create_table': {
      // `users` is platform-managed: enable_auth creates and owns it (email,
      // password hash, sessions). A hand-rolled users table shadows it, gets
      // RLS/realtime applied to the auth surface, and splits identity across
      // two tables. The blueprint validator already renames users → profiles;
      // this guard closes the same hole on the agent-loop path.
      const tn = String(args.tableName ?? '').trim().toLowerCase()
      if (tn === 'users') {
        return {
          ok: false,
          summary:
            'create_table rejected: `users` is platform-managed — enable_auth creates and owns it. ' +
            'Create a `profiles` table for extra identity fields (name, role, avatar_url, …) with a unique user_id uuid column instead, ' +
            'and tell the user their users table maps to auth + profiles.',
        }
      }
      return null
    }
    case 'generate_function': {
      const trigger = String(args.trigger || 'http').toLowerCase()
      const dbEvents = new Set(['on_insert', 'on_update', 'on_delete'])
      if (dbEvents.has(trigger) && !(typeof args.table === 'string' && args.table.trim())) {
        return {
          ok: false,
          summary:
            `generate_function(trigger="${trigger}") needs a \`table\` — the table whose row ` +
            `${trigger.replace('on_', '')} events fire the function. Pass the table name, or use ` +
            `trigger="http" for a callable endpoint / trigger="on_signup" for a signup hook.`,
        }
      }
      const desc = typeof args.description === 'string' ? args.description.trim() : ''
      if (desc.length < 12) {
        return {
          ok: false,
          summary: 'generate_function needs a concrete `description` (≥12 chars) of what the function should do — name the tables and integrations it touches.',
        }
      }
      return null
    }
    default:
      return null
  }
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  const title = humanTitle(name, args)

  // ── Pre-flight: catch malformed tool calls before they leak to the user ──
  // The LLM occasionally fires fix_backend(target='table') without a tableName.
  // Emitting "Repairing table" to the user before the executor rejects the
  // call is misleading — the user sees a "repair" attempt that never had a
  // chance of running. Validate first, return silently, let the model retry.
  const preflight = preflightValidate(name, args, ctx)
  if (preflight) return preflight

  ctx.onToolEvent?.({ phase: 'start', tool: name as ToolName, title })

  const finalize = (r: ToolResult): ToolResult => {
    ctx.onToolEvent?.({
      phase: r.ok ? 'done' : 'fail',
      tool: name as ToolName,
      title,
      detail: r.summary,
    })
    return r
  }

  try {
    // ── Read ──────────────────────────────────────────────────────────────
    if (name === 'read_backend_state') {
      const proof = await collectProof(ctx.projectId)
      return finalize({
        ok: true,
        summary: clip(formatProof(proof)),
        data: {
          tables: proof.tables,
          apis: proof.apis?.map(a => `${a.method} ${a.path}`),
          authEnabled: proof.authEnabled,
          authProviders: proof.authProviders,
          buckets: proof.buckets,
          rlsPolicies: proof.rlsPolicies,
          integrations: proof.integrations,
          realtimeTables: proof.realtimeTables,
          nothingBuilt: proof.nothingBuilt,
        },
      })
    }

    // ── Read: agent workflow primer ───────────────────────────────────────
    if (name === 'get_instructions') {
      const pid = ctx.projectId
      const base = `https://backenly.com/api/v1/${pid}`
      // ── Every tool named below MUST be one the manifest advertises ───────────
      //
      // This guide used to instruct agents to call `get_backend_metadata`,
      // `get_table_schema`, `list_tables`, `create_table`, `add_column`,
      // `create_index`, `add_rls`, `create_trigger`, `db_query`, `get_metrics`,
      // `get_errors`, `get_readiness`, `get_deploy_status`, `create_cron_job`,
      // `enable_teams` and `connect_frontend`. It was written before the 26→1
      // read-tool collapse and never updated.
      //
      // Those names still DISPATCH, which is why the drift went unnoticed
      // internally — but an MCP host can only call what the manifest advertises,
      // so from the agent's side they simply do not exist. It read a "Golden
      // rule: get_backend_metadata → get_table_schema before you write" that was
      // impossible to follow, in a document whose whole purpose is to stop it
      // guessing. Reported from a real session on 2026-07-22.
      //
      // MCP_SURFACE in lib/mcp/catalog.ts is the source of truth for this list,
      // and mcp-instructions-conformance.test.ts fails the build if this guide
      // names anything outside it.
      const guide = [
        '# Working with this Backenly backend (for coding agents)',
        '',
        'Backenly is an autonomous backend. You describe intent; it manages the backend safely. Follow this workflow so you never guess.',
        '',
        '## 1. Ground yourself (always, before acting)',
        '- `read_backend_state` with NO arguments — the grounding overview: tables, APIs, auth, storage, RLS.',
        '- `read_backend_state { section: "schema" }` — every table with record counts + all foreign-key relationships. Record counts reveal one-to-many joins (use COUNT(DISTINCT …), never a naive COUNT(*) over a join).',
        '- `get_table_schema { tableName }` — BEFORE any query/insert/migration on a table. Columns (type/nullable/default/PK), foreign keys, indexes, CHECK constraints WITH THEIR EXACT ALLOWED VALUES, triggers, and the live RLS policies. Reading this is what stops a write failing on a constraint you could have seen.',
        '- Other sections: `tables`, `apis`, `functions`, `rls`, `triggers`, `keys`, `users`, `buckets`, `files`, `cron`, `env`, `integrations`, `webhooks`, `metrics`, `errors`, `usage`, `deploy`, `readiness`, `findings`, `incidents`, `autonomy`, `realtime`.',
        '',
        '## 2. Build',
        '- `apply_migration { sql }` for schema. Ordinary PostgreSQL DDL: CREATE TABLE, ALTER TABLE ADD COLUMN / RENAME COLUMN / ADD CONSTRAINT, CREATE INDEX. Multiple statements, semicolon-separated. Your DDL is applied AS WRITTEN — declared NOT NULL, DEFAULT and nullability are honoured exactly, and `id`/`created_at`/`updated_at` are provisioned for you (declaring them is skipped and reported).',
        '- `backend_chat { message }` for anything not expressible as DDL — auth rules, RLS policies, triggers, cron jobs, teams, webhooks, integrations — or for anything you would rather describe than specify ("add likes and comments to posts"). The brain plans, executes and verifies.',
        '- Named capability tools: `enable_auth`, `create_bucket`, `generate_api`, `generate_function`, `enable_realtime`, `create_api_key`, `set_env_var`.',
        '- **Unsure about a migration? Stage it.** `branch { action: "create", name: "add-payments" }` clones this project\'s schema AND data into an isolated PostgreSQL schema. Build against it, `branch { action: "diff", branchId }` to see exactly what would land, then `branch { action: "merge", branchId }`. `branch { action: "list" }` for ids. Up to 5 active. A merge applies new tables through the governed kernel and returns added columns / type changes / drops as review items rather than reshaping a live column silently. Discarding a branch is destructive — ask via `backend_chat`.',
        '- A table is served over REST as soon as it exists — exposure is derived from the live catalog, so there is no separate "generate the API" step for plain CRUD. `generate_api` adds domain endpoints beyond CRUD.',
        '',
        '## 3. Data',
        '- `run_query { sql }` — read-only SQL over this project\'s schema: joins, GROUP BY, aggregates, window functions, CTEs, EXPLAIN. Tables are already in scope (`SELECT * FROM posts`, not `workspace_x.posts`). One statement per call; results capped (default 200, max 1000) with `truncated` telling you if more exist; password/token/key columns come back as `[redacted]`. It cannot write and cannot read another project\'s data. System catalogs (`pg_*`, `information_schema`) are refused — they are instance-wide, not per-project; use `get_table_schema` instead.',
        '- `db_insert { table, row }`, `db_update { table, filter, patch }`, `db_delete { table, filter }` — operate as the project owner and bypass end-user RLS, for seeding and maintenance. Filters are column→value maps; operators: $gt,$gte,$lt,$lte,$ne,$in,$contains,$ilike. update/delete REQUIRE a non-empty filter.',
        '- Respect foreign keys: insert parent rows first (`get_table_schema` shows the FK targets).',
        '',
        '## 4. The runtime API (the app you build)',
        `- Base URL: \`${base}\``,
        '- Header `x-api-key: <sk_live_… runtime key>` on every call.',
        '- End-user auth: `POST /auth/signup` and `POST /auth/signin` → `{ token }`. Send that token as header **`X-User-Token: <token>`** on data calls — RLS then scopes rows to that user. (An API key alone is NOT a user; owner writes without a user token are correctly denied on own-rows tables.)',
        '- **CRUD paths — one form only:** `GET /db/<table>`, `POST /db/<table>`, `GET /db/<table>/<id>`, `PUT /db/<table>/<id>`, `DELETE /db/<table>/<id>`. The `/db/` prefix is required. There is no bare `/<table>` route.',
        '- PostgREST grammar is also available at `/api/v2/<projectId>/<table>` — `?select=*,author(*)`, `?price=gte.100`, `?order=created_at.desc`. Same auth, same RLS.',
        '- Functions: `GET/POST /fn/<name>`. Function names are normalised to lowercase kebab-case (`list_products` deploys as `list-products`); `read_backend_state { section: "functions" }` gives each one\'s exact `url`.',
        // Spelled out because the bucket-scoped shape (/storage/{bucket}/upload)
        // is what several other platforms use, and guessing it produced four
        // straight 404s that read as "storage has no runtime". A bucket is a
        // PARAMETER here, never a path segment.
        '- **Storage — buckets are a parameter, not a path segment.** There is no `/storage/<bucket>/…` route. The real endpoints: `POST /storage/upload` (multipart: `file`, `bucket`, `path`, `isPublic`) · `POST /storage/signed-upload` `{ bucket, path, contentType }` for direct-to-S3 · `POST /storage/confirm-upload` after a signed upload · `POST /storage/upload-multipart` for large files · `GET /storage/files?bucket=&prefix=` · `GET|DELETE /storage/files/<fileId>`. Works on an unpublished project.',
        '- Any /api/v1 path with no handler answers with JSON `{ error, code: "ROUTE_NOT_FOUND", availableRoutes }` — if you get one, the response names the routes that do exist. Never retry the same shape.',
        '',
        '## 5. Operations that need a human (and how to get them done)',
        '- These are NOT executed directly over MCP. Describe what you want via `backend_chat`; you get back an `approval` id parked in the project\'s Review Queue, then poll `check_approval { id }` until it reports executed or rejected. The operation DOES happen — a human just confirms it first.',
        '- The full list: dropping a table or column · truncating a table · deleting a bucket or file · **publishing/deploying the backend** · **deleting a function, trigger, or cron job** · revoking or rotating an API key · deleting an env var · disabling realtime · rolling back a deploy.',
        '- So "I need to deploy" and "delete this function" both have a path — it runs through `backend_chat`, not a dedicated tool. There is no tool for them by design, not by omission.',
        '',
        '## 6. Ship',
        '- `read_backend_state { section: "readiness" }` first — the behavioural + security scorecard, with the exact blockers. Publishing runs this gate anyway and refuses on blockers, so reading it first saves a round trip.',
        '- To publish: `backend_chat { message: "publish the backend" }` → approval id → `check_approval`.',
        '- `read_backend_state { section: "deploy" }` for current state.',
        '- Your backend is fully usable BEFORE publishing — `/db/*`, `/auth/*`, `/fn/*`, `/storage/*` and `/realtime/*` all work against an unpublished project with a valid API key. Publishing is about versioning and going public, not about switching the API on.',
        '',
        '## 7. Debugging a function',
        '- `read_backend_state { section: "functions" }` returns each function\'s SOURCE, its `lastError`, its exact public `url` and its recent runs. You never need to regenerate a function to find out what it contains.',
        '- Functions answer with their real HTTP status. A 4xx/5xx from `/fn/<name>` is the handler\'s own status, not a transport error.',
        '',
        'Golden rule: read before you write — `read_backend_state`, then `get_table_schema` for each table you are about to touch. A CHECK constraint you did not look at is the most common way a correct-looking insert fails.',
      ].join('\n')
      return finalize({ ok: true, summary: guide, data: { projectId: pid, apiBase: base } })
    }

    // ── Read: full structured backend metadata (complete agent context) ────
    if (name === 'get_backend_metadata' || name === 'get_project_overview') {
      const { getBackendMetadata } = await import('@/lib/mcp/schema-introspection')
      const meta = await getBackendMetadata(ctx.projectId)
      const tableLines = meta.tables.length
        ? meta.tables
            .map((t) => `• **${t.name}** — ${t.recordCount} rows · ${t.columns} cols · RLS ${t.rlsEnabled ? `on (${t.policyCount} policies)` : 'off'}`)
            .join('\n')
        : '_No tables yet._'
      const relLines = meta.relationships.length
        ? meta.relationships.map((r) => `• ${r.from}.${r.column} → ${r.to}.${r.toColumn}`).join('\n')
        : '_No foreign-key relationships._'
      const summary =
        `**Backend metadata**\n\n` +
        `**Tables (${meta.tables.length})**\n${tableLines}\n\n` +
        `**Relationships**\n${relLines}\n\n` +
        `**Auth:** ${meta.auth.enabled ? meta.auth.providers.join(', ') || 'enabled' : 'disabled'} · ` +
        `**Storage:** ${meta.storage.buckets.length} bucket(s) · ` +
        `**Realtime:** ${meta.realtime.tables.length} table(s) · ` +
        `**Functions:** ${meta.functions.count}`
      return finalize({ ok: true, summary: clip(summary), data: meta })
    }

    // ── Read: table list from the LIVE catalog (single source of truth) ────
    // Previously routed through the LIST_TABLES executor, which read prisma.table
    // metadata that could disagree with the real schema (an agent would then
    // query a table that no longer existed). Now derived from information_schema.
    if (name === 'run_query') {
      const { runReadQuery, ReadQueryError } = await import('@/lib/mcp/read-query')
      const sql = typeof args.sql === 'string' ? args.sql : ''
      try {
        const r = await runReadQuery(
          ctx.projectId,
          sql,
          typeof args.limit === 'number' ? args.limit : undefined,
        )
        const summary =
          r.rowCount === 0
            ? 'Query returned no rows.'
            : `${r.rowCount} row(s)` +
              (r.truncated ? ' (truncated — more rows exist; add a LIMIT or narrow the query)' : '') +
              (r.redactedColumns.length ? ` · redacted: ${r.redactedColumns.join(', ')}` : '')
        return finalize({ ok: true, summary, data: r })
      } catch (err) {
        // A refused statement is a contract answer the model can act on, not a
        // crash — hand back the hint so it retries correctly rather than blindly.
        if (err instanceof ReadQueryError) {
          return finalize({
            ok: false,
            summary: err.message + (err.hint ? ` ${err.hint}` : ''),
            data: { code: err.code, hint: err.hint ?? null },
          })
        }
        throw err
      }
    }

    if (name === 'list_tables') {
      const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
      const tables = await listExposedTables(ctx.projectId)
      if (tables.length === 0) {
        return finalize({
          ok: true,
          summary: "You don't have any tables yet. Try creating one: 'Create a users table'",
          data: { tables: [] },
        })
      }
      const lines = tables
        .map((t) => `• **${t.name}** — ${t.recordCount} rows · ${t.columns} cols · RLS ${t.rlsEnabled ? 'on' : 'off'}`)
        .join('\n')
      return finalize({
        ok: true,
        summary: clip(`📊 **Your Tables (${tables.length}):**\n\n${lines}`),
        data: { tables },
      })
    }

    // ── Read: REST APIs derived from the LIVE catalog (auto-exposure) ──────
    // Every exposed table HAS a full REST API — the API surface is a projection
    // of the schema, never a separate ApiDefinition record that can drift. Was:
    // LIST_APIS executor reading prisma.apiDefinition.
    if (name === 'list_apis') {
      const { listExposedTables, isAuthManagedTable } = await import('@/lib/mcp/schema-introspection')
      const tables = (await listExposedTables(ctx.projectId)).filter((t) => !isAuthManagedTable(t.name))
      // `basePath` is the FULL path a client calls. It used to be `/${t.name}`,
      // a fragment that matches no route — the same wrong path `generate_api`
      // reported and the 404 handler repeated. An agent reading this field built
      // a client against `/products` and got a 404 with no clue why.
      const apis = tables.map((t) => ({
        name: t.name,
        basePath: `/api/v1/${ctx.projectId}/db/${t.name}`,
        enabled: true,
        operations: { get: true, list: true, create: true, update: true, delete: true, bulk: true, search: true },
      }))
      if (apis.length === 0) {
        return finalize({
          ok: true,
          // "No tables yet" is the only honest reading of an empty list here,
          // because exposure is DERIVED from the catalog — there is no separate
          // generation step that could have been skipped. If you created tables
          // and this is still empty, the tables are not in the catalog, which is
          // a real fault worth saying out loud rather than papering over.
          summary:
            'No tables are exposed. Every table is auto-exposed the moment it exists — ' +
            'so if you have just created tables and this is empty, the create did not ' +
            'take effect. Check read_backend_state { section: "tables" }.',
          data: { apis: [] },
        })
      }
      const lines = apis.map((a) => `✅ **${a.basePath}** — GET · LIST · CREATE · UPDATE · DELETE · SEARCH · BULK`).join('\n')
      return finalize({
        ok: true,
        summary: clip(`🚀 **Your APIs (${apis.length}):**\n\n${lines}\n\nEvery table is auto-exposed at \`/api/v1/${ctx.projectId}/db/<table>\`.`),
        data: { apis },
      })
    }

    // ── Read: full RLS-aware schema for one table ──────────────────────────
    if (name === 'get_table_schema') {
      const table = String(args.tableName ?? '').trim()
      if (!table) return finalize({ ok: false, summary: 'get_table_schema needs a `tableName`.' })
      const { getTableSchema } = await import('@/lib/mcp/schema-introspection')
      try {
        const s = await getTableSchema(ctx.projectId, table)
        const cols = s.columns
          .map((c) => `  • ${c.name} ${c.type}${c.primaryKey ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` default ${c.default}` : ''}`)
          .join('\n')
        const checks = s.checkConstraints.length
          ? '\n**Constraints:**\n' + s.checkConstraints.map((c) => `  • ${c.definition}`).join('\n')
          : ''
        const fks = s.foreignKeys.length
          ? '\n**Foreign keys:**\n' + s.foreignKeys.map((f) => `  • ${f.column} → ${f.references}`).join('\n')
          : ''
        const rls = s.rlsEnabled
          ? `\n**RLS:** enabled${s.forceRls ? ' (FORCE)' : ''} · ${s.policies.length} policies`
          : '\n**RLS:** disabled'
        const summary =
          `**${s.table}** — ${s.recordCount} rows\n\n**Columns:**\n${cols}${fks}${checks}${rls}`
        return finalize({ ok: true, summary: clip(summary), data: s })
      } catch (e: any) {
        return finalize({ ok: false, summary: e?.message ?? `Could not read schema for "${table}".` })
      }
    }

    // ── Preview branches ───────────────────────────────────────────────────
    // Direct calls into lib/branches/engine.ts — there is no executor action
    // for these, so they do not go through TOOL_TO_ACTION.
    if (name === 'create_branch' || name === 'list_branches' || name === 'diff_branch' ||
        name === 'merge_branch' || name === 'discard_branch') {
      const engine = await import('@/lib/branches/engine')

      if (name === 'list_branches') {
        const branches = await engine.listBranches(ctx.projectId)
        if (!branches.length) {
          return finalize({
            ok: true,
            summary: 'No preview branches. Create one with create_branch before a migration you are unsure about — it is a full clone and costs nothing to throw away.',
            data: { branches: [] },
          })
        }
        const lines = branches.map((b: any) => `  • ${b.name} (${b.status}) — id ${b.id}`).join('\n')
        return finalize({ ok: true, summary: `**Preview branches (${branches.length}):**\n${lines}`, data: { branches } })
      }

      if (name === 'create_branch') {
        const branchName = String(args.name ?? '').trim()
        if (!branchName) return finalize({ ok: false, summary: 'create_branch needs a `name`.' })
        const res = await engine.createBranch(ctx.projectId, ctx.userId ?? '', branchName)
        if (!res.ok) return finalize({ ok: false, summary: res.error })
        return finalize({
          ok: true,
          summary: `Created preview branch "${branchName}" — ${res.tablesCloned} table(s) cloned. Diff it with diff_branch { branchId: "${res.branch.id}" } and merge when you are happy.`,
          data: { branch: res.branch, tablesCloned: res.tablesCloned },
        })
      }

      const branchId = String(args.branchId ?? '').trim()
      if (!branchId) return finalize({ ok: false, summary: `${name} needs a \`branchId\` — get it from list_branches.` })

      if (name === 'diff_branch') {
        // This tsconfig has strictNullChecks off, so a boolean `ok` does not
        // narrow the union — cast the failure arm explicitly (same reason
        // mergeBranch re-shapes its early return).
        const res = await engine.diffBranch(ctx.projectId, branchId)
        if (!res.ok) return finalize({ ok: false, summary: (res as { ok: false; error: string }).error })
        const d: any = (res as Extract<typeof res, { ok: true }>).diff
        const parts: string[] = []
        if (d.addedTables?.length) parts.push(`Tables added: ${d.addedTables.map((t: any) => t.tableName).join(', ')}`)
        if (d.droppedTables?.length) parts.push(`Tables dropped: ${d.droppedTables.join(', ')}`)
        for (const a of d.altered ?? []) {
          if (a.addedColumns?.length) parts.push(`${a.table}: +${a.addedColumns.map((c: any) => c.name).join(', +')}`)
          if (a.droppedColumns?.length) parts.push(`${a.table}: -${a.droppedColumns.join(', -')}`)
          for (const tc of a.typeChanged ?? []) parts.push(`${a.table}.${tc.column}: ${tc.from} → ${tc.to}`)
        }
        return finalize({
          ok: true,
          summary: parts.length ? `**${res.branch} vs main:**\n  • ${parts.join('\n  • ')}` : `"${res.branch}" is identical to main.`,
          data: res.diff,
        })
      }

      if (name === 'merge_branch') {
        const res = await engine.mergeBranch(ctx.projectId, ctx.userId ?? '', branchId)
        if (!res.ok) return finalize({ ok: false, summary: (res as any).error })
        const r: any = res
        const applied = r.applied?.length ? `Applied: ${r.applied.join('; ')}.` : 'Nothing was applied automatically.'
        const review = r.review?.length
          ? ` ${r.review.length} change(s) need the governed path rather than an automatic apply — a merge never reshapes a live column silently:\n  • ${r.review.join('\n  • ')}`
          : ''
        return finalize({
          ok: true,
          summary: `Merge of "${r.branch}" ${r.fullyMerged ? 'complete' : 'partial'}. ${applied}${review}`,
          data: r,
        })
      }

      // discard_branch — DESTRUCTIVE; the brain's gate parks it for approval
      // before it ever reaches here.
      const res = await engine.discardBranch(ctx.projectId, ctx.userId ?? '', branchId)
      if (!res.ok) return finalize({ ok: false, summary: (res as any).error })
      return finalize({ ok: true, summary: 'Branch discarded. Main is untouched.', data: res })
    }

    // ── Control: finish ───────────────────────────────────────────────────
    if (name === 'finish') {
      return finalize({
        ok: true,
        summary: String(args.summary ?? 'Done.'),
        terminal: true,
        needsUser: !!args.needsUser,
        data: { needsUser: !!args.needsUser },
      })
    }

    // ── Control: ask_user ─────────────────────────────────────────────────
    if (name === 'ask_user') {
      const q = String(args.question ?? 'Could you clarify what you\'d like me to do?')
      const opts = Array.isArray(args.options) ? (args.options as unknown[]).map(String).slice(0, 4) : []
      const summary = opts.length
        ? `${q}\n\n${opts.map(o => `• ${o}`).join('\n')}`
        : q
      return finalize({
        ok: true,
        summary,
        terminal: true,
        needsUser: true,
        data: { question: q, options: opts, kind: 'ask_user' },
      })
    }

    // ── Control: propose_plan ─────────────────────────────────────────────
    if (name === 'propose_plan') {
      const title = String(args.title ?? 'Proposed plan')
      const steps = Array.isArray(args.steps) ? args.steps as Array<{ label?: string; tool?: string; destructive?: boolean }> : []
      const warnings = Array.isArray(args.warnings) ? (args.warnings as unknown[]).map(String) : []
      const blast = String(args.blastRadius ?? 'medium')

      const lines = [
        `**${title}**`,
        '',
        ...steps.map((s, i) => `${i + 1}. ${s.label}${s.destructive ? ' · destructive' : ''}`),
        ...(warnings.length ? ['', '**Notes**', ...warnings] : []),
        '',
        'Reply "go ahead" to run this, or tell me what to change.',
      ]
      return finalize({
        ok: true,
        summary: lines.join('\n'),
        terminal: true,
        needsUser: true,
        data: { kind: 'plan_proposal', title, steps, warnings, blastRadius: blast },
      })
    }

    // ── Control: answer_question ──────────────────────────────────────────
    if (name === 'answer_question') {
      const question = String(args.question ?? ctx.userMessage ?? '').trim()
      const openai = getOpenAIClient()
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: answererPrompt() },
      ]
      if (ctx.understandingBlock) {
        messages.push({ role: 'system', content: `THIS PROJECT:\n${ctx.understandingBlock}` })
      }
      messages.push({ role: 'user', content: question || 'Can you help me?' })

      try {
        const completion = await openai.chat.completions.create({
          model: getModel('respond'),
          messages,
          temperature: 0.3,
          max_tokens: 600,
        })
        if (ctx.projectId) trackCompletionCost(completion, ctx.projectId, 'brain-answer')
        const text = completion.choices[0]?.message?.content?.trim() ?? 'I don\'t have a confident answer for that.'
        return finalize({
          ok: true,
          summary: text,
          terminal: true,
          data: { kind: 'answer' },
        })
      } catch (err) {
        return finalize({
          ok: false,
          summary: 'I hit an error trying to answer that. Could you try again?',
        })
      }
    }

    // ── Autonomy: read dial + trust report ────────────────────────────────
    if (name === 'get_autonomy_status') {
      const { buildTrustReport } = await import('@/lib/autonomy/trust-report')
      const windowDays = Math.max(1, Math.min(90, Number(args.windowDays ?? 30)))
      const report = await buildTrustReport(ctx.projectId, windowDays).catch(() => null)
      if (!report) {
        return finalize({
          ok: false,
          summary: 'Could not read the autonomy status right now — try again in a moment.',
        })
      }
      const s = report.scoreboard
      const pending = report.pendingApprovals.length
      const verifiedPct =
        s.verifiedRate === null ? '—' : `${Math.round(s.verifiedRate * 100)}%`
      const capLine =
        report.cap === report.level
          ? ''
          : `\nPlan ceiling: **${report.cap}** (raising beyond this requires upgrading).`
      const summary =
        `Autonomy: **${report.level}** (window: ${windowDays}d)\n` +
        `Self-applied: ${s.autonomousFixes} · ` +
        `Awaiting approval: ${pending} · ` +
        `Escalated: ${s.escalations} · ` +
        `Rollbacks: ${s.rollbacks} · ` +
        `Verified: ${verifiedPct} · ` +
        `Breaker trips: ${s.breakerTrips}` +
        capLine
      return finalize({
        ok: true,
        summary,
        data: {
          level: report.level,
          cap: report.cap,
          windowDays,
          report,
        },
      })
    }

    // ── Autonomy: set dial ────────────────────────────────────────────────
    if (name === 'set_autonomy_level') {
      const {
        clampToPlan,
        coerceAutonomyLevel,
        getProjectAutonomyCap,
      } = await import('@/lib/autonomy/autonomy-level')
      const { prisma } = await import('@/lib/db/prisma')
      const requested = coerceAutonomyLevel(args.level)
      if (!requested) {
        return finalize({
          ok: false,
          summary: 'Level must be one of: OFF, CONSERVATIVE, BALANCED, AGGRESSIVE.',
        })
      }
      const cap = await getProjectAutonomyCap(ctx.projectId)
      const level = clampToPlan(requested, cap)
      const clamped = level !== requested

      await prisma.project.update({
        where: { id: ctx.projectId },
        data: { autonomyLevel: level },
      })
      // Audit the EFFECTIVE level. If clamped, record the attempt + cap so the
      // history is honest about what actually happened.
      if (ctx.userId) {
        await prisma.auditLog.create({
          data: {
            projectId: ctx.projectId,
            userId: ctx.userId,
            action: 'AUTONOMY_LEVEL_CHANGED',
            type: 'autonomy',
            details: JSON.stringify({
              level,
              ...(clamped ? { requested, cap, clampedByPlan: true } : {}),
              at: new Date().toISOString(),
              source: 'brain',
            }),
            timestamp: new Date(),
          },
        }).catch(() => {})
      }

      // Speak product mode names (Off / Review-only / Autopilot — the 3-mode
      // dial, 2026-07-18), never the internal enum values. Legacy BALANCED
      // reads as Autopilot.
      const modeName = (l: string) =>
        l === 'OFF' ? 'Off' : l === 'CONSERVATIVE' ? 'Review-only' : 'Autopilot'

      // Plan-cap explanations — keep the chat honest: tell them their
      // effective mode + how to lift the cap (defence in depth; no current
      // plan caps the dial).
      if (clamped) {
        return finalize({
          ok: true,
          summary:
            `Set to **${modeName(level)}** — your plan's ceiling is **${modeName(cap)}**, so **${modeName(requested)}** can't be applied. ` +
            'Upgrade to Pro ($25/mo) to unlock the full dial.',
          data: { level, requested, cap, clamped: true },
        })
      }

      const tail =
        level === 'OFF'
          ? 'The loop will observe and report but will not auto-apply anything.'
          : level === 'CONSERVATIVE'
            ? 'Every prepared fix waits for one-click approval — nothing applies on its own.'
            : 'The loop heals everything safe on its own. Auth, external-credential and destructive changes still require explicit approval.'
      return finalize({
        ok: true,
        summary: `✅ Autonomy set to **${modeName(level)}**. ${tail}`,
        data: { level, cap, clamped: false },
      })
    }

    // ── Push integration: connect OneSignal ───────────────────────────────
    if (name === 'enable_push_notifications') {
      const { dispatchIntegration } = await import('@/lib/integrations')
      const result = await dispatchIntegration('onesignal', ctx.projectId, {
        appId: args.appId,
        restApiKey: args.restApiKey,
      })
      if (!result.success && result.needsCredentials) {
        // No credentials yet — let the brain ask the user for them.
        return finalize({
          ok: false,
          summary: result.message,
          needsUser: true,
          data: { needsCredentials: true, hint: result.credentialHint },
        })
      }
      return finalize({ ok: result.success, summary: clip(result.message) })
    }

    // ── Auth: add an OAuth sign-in provider (credential-gated) ────────────
    // The executor needs the project's OAuth client ID + secret. If the model
    // did not pass them, we either confirm the provider is already configured
    // or stop the turn and ask the user — exactly like the credential flow for
    // push notifications. This is why add_oauth_provider is NOT a plain
    // TOOL_TO_ACTION passthrough.
    if (name === 'add_oauth_provider') {
      const provider = String(args.provider ?? '').trim().toLowerCase()
      const clientId = typeof args.clientId === 'string' ? args.clientId.trim() : ''
      const clientSecret = typeof args.clientSecret === 'string' ? args.clientSecret.trim() : ''
      const cap = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'that provider'

      if (!provider) {
        return finalize({ ok: false, summary: 'Which OAuth provider? Supported: google, github, discord, facebook, apple.' })
      }

      if (!clientId || !clientSecret) {
        // No credentials in this call — is the provider already wired up?
        let alreadyConfigured = false
        try {
          const { WorkspaceOAuthService } = await import('@/lib/services/workspaceOAuth')
          const existing = await WorkspaceOAuthService.getConfig(ctx.projectId, provider)
          alreadyConfigured = !!existing?.enabled
        } catch { /* fall through to ask */ }

        if (alreadyConfigured) {
          return finalize({
            ok: true,
            summary: `${cap} sign-in is already configured for this project — end-users can sign in with ${cap} now. Nothing to change.`,
          })
        }

        // Stop the turn and ask the owner for credentials.
        return finalize({
          ok: false,
          summary:
            `To turn on **${cap} sign-in** I need your ${cap} OAuth credentials. ` +
            `Create an OAuth app in the ${cap} developer console, then paste the **Client ID** and **Client Secret** here — ` +
            `I'll wire it into your backend and confirm it's live.`,
          terminal: true,
          needsUser: true,
          data: { kind: 'needs_oauth_credentials', provider },
        })
      }

      // Credentials present — run the executor end-to-end.
      return finalize(await runExecutor(
        { action: 'ADD_PROVIDER', params: { provider, clientId, clientSecret } },
        ctx,
      ))
    }

    // ── Webhook delivery replay (DEAD → re-attempt) ───────────────────────
    if (name === 'replay_webhook_delivery') {
      const { replayDelivery } = await import('@/lib/services/trigger-service')
      const id = String(args.id ?? '')
      if (!id) return finalize({ ok: false, summary: '`id` is required (from list_webhook_deliveries).' })
      const result = await replayDelivery(ctx.projectId, id)
      if (!result.success) {
        return finalize({ ok: false, summary: `Replay failed: ${result.error ?? 'unknown error'}` })
      }
      return finalize({
        ok: true,
        summary:
          `✅ Replayed delivery \`${id}\`. The webhook was re-signed with the current secret and sent again. ` +
          `Use list_webhook_deliveries to see the new attempt's status.`,
      })
    }

    // ── Webhook delivery log (read-only) ──────────────────────────────────
    if (name === 'list_webhook_deliveries') {
      const { listDeliveryLogs } = await import('@/lib/services/trigger-service')
      const status = args.status as 'SUCCESS' | 'FAILED' | 'DEAD' | undefined
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 25)))
      const logs = await listDeliveryLogs(ctx.projectId, { status, limit })
      if (!logs || logs.length === 0) {
        return finalize({
          ok: true,
          summary: status
            ? `No webhook deliveries with status=${status} in the last ${limit}.`
            : `No webhook deliveries yet on this project.`,
          data: { deliveries: [] },
        })
      }
      const lines = logs.slice(0, 10).map((d: any) =>
        `• ${d.status} — ${d.eventType} on \`${d.table}\` — HTTP ${d.statusCode ?? 'n/a'} ` +
        `— attempt ${d.attemptCount}${d.error ? ` — ${String(d.error).slice(0, 80)}` : ''}`
      )
      return finalize({
        ok: true,
        summary:
          `Recent webhook deliveries${status ? ` (status=${status})` : ''}:\n` +
          lines.join('\n') +
          (logs.length > 10 ? `\n…and ${logs.length - 10} more. Open the deliveries tab for the full list.` : ''),
        data: { deliveries: logs.slice(0, limit) },
      })
    }

    // ── Repair: apply_proposal ────────────────────────────────────────────
    if (name === 'apply_proposal') {
      const { loadAndApplyActiveProposal } = await import('../proposals/apply')
      const report = await loadAndApplyActiveProposal({
        projectId: ctx.projectId,
        sessionToken: ctx.sessionToken,
        scope: args.scope === 'all' ? 'all' : 'executable_only',
      })
      if (!report) return finalize({ ok: false, summary: 'No active proposal to apply.' })
      return finalize({
        ok: report.failed === 0,
        summary: clip(report.markdown),
        data: { attempted: report.attempted, succeeded: report.succeeded, failed: report.failed },
      })
    }

    // ── Repair: fix_backend ───────────────────────────────────────────────
    if (name === 'fix_backend') {
      const act = FIX_TARGET_TO_ACTION[String(args.target)]
      if (!act) return finalize({ ok: false, summary: `Unknown fix target: ${args.target}` })
      return finalize(
        await runExecutor({ action: act, params: { tableName: args.tableName } }, ctx),
      )
    }

    // ── Findings: list_findings ───────────────────────────────────────────
    if (name === 'list_findings') {
      const { prisma } = await import('@/lib/db/prisma')
      const findings = await prisma.healthFinding.findMany({
        where: { projectId: ctx.projectId, status: { in: ['open', 'pending_approval'] } },
        orderBy: { detectedAt: 'desc' },
        take: 30,
      })
      if (findings.length === 0) {
        return finalize({ ok: true, summary: 'No open issues — the backend is healthy.', data: { findings: [] } })
      }
      const rows = findings.map((f) => {
        const det = (f.details ?? {}) as Record<string, unknown>
        const target = [det.tableName, det.columnName].filter(Boolean).join('.')
        return { id: f.id, type: f.type, severity: f.severity, target: target || undefined, reason: det.reason }
      })
      const listLines = rows.map(
        (r) => `- id=${r.id} | ${r.type} | ${r.severity}${r.target ? ` | ${r.target}` : ''}${r.reason ? ` | ${r.reason}` : ''}`,
      )
      return finalize({ ok: true, summary: clip(['Open issues:', ...listLines].join('\n')), data: { findings: rows } })
    }

    // ── Findings: resolve_finding ─────────────────────────────────────────
    if (name === 'resolve_finding') {
      const { resolveFindingFromChat, findResolvableFinding } = await import('@/lib/core/auto-fix-engine')
      let fid = typeof args.findingId === 'string' ? args.findingId.trim() : ''
      if (!fid) {
        const match = await findResolvableFinding(ctx.projectId, {
          findingType: typeof args.findingType === 'string' ? args.findingType : undefined,
          tableName: typeof args.tableName === 'string' ? args.tableName : undefined,
          columnName: typeof args.columnName === 'string' ? args.columnName : undefined,
        })
        if (!match) {
          return finalize({
            ok: false,
            summary:
              'No matching open issue found. Call list_findings to see exact ids, or use read_backend_state + fix_backend to repair directly.',
          })
        }
        fid = match
      }
      const res = await resolveFindingFromChat(fid, ctx.projectId, {
        confirmed: ctx.destructiveConfirmed,
        userId: ctx.userId,
      })
      // 'fixed' is success. needs_confirmation / notify / failed are surfaced as
      // ok:false so the model relays the message (asks the user to confirm, or
      // explains the manual step) rather than claiming it fixed something.
      return finalize({
        ok: res.outcome === 'fixed',
        summary: clip(res.message),
        data: { outcome: res.outcome, findingId: res.findingId, findingType: res.findingType },
      })
    }

    // ── Operator briefing: get_pending_incidents ──────────────────────────
    // The 3am dossier for a returning agent: what autonomy detected, fixed,
    // or queued since anyone last looked. Read-only aggregation.
    if (name === 'get_pending_incidents') {
      const { prisma } = await import('@/lib/db/prisma')
      const { summariseFinding } = await import('@/lib/core/finding-summaries')
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

      const [open, approvals, driftPending, autoFixed, snapshot] = await Promise.all([
        prisma.healthFinding.findMany({
          where: { projectId: ctx.projectId, status: { in: ['open', 'pending_approval'] } },
          orderBy: { detectedAt: 'desc' },
          take: 25,
        }),
        prisma.agentApprovalRequest.findMany({
          where: { projectId: ctx.projectId, status: 'pending', expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, tool: true, target: true, createdAt: true, expiresAt: true },
        }).catch(() => []),
        prisma.schemaDriftEvent.count({
          where: { projectId: ctx.projectId, status: 'pending' },
        }).catch(() => 0),
        prisma.healthFinding.findMany({
          where: { projectId: ctx.projectId, status: 'auto_fixed', fixAppliedAt: { gte: since24h } },
          orderBy: { fixAppliedAt: 'desc' },
          take: 10,
        }),
        prisma.workspaceSchemaSnapshot.findFirst({
          where: { projectId: ctx.projectId },
          orderBy: { versionNum: 'desc' },
          select: { versionNum: true, createdAt: true, tableCount: true },
        }).catch(() => null),
      ])

      const sevRank: Record<string, number> = { critical: 0, warning: 1, info: 2 }
      const openRows = open
        .sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3))
        .map((f) => ({
          id: f.id,
          type: f.type,
          severity: f.severity,
          status: f.status,
          detectedAt: f.detectedAt.toISOString(),
          summary: summariseFinding(f.type, f.details as Record<string, unknown>),
          diagnosis: ((f.details ?? {}) as Record<string, unknown>).diagnosis,
        }))
      const fixedRows = autoFixed.map((f) => ({
        type: f.type,
        fixedAt: f.fixAppliedAt?.toISOString(),
        summary: summariseFinding(f.type, f.details as Record<string, unknown>),
      }))

      // ── TWO queues wait on a human, and they are not the same queue ──────
      //
      // `agentApprovalRequest` holds destructive operations an AGENT asked for.
      // `healthFinding{status:'pending_approval'}` holds fixes the AUTONOMY LOOP
      // prepared or escalated. The Autonomy page counts the second; this
      // briefing counted only the first and labelled it "awaiting human
      // approval" — so the dashboard could say "Awaiting approval: 2 ·
      // Escalated: 2" in the same moment this said "0 awaiting human approval".
      //
      // Both numbers were correct about different things and the labels made
      // them look like one contradictory number. Count both, name both.
      const escalatedFindings = openRows.filter((r) => r.status === 'pending_approval')
      const waitingTotal = approvals.length + escalatedFindings.length

      const lines: string[] = [
        `Backend briefing: ${openRows.length} open issue${openRows.length === 1 ? '' : 's'}, ` +
        `${waitingTotal} waiting on you ` +
        `(${approvals.length} agent-requested operation${approvals.length === 1 ? '' : 's'} in the Review Queue, ` +
        `${escalatedFindings.length} autonomy fix${escalatedFindings.length === 1 ? '' : 'es'} escalated), ` +
        `${fixedRows.length} auto-fixed in the last 24h, ` +
        `${driftPending} external schema change${driftPending === 1 ? '' : 's'} pending adoption.`,
      ]
      if (openRows.length > 0) {
        lines.push('', 'Open issues (worst first):')
        for (const r of openRows.slice(0, 10)) {
          lines.push(`- [${r.severity}] ${r.summary} (id=${r.id}${r.status === 'pending_approval' ? ', escalated — waiting on your approval' : ''})`)
        }
      }
      if (approvals.length > 0) {
        lines.push('', 'Operations an agent requested, waiting in the Review Queue (only the human can approve, from the dashboard):')
        for (const a of approvals) lines.push(`- ${a.tool} on ${a.target} (id=${a.id})`)
      }
      if (fixedRows.length > 0) {
        lines.push('', 'Auto-fixed in the last 24h:')
        for (const r of fixedRows.slice(0, 5)) lines.push(`- ${r.summary}`)
      }
      if (driftPending > 0) {
        lines.push('', `${driftPending} schema change(s) arrived over a direct DB connection — call adopt_external_schema to fold them into the contract, or review under Autonomy.`)
      }
      if (snapshot) {
        lines.push('', `Latest restore point: v${snapshot.versionNum} (${snapshot.tableCount} tables, ${snapshot.createdAt.toISOString()}). Rollback is available from Autonomy → Restore points.`)
      }
      if (openRows.length === 0 && approvals.length === 0 && driftPending === 0) {
        lines.push('', 'Nothing needs attention — the backend is healthy and the loop is quiet.')
      }

      return finalize({
        ok: true,
        summary: clip(lines.join('\n'), 2400),
        data: {
          openFindings: openRows,
          /** Destructive operations an AGENT requested (agentApprovalRequest). */
          pendingApprovals: approvals,
          /** Fixes the AUTONOMY LOOP escalated (healthFinding.pending_approval). */
          escalatedFindings,
          /** The number a UI should show as "waiting on you" — the two combined. */
          waitingOnHuman: waitingTotal,
          autoFixedLast24h: fixedRows,
          pendingDriftEvents: driftPending,
          latestRestorePoint: snapshot,
        },
      })
    }

    // ── Direct access: get_database_credentials ───────────────────────────
    // READ_ONLY provisions on demand (SELECT-only role). It DOES grant more
    // reach than db_query — full SQL, not a filter DSL — which is why
    // `run_query` now exposes that same power through a governed, audited tool
    // instead of leaving a connection string as the only way to get it.
    // READ_WRITE is returned only when
    // the human already armed it in Connect → Direct: the dashboard click is
    // the consent artifact, so a scoped agent key can never self-grant DDL.
    if (name === 'get_database_credentials') {
      const mode = args.mode === 'READ_WRITE' ? 'READ_WRITE' as const : 'READ_ONLY' as const
      const da = await import('@/lib/services/direct-access')
      const status = await da.getDirectAccessStatus(ctx.projectId)
      const existing = status.credentials.find((c) => c.mode === mode)

      const describe = (c: typeof status.credentials[number], provisioned: boolean) => ({
        ok: true as const,
        summary: clip([
          `${provisioned ? 'Provisioned' : 'Existing'} ${mode === 'READ_ONLY' ? 'read-only' : 'read-write'} Postgres access: role ${c.roleName} @ ${c.host}:${c.port}/${c.database} (TLS required, search_path pinned to ${status.schema}).`,
          mode === 'READ_ONLY'
            ? 'SELECT-only — safe for inspection, EXPLAIN, BI, and pg_dump. It cannot mutate anything.'
            : 'DML + in-schema DDL. Every DDL statement you run is observed as drift — call adopt_external_schema when you finish migrating.',
          'The connection string is in data.connectionString — treat it as a secret (do not write it into code, files, or logs; reference it from env).',
        ].join('\n')),
        data: {
          mode: c.mode,
          roleName: c.roleName,
          host: c.host,
          port: c.port,
          database: c.database,
          schema: status.schema,
          connectionString: c.connectionString,
          psqlCommand: c.psqlCommand,
          pgDumpCommand: c.pgDumpCommand,
        },
      })

      if (existing) return finalize(describe(existing, false))
      if (mode === 'READ_ONLY') {
        const cred = await da.provisionDirectAccess(ctx.projectId, 'READ_ONLY')
        return finalize(describe({ ...cred }, true))
      }
      return finalize({
        ok: false,
        needsUser: true,
        code: 'WRITE_ACCESS_NOT_ARMED',
        summary:
          'Read-write database access is not enabled for this project. Only the project owner can arm it — ask them to open the dashboard → Connect → Direct and create read-write credentials (one click; every schema change over that connection is observed and adopted by the autonomy loop). Read-only access is available right now via mode=READ_ONLY.',
      })
    }

    // ── Verify: run_test ──────────────────────────────────────────────────
    if (name === 'run_test') {
      const { runEndpointTest } = await import('./verifier')
      const result = await runEndpointTest({
        projectId: ctx.projectId,
        tableName: String(args.tableName ?? ''),
        operation: (args.operation as 'list' | 'create' | 'get') ?? 'list',
        sessionToken: ctx.sessionToken,
      })
      return finalize({
        ok: result.ok,
        summary: result.summary,
        data: result,
      })
    }

    // ── Rollback ──────────────────────────────────────────────────────────
    if (name === 'rollback') {
      const steps = Math.max(1, Math.min(10, Number(args.steps ?? 1)))
      // Rollback is plumbed through the existing execution journal; for now
      // we surface that the agent should fix-forward and call out the limit.
      return finalize({
        ok: false,
        summary:
          `Rollback of ${steps} step(s) requested. The brain does not auto-rollback yet — use fix_backend or drop_table to undo manually, or ask the user for confirmation before destructive cleanup.`,
        data: { stepsRequested: steps, supported: false },
      })
    }

    // ── Mutations ─────────────────────────────────────────────────────────
    const builder = TOOL_TO_ACTION[name]
    if (builder) {
      const result = await runExecutor(builder(args), ctx)
      // Track tables created this turn so fix_backend on them is gated by the
      // pre-flight validator. Only on success — failed creates do not "exist".
      if (result.ok && name === 'create_table' && typeof args.tableName === 'string') {
        ctx.createdThisTurn?.add(args.tableName)
      }
      // Event-driven autonomy: fire a debounced reconciler kick so the loop
      // closes the FK-index / missing-API / RLS gap the mutation opened within
      // seconds, not on the next cron tick. Coalesces a chain of mutations in
      // one turn into a single probe. Fire-and-forget — never blocks the tool.
      if (result.ok && shouldKickFor(name)) {
        kickReconciler(ctx.projectId, name)
      }
      return finalize(result)
    }

    return finalize({ ok: false, summary: `Unknown tool: ${name}` })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Tool threw'
    return finalize({ ok: false, summary: clip(msg) })
  }
}

async function runExecutor(
  action: AIAction,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  // If the user authorised destructive action this turn (e.g. "yes drop it"),
  // forward `confirmed:true` so the executor's approval gate does not block on
  // a confirmation it already has via the brain layer. Brain's DESTRUCTIVE_TOOLS
  // set is the first gate; this keeps the second gate aligned.
  const params = (ctx.destructiveConfirmed || ctx.mcpOwnerConfirmed)
    ? { ...(action.params || {}), confirmed: true }
    : action.params
  const result = await executeAction({ ...action, params }, ctx.projectId, ctx.sessionToken)
  if (result.success) {
    // Engine-side confirmation gate: stop the loop and surface the prompt to
    // the user. The model must NOT keep chaining tools after this — the next
    // user message ("CONNECT" / "DISCONNECT") is what proceeds.
    const requiresConfirmation = (result.data as any)?.requiresConfirmation === true
    return {
      ok: true,
      summary: clip(result.message || 'Done.'),
      data: result.artifacts ?? result.data,
      ...(requiresConfirmation ? { terminal: true, needsUser: true } : {}),
    }
  }
  // ── `message` first, `error` second ───────────────────────────────────────
  //
  // This was the other way round, so an executor that took the trouble to write
  // "Cannot create a unique index on conversations (user_a, user_b) — the table
  // already contains duplicate rows; find them with SELECT … HAVING count(*) > 1"
  // had that replaced by the raw driver text in `error`. The actionable sentence
  // was computed and then thrown away in favour of the one the agent cannot act
  // on. `error` remains the fallback for executors that only set that field.
  //
  // `code` is forwarded so an agent can branch without regexing prose — the MCP
  // tool route already surfaces it, but nothing was ever putting it there.
  return {
    ok: false,
    summary: clip(result.message || result.error || 'Action failed.'),
    ...(result.code ? { code: result.code } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  }
}

function clip(s: string, max = 800): string {
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/**
 * A short human label for a tool call, e.g. "Creating table posts".
 *
 * Exported because `runBrain` needs the same phrasing for the `applied` list it
 * reports on a failed turn — a second, drifting copy of these strings inside the
 * agent is how "Applied 2 change(s): Securing conversations" ended up describing
 * something other than what the events said.
 */
export function humanTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_backend_state': return 'Reading backend state'
    case 'list_findings': return 'Checking open issues'
    case 'resolve_finding': return 'Resolving the issue'
    case 'get_pending_incidents': return 'Preparing your backend briefing'
    case 'get_database_credentials': return 'Fetching database credentials'
    case 'adopt_external_schema': return 'Adopting external schema changes'
    case 'create_table': return `Creating table ${args.tableName ?? ''}`.trim()
    case 'add_column': return `Adding column to ${args.tableName ?? ''}`.trim()
    case 'create_index': return `Indexing ${args.tableName ?? ''}`.trim()
    case 'generate_api': return `Generating API for ${args.tableName ?? ''}`.trim()
    case 'enable_auth': return 'Enabling authentication'
    case 'add_oauth_provider': return `Adding ${args.provider ?? 'OAuth'} sign-in`
    case 'create_bucket': return `Creating bucket ${args.bucketName ?? ''}`.trim()
    case 'add_rls': {
      // Name the policy in the title so a failed owner-only attempt and a
      // successful retry on a different template read as distinct steps —
      // never as the contradictory "Cannot apply… ✓ Securing" same-label pair.
      const rlsLabels: Record<string, string> = {
        owner_read_write: 'owner-only', public_read: 'public-read',
        org_members: 'org-scoped', admin_only: 'admin-only', all_access: 'open',
      }
      const policy = args.policy
        ? ` · ${rlsLabels[String(args.policy)] ?? String(args.policy)} RLS`
        : ' with RLS'
      return `Securing ${args.tableName ?? ''}${policy}`.trim()
    }
    case 'create_trigger': return `Adding ${args.on ?? ''} trigger on ${args.tableName ?? ''}`.trim()
    case 'enable_realtime': return `Enabling realtime on ${args.tableName ?? ''}`.trim()
    case 'get_realtime_status': return 'Reading realtime status'
    case 'generate_function': {
      const t = String(args.trigger || 'http')
      const kind =
        t === 'http' ? 'HTTP function'
        : t === 'on_signup' ? 'signup function'
        : t.startsWith('on_') ? `${t.replace('on_', '')}-event function`
        : 'function'
      return `Generating ${kind} ${args.name ?? ''}`.trim()
    }
    case 'enable_vector_search': return `Enabling semantic search on ${args.tableName ?? ''}`.trim()
    case 'create_cron_job': return `Scheduling job (${args.schedule ?? ''})`.trim()
    case 'set_rate_limit': return `Setting rate limit on ${args.tableName ?? ''}`.trim()
    case 'generate_aggregate_api': return `Generating ${args.name ?? 'stats'} stats endpoint`.trim()
    case 'enable_teams': return 'Setting up team multi-tenancy'
    case 'enable_push_notifications': return 'Connecting OneSignal'
    case 'send_push': return `Sending push${args.title ? `: ${args.title}` : ''}`.trim()
    case 'rotate_webhook_secret': return `Rotating signing secret for ${args.triggerName ?? 'webhook'}`.trim()
    case 'list_webhook_deliveries': return 'Reading webhook delivery log'
    case 'replay_webhook_delivery': return `Replaying delivery ${args.id ?? ''}`.trim()
    case 'fix_backend': return `Repairing ${args.target ?? 'backend'}`
    case 'apply_proposal': return 'Applying the recommendation list'
    case 'drop_table': return `Dropping table ${args.tableName ?? ''}`.trim()
    case 'truncate_table': return `Truncating ${args.tableName ?? ''}`.trim()
    case 'drop_column': return `Dropping column ${args.columnName ?? ''} from ${args.tableName ?? ''}`.trim()
    case 'disable_realtime': return args.tableName ? `Disabling realtime on ${args.tableName}` : 'Disabling realtime project-wide'
    case 'rename_column': return `Renaming ${args.oldName ?? ''} → ${args.newName ?? ''} on ${args.tableName ?? ''}`.trim()
    case 'add_constraint': return `Adding ${args.constraintType ?? 'constraint'} on ${args.tableName ?? ''}.${args.columnName ?? ''}`
    case 'list_tables': return 'Listing tables'
    case 'list_apis': return 'Listing REST endpoints'
    case 'list_buckets': return 'Listing storage buckets'
    case 'list_files': return `Listing files in ${args.bucketName ?? ''}`.trim()
    case 'generate_signed_url': return `Signing URL for ${args.path ?? ''}`.trim()
    case 'list_api_keys': return 'Listing API keys'
    case 'list_end_users': return 'Listing end-users'
    case 'list_permissions': return 'Listing RLS policies'
    case 'list_triggers': return 'Listing triggers'
    case 'list_ai_functions': return 'Listing AI functions'
    case 'list_cron_jobs': return 'Listing scheduled jobs'
    case 'list_integration_keys': return 'Listing integrations'
    case 'list_connected_apps': return 'Listing connected frontends'
    case 'get_deploy_status': return 'Reading deployment status'
    case 'get_metrics': return 'Reading performance metrics'
    case 'get_errors': return 'Reading recent errors'
    case 'get_usage': return 'Reading usage + quota'
    case 'get_autonomy_status': return 'Reading autonomy + trust report'
    case 'set_bucket_public': return `Making ${args.bucketName ?? 'bucket'} ${args.isPublic ? 'public' : 'private'}`
    case 'delete_bucket': return `Deleting bucket ${args.bucketName ?? ''}`.trim()
    case 'delete_file': return `Deleting file ${args.path ?? ''}`.trim()
    case 'connect_frontend': return `Connecting frontend ${args.url ?? ''}`.trim()
    case 'disconnect_frontend': return `Disconnecting frontend ${args.url ?? ''}`.trim()
    case 'trigger_deploy': return args.force ? 'Publishing backend' : 'Previewing deploy'
    case 'rollback_deploy': return args.version ? `Rolling back to v${args.version}` : 'Rolling back deployment'
    case 'get_readiness': return 'Reading deploy readiness'
    case 'set_env_var': return `Saving env var ${args.key ?? ''}`.trim()
    case 'list_env_vars': return 'Listing project env vars'
    case 'delete_env_var': return `Deleting env var ${args.key ?? ''}`.trim()
    case 'reset_end_user_password': return `Resetting password for ${args.email ?? args.userId ?? 'user'}`
    case 'block_end_user': return `Blocking user ${args.email ?? args.userId ?? ''}`.trim()
    case 'unblock_end_user': return `Unblocking user ${args.email ?? args.userId ?? ''}`.trim()
    case 'disable_oauth_provider': return `Disabling ${args.provider ?? 'OAuth'} sign-in`
    case 'remove_permission': return `Removing RLS from ${args.tableName ?? ''}`.trim()
    case 'create_api_key': return `Creating API key${args.description ? `: ${args.description}` : ''}`
    case 'revoke_api_key': return `Revoking key ${args.keyId ?? ''}`.trim()
    case 'rotate_api_key': return `Rotating key ${args.keyId ?? ''}`.trim()
    case 'set_key_permissions': return `Updating permissions on key ${args.keyId ?? ''}`.trim()
    case 'store_integration_key': return `Connecting ${args.integrationId ?? 'integration'}`
    case 'remove_integration_key': return `Disconnecting ${args.integrationId ?? ''}`.trim()
    case 'delete_trigger': return `Deleting trigger ${args.name ?? args.triggerId ?? ''}`.trim()
    case 'toggle_ai_function': return `${args.active ? 'Enabling' : 'Disabling'} function ${args.name ?? args.functionId ?? ''}`.trim()
    case 'delete_ai_function': return `Deleting function ${args.name ?? args.functionId ?? ''}`.trim()
    case 'delete_cron_job': return `Deleting job ${args.name ?? args.jobId ?? ''}`.trim()
    case 'set_alert': return `Setting alert: ${args.type ?? ''} > ${args.threshold ?? ''}`
    case 'set_autonomy_level': return `Setting autonomy to ${args.level ?? ''}`
    case 'propose_plan': return 'Proposing a plan'
    case 'ask_user': return 'Asking for clarification'
    case 'answer_question': return 'Answering'
    case 'run_test': return `Testing ${args.operation ?? 'endpoint'} on ${args.tableName ?? ''}`.trim()
    case 'rollback': return `Rolling back ${args.steps ?? 1} step(s)`
    case 'finish': return 'Wrapping up'
    default: return name
  }
}
