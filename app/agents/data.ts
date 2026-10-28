/**
 * The /agents pages: how one coding agent connects to a Backenly project, and
 * what is particular to that agent. Each page carries only its own agent's
 * details; what every client shares (the tools, the approvals) lives on /mcp,
 * and each page links there.
 *
 * Every fact is a claim about the product, so the parts that can drift are
 * held to their source by tests/unit/agent-pages-conformance.spec.ts: the
 * commands against public/docs/agents/client-setup.md and the stdio package,
 * the Cursor blocks against the Connect page's own builders, the tool counts
 * against the catalog, the skill and rule files against the CLI that writes
 * them, and the error codes against the code that returns them.
 *
 * Strings with `backticks` render as inline code (withCode). FAQ answers are
 * plain text, because the FAQPage structured data repeats them verbatim.
 */

import { ADVERTISED_TOOL_COUNT, INSTALLS, MCP_ENDPOINT, READ_ONLY_TOOL_COUNT } from '@/app/mcp/data'

/** The last real edit to either page's content, for the sitemap and the article dates. */
export const AGENTS_UPDATED = '2026-10-24'

export const AGENT_SLUGS = ['claude-code', 'cursor'] as const
export type AgentSlug = (typeof AGENT_SLUGS)[number]

export type FaqItem = { q: string; a: string }
export type NextItem = { href: string; meta: string; title: string; body: string }
export type Cell = { title: string; body: string; code?: string }

/** What every agent page has, whatever its sections. */
export type AgentPageBase = {
  slug: AgentSlug
  name: string
  metaTitle: string
  metaDescription: string
  title: string
  lede: string
  faq: FaqItem[]
  next: NextItem[]
  close: { title: string; lede: string }
}

const installCode = (id: string) => {
  const install = INSTALLS.find((i) => i.id === id)
  if (!install) throw new Error(`app/mcp/data.ts has no install "${id}"`)
  return install.code
}

/**
 * The same-session fallback, three of the lines client-setup.md gives agents.
 * Both pages show it, because both hosts read MCP config only when a session
 * starts.
 */
export const CLI_FALLBACK = [
  'npx -y @backenly/cli@latest link --project <id> --key <scoped-key>',
  'npx -y @backenly/cli@latest call read_backend_state',
  'npx -y @backenly/cli@latest chat "add a likes counter to posts"',
].join('\n')

/* ── Claude Code ─────────────────────────────────────────────────────────── */

export type ClaudeCodePage = AgentPageBase & {
  installs: (Cell & { id: string; code: string })[]
  keyFree: string
  /** The command `npx @backenly/mcp-server init` prints for Claude Code. */
  keyFreeCommand: string
  session: {
    now: Cell & { code: string; note: string }
    next: Cell & { prompt: string }
  }
  context: Cell[]
  access: Cell[]
}

const CLAUDE_KEY_FREE = 'claude mcp add backenly -- npx -y @backenly/mcp-server'

export const CLAUDE_CODE: ClaudeCodePage = {
  slug: 'claude-code',
  name: 'Claude Code',
  metaTitle: 'A Postgres database and backend for Claude Code',
  metaDescription:
    'Add Backenly to Claude Code with a key, a browser sign-in or the local package, and keep working before its MCP tools load. Destructive changes wait for you.',
  title: 'A Postgres backend for Claude Code',
  lede: 'Claude Code builds and runs a Backenly project over MCP: tables, row-level security, auth, storage and functions. One command connects it, and anything destructive waits for you.',

  installs: [
    {
      id: 'claude-code-remote',
      title: 'Remote, with a key',
      body: 'Nothing to install. The key comes from your project’s Connect page, under Agents, and travels in the `x-api-key` header.',
      code: installCode('claude-code-remote'),
    },
    {
      id: 'claude-code-oauth',
      title: 'Remote, with a browser sign-in',
      body: 'No key in the command. Run `/mcp`, pick `backenly` and choose Authenticate. On backenly.com you pick the project, and Read-only access starts checked: clear it to let Claude Code make changes.',
      code: installCode('claude-code-oauth'),
    },
    {
      id: 'claude-code-stdio',
      title: 'Local, over stdio',
      body: 'The `@backenly/mcp-server` package, on Node.js 20 or later. It serves the same tools and results as the remote endpoint, and checks the project id against the key when it starts.',
      code: installCode('claude-code-stdio'),
    },
  ],
  keyFree: `To keep the key out of the command, run \`npx @backenly/mcp-server init\` once. It checks the key and saves it to \`~/.backenly/mcp.json\`, readable only by you, and the command becomes \`${CLAUDE_KEY_FREE}\`.`,
  keyFreeCommand: CLAUDE_KEY_FREE,

  session: {
    now: {
      title: 'In this conversation',
      body: 'A server added mid-conversation is not in this conversation’s tool list, and retrying will not change that. Claude Code can call every Backenly tool from the shell instead, with the same key and the same approval rules.',
      code: CLI_FALLBACK,
      note: '`link` checks the key belongs to the project, stores it in `.backenly/config.json`, and adds `.backenly/` to `.gitignore` when the repository has one.',
    },
    next: {
      title: 'In the next one',
      body: 'Run `/exit`, then `claude --continue`, or open a new tab in the VS Code extension. `/mcp` lists `backenly` once it is connected. Then ask for the backend’s state:',
      prompt: 'Call Backenly’s read_backend_state tool and tell me what exists in this project.',
    },
  },

  context: [
    {
      title: 'Instructions on connect',
      body: 'The server sends them when the connection opens, and Claude Code adds them to the agent’s context: read the backend’s state before changing anything, say which project it is connected to, and never put the `mcp_live_` key in app code.',
    },
    {
      title: 'The docs in one call',
      body: '`fetch_docs` returns Backenly’s agent guide in full: at most 40,000 characters, about 10,000 tokens, inside Claude Code’s default limit of 25,000 tokens on one tool result.',
    },
    {
      title: 'A skill in the repository',
      body: 'One command writes `.claude/skills/backenly/SKILL.md` from backenly.com/skill.md: which tool does what, the order that works, the error codes to branch on, and which key an app needs.',
      code: 'npx -y @backenly/cli@latest install-skill --agent claude',
    },
  ],

  access: [
    {
      title: 'One project per key',
      body: 'Every key and browser sign-in is bound to one project, so a leaked credential reaches that project and nothing else. `connect { action: "whoami" }` tells Claude Code which one it is on.',
    },
    {
      title: 'Read-only, if you choose',
      body: `A read-only key or sign-in sees ${READ_ONLY_TOOL_COUNT} tools instead of ${ADVERTISED_TOOL_COUNT}, and a write called anyway is refused with \`READ_ONLY_KEY\`. A person chooses it, and Claude Code cannot upgrade its own key.`,
    },
    {
      title: 'Not the key your app uses',
      body: 'The runtime API your app calls refuses an MCP key with `MCP_KEY_IN_APP`. Claude Code creates the app’s own publishable key with `connect { action: "create_api_key" }`.',
    },
    {
      title: 'Destructive actions wait for you',
      body: '`apply_migration` refuses DROP with `DESTRUCTIVE_REFUSED`. Dropping a table, deploying, rolling back and revoking a key are parked on the project’s Autonomy page until a person approves them.',
    },
  ],

  faq: [
    {
      q: 'Which of the three installs should I use?',
      a: 'The remote URL with a key is the shortest, with nothing to install. The browser sign-in puts no key in the command and starts read-only. The local package needs Node.js 20 or later and serves the same tools and results as the remote endpoint.',
    },
    {
      q: 'Claude Code does not show the Backenly tools. What is wrong?',
      a: 'Usually the server was added during the conversation: its tools arrive in the next one, and the CLI works until then. If /mcp lists backenly but calls fail, check the header. The key belongs in x-api-key; sent as Authorization: Bearer, it is read as a sign-in token and refused with INVALID_TOKEN. INVALID_KEY means the key was revoked or mistyped, so generate a new one on the Connect page.',
    },
    {
      q: 'Does it work with my existing PostgreSQL database?',
      a: 'No. Claude Code operates a Backenly project, on Backenly Cloud or your own self-hosted Backenly, and Backenly manages that project’s PostgreSQL schema. You can still connect to that database directly with a connection string, and export it with pg_dump.',
    },
    {
      q: 'Can Claude Code drop a table or delete my data?',
      a: 'Not on its own. apply_migration refuses DROP statements, and a request to drop or empty a table through backend_chat is parked until a person approves it on the Autonomy page. Row inserts, updates and deletes run as normal, and an update or delete needs a non-empty filter.',
    },
    {
      q: 'Claude Code changed something I did not want. Can I undo it?',
      a: 'Yes, from the project’s History: restore that one change, or everything back to a point. History covers the schema, auth, storage, functions, webhooks, environment variables, keys and integrations, and each restore is checked before it runs. Data your app wrote since is never rewound, and a restore that would affect it waits for your approval. Claude Code can ask for a restore, but only you can approve one.',
    },
    {
      q: 'Does it work with a self-hosted Backenly?',
      a: 'Yes. Use your instance’s /api/mcp as the remote URL, or add --endpoint with your instance’s address to the local command. Keys and projects come from your own dashboard.',
    },
  ],

  next: [
    {
      href: '/docs/connect',
      meta: 'Docs',
      title: 'Connect, step by step',
      body: 'Creating a key, every client’s setup, and how your app connects.',
    },
    {
      href: '/mcp',
      meta: 'MCP server',
      title: `The ${ADVERTISED_TOOL_COUNT} tools`,
      body: 'What each tool is for, and which actions wait for a person.',
    },
    {
      href: '/guides/safe-ai-database-changes',
      meta: 'Guide',
      title: 'Safe database changes with AI agents',
      body: 'How a schema change is checked, applied and recovered.',
    },
    {
      href: '/agents/cursor',
      meta: 'Cursor',
      title: 'Backenly in Cursor',
      body: 'The mcp.json block, and why it belongs in your user config.',
    },
  ],

  close: {
    // A no-break space keeps the product's name on one line of the close.
    title: 'Give Claude\u00a0Code a backend',
    lede: 'One free project, no credit card. Connect it in one command.',
  },
}

/* ── Cursor ──────────────────────────────────────────────────────────────── */

export type CursorPage = AgentPageBase & {
  configs: (Cell & { id: 'remote' | 'local'; code: string })[]
  configNote: string
  placement: Cell[]
  rules: Cell & { code: string }
  fallback: Cell & { code: string; note: string }
}

/** The remote block, exactly as /mcp shows it. */
const CURSOR_REMOTE = installCode('cursor')

/**
 * The Connect page's local block (components/connect/AgentInstallGuide.tsx
 * stdioJson), placeholders in. The args are set in pairs, as the npm README
 * writes them, so the block reads inside a half-width cell.
 */
const CURSOR_LOCAL = `{
  "mcpServers": {
    "backenly": {
      "command": "npx",
      "args": [
        "-y", "@backenly/mcp-server",
        "--project", "<id>",
        "--key", "<scoped-key>"
      ]
    }
  }
}`

/** The block `npx @backenly/mcp-server init` prints once the key is saved (packages/mcp-server/src/init.ts). */
const CURSOR_KEY_FREE = `{
  "mcpServers": {
    "backenly": {
      "command": "npx",
      "args": ["-y", "@backenly/mcp-server"]
    }
  }
}`

export const CURSOR: CursorPage = {
  slug: 'cursor',
  name: 'Cursor',
  metaTitle: 'Cursor MCP setup for a Postgres backend',
  metaDescription:
    'The mcp.json block that connects Cursor to a Backenly project over MCP, why it belongs in your user config, and the rule file that teaches the agent Backenly.',
  title: 'Connect Cursor to Backenly',
  lede: 'Cursor’s agent reaches Backenly through one block in mcp.json. It then builds and runs a Backenly project: tables, auth, storage and functions, with anything destructive held for you.',

  configs: [
    {
      id: 'remote',
      title: 'Remote',
      body: 'Nothing to install. Cursor infers the transport from the `url`, so the block needs no `type` field.',
      code: CURSOR_REMOTE,
    },
    {
      id: 'local',
      title: 'Local, over stdio',
      body: 'Runs the `@backenly/mcp-server` package through npx, on Node.js 20 or later. On a self-hosted Backenly, the args end with `--endpoint` and your instance’s address.',
      code: CURSOR_LOCAL,
    },
  ],
  configNote:
    'Save the file, then reload the Cursor window. Your project’s Connect page, under Agents, prints both blocks with the project id and key filled in.',

  placement: [
    {
      title: '~/.cursor/mcp.json',
      body: 'Where the block goes. Your user config sits outside every repository, so the key is never committed beside the app.',
    },
    {
      title: '.cursor/mcp.json in the project',
      body: 'Committed with the repository, next to the code the agent writes. An agent building a frontend once shipped its own MCP key in the bundle. The runtime API now refuses one with `MCP_KEY_IN_APP`; a key kept out of the repository never gets that far.',
    },
    {
      title: 'No key in either file',
      body: 'Run `npx @backenly/mcp-server init` once. It checks the key and saves it to `~/.backenly/mcp.json`, readable only by you. The local block then carries no key, so it can sit in a file you commit.',
      code: CURSOR_KEY_FREE,
    },
  ],

  rules: {
    title: 'A rule in .cursor/rules',
    body: 'One command writes `.cursor/rules/backenly.mdc`, marked `alwaysApply: true`. Its body is backenly.com/skill.md, the guide Backenly writes for agents: which tool to use for what, the error codes to branch on, and which key an app needs.',
    code: 'npx -y @backenly/cli@latest install-skill --agent cursor',
  },
  fallback: {
    title: 'Before the tools load',
    body: 'Cursor reads mcp.json when a session starts. Until the Backenly tools appear, the agent can run every one of them from the terminal, with the same key and the same approval rules.',
    code: CLI_FALLBACK,
    note: '`link` keeps the key in `.backenly/config.json` and, if the repository has a `.gitignore`, adds `.backenly/` to it.',
  },

  faq: [
    {
      q: 'Does the remote block need "type": "streamableHttp"?',
      a: 'Not in Cursor, which infers the transport from the url. Cline takes the same block but needs "type": "streamableHttp" in its remote entry; without it, Cline falls back to SSE and the endpoint answers 405.',
    },
    {
      q: 'Can I give Cursor read-only access?',
      a: `Yes. Choose read-only when you create the key on the Connect page. A read-only key sees ${READ_ONLY_TOOL_COUNT} tools instead of ${ADVERTISED_TOOL_COUNT}, and a write called anyway is refused with READ_ONLY_KEY before it runs. The agent cannot upgrade its own key.`,
    },
    {
      q: 'Can the agent work across several projects?',
      a: 'One key reaches one project, so a leaked key exposes that project and nothing else. The connect tool’s whoami action tells the agent which project and key it is acting as. Projects are created in the dashboard, not by the agent.',
    },
    {
      q: 'Does it work with my existing PostgreSQL database?',
      a: 'No. The MCP server operates a Backenly project, hosted on Backenly Cloud or on your own Backenly install, with a PostgreSQL schema that Backenly manages. You can still reach that database directly with a connection string from the Connect page, and export it with pg_dump.',
    },
    {
      q: 'What can the agent not do without me?',
      a: 'Anything destructive or irreversible. apply_migration refuses DROP statements. Dropping or emptying a table, deleting files or functions, deploying, rolling back and revoking keys are parked on the project’s Autonomy page until a person approves them. The agent can request and poll with check_approval; it cannot approve.',
    },
    {
      q: 'Can I undo something the agent changed?',
      a: 'Yes, from the project’s History: restore that one change, or everything back to a point. History covers the schema, auth, storage, functions, webhooks, environment variables, keys and integrations, and each restore is checked before it runs. Data your app wrote since is never rewound, and a restore that would affect it waits for your approval. The agent can ask for a restore, but only you can approve one.',
    },
  ],

  next: [
    {
      href: '/docs/connect',
      meta: 'Docs',
      title: 'Connect, step by step',
      body: 'Creating a key, every client’s setup, and how your app connects.',
    },
    {
      href: '/mcp',
      meta: 'MCP server',
      title: `The ${ADVERTISED_TOOL_COUNT} tools`,
      body: 'What each tool is for, and which actions wait for a person.',
    },
    {
      href: '/guides/safe-ai-database-changes',
      meta: 'Guide',
      title: 'Safe database changes with AI agents',
      body: 'How a schema change is checked, applied and recovered.',
    },
    {
      href: '/agents/claude-code',
      meta: 'Claude Code',
      title: 'Backenly in Claude Code',
      body: 'Three ways to connect, and what to do before the tools load.',
    },
  ],

  close: {
    title: 'Try it from Cursor',
    lede: 'One free project, no credit card. The Connect page prints your mcp.json block.',
  },
}

export const AGENTS: Record<AgentSlug, AgentPageBase> = {
  'claude-code': CLAUDE_CODE,
  cursor: CURSOR,
}

export { MCP_ENDPOINT }
