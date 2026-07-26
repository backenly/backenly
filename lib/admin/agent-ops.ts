/**
 * AGENT OPERATIONS TAXONOMY
 * =========================
 * Shared vocabulary for "how much work did external coding agents (Claude Code,
 * Cursor, Codex, Cline, …) actually execute against production backends, and how
 * much of it landed cleanly?"
 *
 * ── Where the numbers come from ──────────────────────────────────────────────
 *
 * Every agent-driven call reaches the platform through an ApiKey with
 * `scope = 'mcp'` — the only key type allowed on /api/mcp/* and /api/cli/*.
 * `lib/mcp/guard.ts#recordMcpCall` writes one ApiKeyUsage row per call with
 * `{ tool, mutation, summary, error }` in `metadata`. That row is the ledger.
 * A dashboard build or an autonomy tick never writes one, so "agent-executed"
 * is a property of the storage, not an inference we make afterwards.
 *
 * ── The one honesty constraint ───────────────────────────────────────────────
 *
 * `metadata.mutation` means "this tool is a WRITE tool", NOT "something was
 * written". recordMcpCall stamps it from the tool name before the outcome is
 * known, so a `create_table` that was refused carries `mutation:true` with a
 * 400. Reading that flag as "a change landed" would inflate the applied count
 * with operations that changed nothing, which is exactly the direction a
 * marketing number must never be wrong in.
 *
 * So the classifier below keys on the STATUS, and separates the two codes that
 * genuinely mean "some of it landed and then it stopped" (`MIGRATION_FAILED`
 * from a multi-statement apply_migration, and a `backend_chat` turn that threw
 * after applying) from the far larger set that means "refused, nothing
 * changed". Only the first is a safety liability; the second is the guardrail
 * doing its job and is reported as such.
 */

/** Categories the admin surface reports separately. */
export type AgentOpKind = 'schema' | 'policy' | 'data' | 'chat' | 'other' | 'read'

/**
 * Structural DDL. These are the "automated schema modifications" — the number
 * that backs an external claim about agents changing production schemas.
 *
 * `apply_migration` is the door almost all agent DDL comes through since it
 * accepts raw SQL; it can carry many statements per call, which is why the
 * route counts statements as well as calls.
 */
export const SCHEMA_TOOL_NAMES = [
  'apply_migration',
  'create_table',
  'add_column',
  'create_index',
  'rename_column',
  'add_constraint',
  'drop_table',
  'drop_column',
  'sync_column',
  'remove_sync_column',
  'create_trigger',
  'delete_trigger',
  'adopt_external_schema',
  'branch',
  'create_branch',
  'merge_branch',
  'discard_branch',
] as const

const SCHEMA_TOOLS = new Set<string>(SCHEMA_TOOL_NAMES)

/**
 * Security-critical schema writes. Kept out of SCHEMA_TOOLS because "an agent
 * rewrote a row-level security policy" is a different claim from "an agent
 * added a column", and conflating them hides the one that matters more.
 */
const POLICY_TOOLS = new Set([
  'set_rls',
  'add_rls',
  'enable_auth',
  'add_oauth_provider',
  'disable_oauth_provider',
  'remove_permission',
  'set_key_permissions',
  'block_end_user',
  'unblock_end_user',
])

/** Row-level writes — the operations that can actually corrupt customer data. */
const DATA_TOOLS = new Set([
  'db_insert',
  'db_update',
  'db_delete',
  'run_data_migration',
  'truncate_table',
  'delete_file',
])

/**
 * Reads. Not counted as operations anywhere in the totals — they are here only
 * so an unrecognised tool name is distinguishable from a known read.
 */
const READ_TOOLS = new Set([
  'read_backend_state',
  'run_query',
  'get_table_schema',
  'get_instructions',
  'get_backend_metadata',
  'get_project_overview',
  'db_query',
  'generate_types',
  'fetch_docs',
  'check_approval',
  'check_intent_conformance',
  'check_sensor_health',
  'list_tables',
  'list_apis',
  'list_buckets',
  'list_files',
  'list_branches',
  'diff_branch',
  'list_findings',
  'get_deploy_status',
  'get_readiness',
  'get_metrics',
  'get_errors',
  'get_usage',
  'get_autonomy_status',
  'get_realtime_status',
  'get_pending_incidents',
  'get_database_credentials',
  'list_env_vars',
  'list_api_keys',
  'list_end_users',
  'list_permissions',
  'list_triggers',
  'list_ai_functions',
  'list_cron_jobs',
  'list_integration_keys',
  'list_connected_apps',
  'list_webhook_deliveries',
  'generate_signed_url',
])

export function classifyTool(tool: string): AgentOpKind {
  // Sentinel for a usage row whose metadata carries no `tool` key. Only two
  // paths produce one, and neither is a write: GET /api/mcp/manifest (an agent
  // discovering the tool catalog, recorded with no tool name), and a request
  // whose body failed to parse. Counting these as writes put phantom "other"
  // operations in the totals — observed on production, where the entire agent
  // ledger was one manifest fetch and one catalog read, yet reported two
  // writes. A row that never named a tool is not evidence that one ran.
  if (tool === 'unknown') return 'read'
  if (SCHEMA_TOOLS.has(tool)) return 'schema'
  if (POLICY_TOOLS.has(tool)) return 'policy'
  if (DATA_TOOLS.has(tool)) return 'data'
  // The natural-language door. It CAN perform schema work, but the usage row
  // records only "backend_chat" — the underlying tool mix is not on it. Kept in
  // its own bucket rather than guessed into `schema`, so the schema number
  // stays one that can be defended line by line.
  if (tool === 'backend_chat') return 'chat'
  if (READ_TOOLS.has(tool)) return 'read'
  return 'other'
}

/**
 * Outcome of a single agent write.
 *
 *   applied     2xx — the tool reported success. The change is in.
 *   refused     4xx — a guardrail, approval gate, quota or validation stopped
 *                     it. Nothing was applied. This is the platform working.
 *   unresolved  a multi-step run that stopped part-way through, so the backend
 *               may sit between the before and after state. The only bucket
 *               that is a safety liability.
 *   errored     5xx — the platform itself failed.
 */
export type AgentOpOutcome = 'applied' | 'refused' | 'unresolved' | 'errored'

/** Error codes that mean a multi-step run stopped after applying some of it. */
const PARTIAL_CODES = new Set(['MIGRATION_FAILED'])

export function classifyOutcome(input: {
  tool: string
  statusCode: number
  /** `metadata.error` — the structured failure code, when the call failed. */
  code: string
  /** `metadata.mutation` — "this is a write tool", not "a write happened". */
  mutation: boolean
}): AgentOpOutcome {
  const { tool, statusCode, code, mutation } = input

  if (statusCode >= 200 && statusCode < 300) return 'applied'

  // apply_migration stops at the first failing statement and reports how far it
  // got. The usage row does not carry the applied count, so this is "may have
  // partially applied" — surfaced for review rather than assumed either way.
  if (PARTIAL_CODES.has(code)) return 'unresolved'

  // backend_chat only stamps mutation:true on a failure path when at least one
  // tool had already succeeded in that turn (see app/api/mcp/chat/route.ts).
  // There it genuinely does mean "some of it landed".
  if (tool === 'backend_chat' && mutation) return 'unresolved'

  if (statusCode >= 500) return 'errored'
  return 'refused'
}

/**
 * Failure codes worth calling out individually — each is a distinct guardrail,
 * and "which gate caught it" is the interesting part of a refusal.
 */
export const GUARDRAIL_CODES: Record<string, string> = {
  DESTRUCTIVE_NOT_ALLOWED: 'Destructive op sent to human approval',
  APPROVAL_REQUIRED: 'Parked for owner approval',
  PLAN_LIMIT_EXCEEDED: 'Plan quota',
  RATE_LIMITED: 'Per-key rate limit',
  AI_CREDITS_EXHAUSTED: 'Model budget',
  VALIDATION: 'Rejected by argument validation',
  BAD_BODY: 'Malformed request',
  UNKNOWN_TOOL: 'Unknown tool',
  NOT_READ_ONLY: 'Write sent to the read-only door',
  TOOL_ERROR: 'Tool reported failure',
}

export function isWriteKind(kind: AgentOpKind): boolean {
  return kind !== 'read'
}
