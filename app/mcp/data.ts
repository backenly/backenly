/**
 * The /mcp page's content: what the Backenly MCP server is, how each client
 * connects, what the tools do and what waits for a person.
 *
 * Every fact here is a claim about the product, so the parts that can drift are
 * held to the source by tests/unit/mcp-page-conformance.spec.ts: the tool
 * counts against lib/mcp/catalog.ts, the actions that wait for approval against
 * lib/mcp/domains.ts, and each install command against
 * public/docs/agents/client-setup.md, which agents themselves read.
 */

export const MCP_ENDPOINT = 'https://backenly.com/api/mcp'

/** `buildCatalog().length`: what a read-write connection is shown. */
export const ADVERTISED_TOOL_COUNT = 23

/** `buildCatalog({ readOnly: true }).length`. */
export const READ_ONLY_TOOL_COUNT = 16

export type Install = {
  id: string
  client: string
  /** Where it goes or how it runs, in one line. */
  title: string
  note: string
  language: 'bash' | 'json' | 'toml'
  code: string
}

/**
 * The setups agents are told about in client-setup.md, in the same words. The
 * Connect page in the console prints these with the project id and key filled
 * in. Ordered so each row of the two-column grid pairs blocks of a similar
 * height: the two remote commands, the two stdio commands, the two JSON files.
 */
export const INSTALLS: Install[] = [
  {
    id: 'claude-code-remote',
    client: 'Claude Code',
    title: 'Remote, with a key',
    note: 'Nothing to install. Run it in a terminal before you start the conversation: an MCP host reads its servers when a session starts.',
    language: 'bash',
    code: `claude mcp add --transport http backenly ${MCP_ENDPOINT} --header "x-api-key: <scoped-key>"`,
  },
  {
    id: 'claude-code-oauth',
    client: 'Claude Code',
    title: 'Remote, with a browser sign-in',
    note: 'No key. Run /mcp, pick backenly and choose Authenticate. You approve the connection on backenly.com and choose the project there; read-only is an option on that screen.',
    language: 'bash',
    code: `claude mcp add --transport http backenly ${MCP_ENDPOINT}`,
  },
  {
    id: 'claude-code-stdio',
    client: 'Claude Code',
    title: 'Local, over stdio',
    note: 'The @backenly/mcp-server npm package (Node.js 20 or later). It serves the same tools, instructions and results as the remote endpoint.',
    language: 'bash',
    code: 'claude mcp add backenly -- npx -y @backenly/mcp-server --project <id> --key <scoped-key>',
  },
  {
    id: 'codex',
    client: 'Codex',
    title: 'Local, over stdio',
    note: 'For the remote endpoint, Codex takes the key only through ~/.codex/config.toml: a [mcp_servers.backenly] table with the url and http_headers.',
    language: 'bash',
    code: 'codex mcp add backenly -- npx -y @backenly/mcp-server --project <id> --key <scoped-key>',
  },
  {
    id: 'cursor',
    client: 'Cursor',
    title: '~/.cursor/mcp.json',
    note: 'The user config, not the project’s, so the key is never committed beside the app.',
    language: 'json',
    code: `{
  "mcpServers": {
    "backenly": {
      "url": "${MCP_ENDPOINT}",
      "headers": { "x-api-key": "<scoped-key>" }
    }
  }
}`,
  },
  {
    id: 'cline',
    client: 'Cline',
    title: 'cline_mcp_settings.json',
    note: 'The remote entry must set "type": "streamableHttp", or Cline falls back to SSE and the endpoint answers 405.',
    language: 'json',
    code: `{
  "mcpServers": {
    "backenly": {
      "type": "streamableHttp",
      "url": "${MCP_ENDPOINT}",
      "headers": { "x-api-key": "<scoped-key>" }
    }
  }
}`,
  },
]

export type ToolGroup = { title: string; tools: string[]; body: string }

/** All 23 advertised tools, grouped by what an agent uses them for. */
export const TOOL_GROUPS: ToolGroup[] = [
  {
    title: 'Read what exists',
    tools: ['read_backend_state', 'get_table_schema', 'run_query', 'generate_types', 'fetch_docs', 'check_approval'],
    body: 'The backend’s state, section by section; one table in full, with what its constraints reject; read-only SQL as the project’s SELECT-only role; TypeScript types, a typed client or OpenAPI from the live catalog.',
  },
  {
    title: 'Change the schema',
    tools: ['apply_migration', 'set_rls', 'branch'],
    body: 'SQL in, checked typed actions out, applied as one governed change. Row-level security as exact SQL predicates, installed as written and read back. Preview branches that merge back once a person approves.',
  },
  {
    title: 'Write rows',
    tools: ['db_insert', 'db_update', 'db_delete'],
    body: 'Row writes for seeding and repair. An update or a delete needs a non-empty filter.',
  },
  {
    title: 'Run each part of the backend',
    tools: ['auth', 'storage', 'functions', 'realtime', 'integrations', 'monitoring', 'autonomy', 'webhooks', 'deploy', 'connect'],
    body: 'One tool per console section, each with an action: sign-in providers and users, buckets and files, server functions and schedules, live updates, provider keys, metrics and logs, the maintenance loop, signed webhooks, deploys, and keys and connections.',
  },
  {
    title: 'Ask in plain language',
    tools: ['backend_chat'],
    body: 'Backenly’s own engine plans a change from a description. It is the one tool that draws AI credits; the typed tools above never do.',
  },
]

export type GatedSection = { tool: string; actions: string[] }

/** The section actions that wait for a person, as lib/mcp/domains.ts decides it. */
export const GATED_ACTIONS: GatedSection[] = [
  { tool: 'auth', actions: ['remove_oauth_provider', 'block_user', 'remove_smtp'] },
  { tool: 'storage', actions: ['delete_file', 'delete_bucket'] },
  { tool: 'functions', actions: ['delete', 'delete_schedule'] },
  { tool: 'realtime', actions: ['disable'] },
  { tool: 'integrations', actions: ['disconnect'] },
  { tool: 'webhooks', actions: ['delete'] },
  { tool: 'deploy', actions: ['deploy', 'rollback', 'revert_change'] },
  { tool: 'connect', actions: ['revoke_api_key', 'delete_env', 'disconnect_frontend'] },
]

export const APPROVAL_STEPS = [
  {
    title: 'The call is parked, not run',
    body: 'The response carries an `approval` object with its id. Nothing in the backend changes.',
  },
  {
    title: 'You see exactly what it would do',
    body: 'It waits on the project’s Autonomy page under “Waiting on you”, with its impact: how many live rows, and whether the data is recoverable.',
  },
  {
    title: 'A person decides',
    body: 'Approve or reject it there. The agent’s key can request and poll; it cannot approve.',
  },
  {
    title: 'The approved call runs as it was made',
    body: 'Verbatim, with no model re-reading it. The agent polls `check_approval` until it reports `executed`, `rejected`, `expired`, `failed` or `partial`.',
  },
]

export const FAQ = [
  {
    q: 'Does it work with my existing PostgreSQL database?',
    a: 'No. The server operates a Backenly project, on Backenly Cloud or your own self-hosted Backenly, and each project has its own PostgreSQL schema that Backenly manages. You can still reach that database directly, with a read-only connection string on demand or a read-write one a person arms, and export it with pg_dump. It is not a general MCP client for a database Backenly does not run.',
  },
  {
    q: 'Which clients work with it?',
    a: 'Any MCP host that speaks stdio or Streamable HTTP. The setup is documented for Claude Code, Cursor, Codex, Cline and Antigravity, and the Connect page in your project prints the exact block for each with the key filled in.',
  },
  {
    q: 'Can my agent drop a table or delete data?',
    a: 'Not on its own. apply_migration refuses DROP statements with DESTRUCTIVE_REFUSED and points at backend_chat, which parks the request for approval. Dropping or emptying a table, dropping a column, deleting files, revoking keys and the other actions listed above all wait for a person. Ordinary row inserts, updates and deletes run as normal.',
  },
  {
    q: 'Can I undo what my agent did?',
    a: 'Yes. Every change, whether your agent, Backenly or you made it, is one entry in the project’s History, which covers the schema, auth, storage, functions, webhooks, environment variables, keys and integrations. Restore one change, or everything back to a point; each restore is checked before it runs and verified after. Data your app wrote is never rewound, a restore that would affect it waits for your approval, and a secret or a revoked key never comes back. An agent can ask for a restore, but only a person approves it.',
  },
  {
    q: 'Can I give an agent read-only access?',
    a: `Yes. A read-only key or connection sees ${READ_ONLY_TOOL_COUNT} tools: the read tools, and each section tool narrowed to its read actions. A write called anyway is refused with READ_ONLY_KEY before it runs. A person chooses read-only when the key is issued, and an agent cannot upgrade its own key.`,
  },
  {
    q: 'Does using the tools cost AI credits?',
    a: 'Only backend_chat, which runs Backenly’s own engine. The typed tools your agent calls directly, including apply_migration, are not metered as AI.',
  },
  {
    q: 'Does it work with a self-hosted Backenly?',
    a: 'Yes. Point the stdio package at your instance with --endpoint, or add your instance’s /api/mcp as the remote URL. Keys and projects come from your own dashboard.',
  },
]
