/**
 * Backenly MCP server.
 *
 * Wires the host LLM's stdio transport into Backenly's HTTP surfaces:
 *
 *   Host LLM ──stdio JSON-RPC──> this server ──HTTPS──> backenly.com
 *                                  │
 *                                  ├── tools/list, tools/call        (the 50+ brain tools)
 *                                  └── resources/list, resources/read (live backend state)
 *
 * The tool registry is fetched from /api/mcp/manifest on boot — so when
 * Backenly ships a new brain tool it lights up in every MCP host without
 * users updating this npm package.
 *
 * Resources are a complementary surface: they let the host LLM browse the
 * project state ("list of tables", "list of APIs", "current deploy status")
 * as URIs it can read on demand. This is the difference between agentic
 * MCP servers and dumb tool wrappers — the model can consult state cheaply.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { loadConfig, type ConfigOverrides } from './config.js'
import { BackenlyClient, BackenlyHttpError } from './http.js'
import { getPackageVersion } from './version.js'

interface CatalogTool {
  name: string
  tier: string
  description: string
  inputSchema: any
}

interface ProjectResource {
  uri: string
  name: string
  description: string
  mimeType: string
  /** Tool this resource delegates its read to. */
  tool: string
}

// Tools handled locally by us instead of via /api/mcp/tool.
const LOCAL_TOOLS = new Set(['backend_chat', 'db_query', 'db_insert', 'db_update', 'db_delete'])

// Stable resources that exist on every project. Each maps to a read-only
// brain tool we already have. We deliberately keep this list short — the
// tool surface is the primary path. Resources are for cheap state browsing.
const RESOURCES: ProjectResource[] = [
  { uri: 'backenly://state',     name: 'Live backend state',  description: 'Tables, APIs, auth status, storage buckets, RLS policies, integrations. The single most useful resource — call this first to ground every decision.', mimeType: 'application/json', tool: 'read_backend_state' },
  { uri: 'backenly://tables',    name: 'Tables',              description: 'Every table in this project with column and row counts.',                                                                                                       mimeType: 'application/json', tool: 'list_tables' },
  { uri: 'backenly://apis',      name: 'REST endpoints',      description: 'Every generated REST endpoint (method + path).',                                                                                                                mimeType: 'application/json', tool: 'list_apis' },
  { uri: 'backenly://buckets',   name: 'Storage buckets',     description: 'Storage buckets with public/private and file counts.',                                                                                                          mimeType: 'application/json', tool: 'list_buckets' },
  { uri: 'backenly://triggers',  name: 'Event triggers',      description: 'Insert/update/delete triggers and their actions.',                                                                                                              mimeType: 'application/json', tool: 'list_triggers' },
  { uri: 'backenly://rls',       name: 'RLS policies',        description: 'Row-level-security policies on every table.',                                                                                                                   mimeType: 'application/json', tool: 'list_permissions' },
  { uri: 'backenly://functions', name: 'AI functions',        description: 'Server-side functions: triggers, schedules, active flag.',                                                                                                      mimeType: 'application/json', tool: 'list_ai_functions' },
  { uri: 'backenly://deploy',    name: 'Deploy status',       description: 'Last deploy time, status, commit, environment.',                                                                                                                mimeType: 'application/json', tool: 'get_deploy_status' },
  { uri: 'backenly://metrics',   name: 'Performance metrics', description: 'Request rate, p50/p95 latency, error rate over the last hour.',                                                                                                 mimeType: 'application/json', tool: 'get_metrics' },
  { uri: 'backenly://errors',    name: 'Recent errors',       description: 'Recent 5xx + uncaught exceptions — endpoint, status, message, count.',                                                                                          mimeType: 'application/json', tool: 'get_errors' },
  { uri: 'backenly://usage',     name: 'Plan usage',          description: 'AI credits used, storage, request count vs plan limits.',                                                                                                       mimeType: 'application/json', tool: 'get_usage' },
]

/**
 * The tool surface served when the manifest can't be fetched at boot (a
 * transient backenly.com blip during `claude mcp add`). Deliberately tiny and
 * hand-written from stable schemas so it never drifts from the live catalog:
 * `backend_chat` alone is a complete door (any request in plain English), and
 * the other two let the agent ground itself and self-serve docs. A degraded
 * session is fully capable, not broken — and tool CALLS still hit the live
 * backend, so everything works the moment the platform is reachable again.
 */
const ESSENTIAL_FALLBACK: CatalogTool[] = [
  {
    name: 'backend_chat',
    tier: 'chat',
    description:
      'Run a natural-language backend request through the Backenly brain ("add a posts table with comments", ' +
      '"make the orders API faster"). It plans, executes and returns a summary — the one tool that can do anything. ' +
      'Use this while the full tool catalog is loading.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The natural-language request.' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_backend_state',
    tier: 'read',
    description:
      'Read what is currently true about this backend. Call with no arguments for the grounding overview; ' +
      'pass `section` to drill in. Do this before proposing changes. Side-effect free.',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', description: 'Optional slice, e.g. "schema", "tables", "metrics". Omit for the overview.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_docs',
    tier: 'read',
    description:
      'Fetch Backenly documentation as Markdown so you use the right tools without guessing. ' +
      'No arguments for the full guide, or pass `topic` (e.g. "auth", "database", "storage").',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Optional docs section.' } },
      additionalProperties: false,
    },
  },
]

export async function startServer(overrides: ConfigOverrides = {}) {
  const config = loadConfig(overrides)
  const client = new BackenlyClient(config)
  const version = getPackageVersion()

  // Human-readable project name, captured from the handshake so the greeting
  // the host injects on connect can name the project.
  let projectLabel = ''

  // Tool catalog. Starts as the essential fallback so `tools/list` always has
  // something useful; replaced with the live manifest below when it loads. The
  // greeting's tool count is derived from THIS at connect time, so it can never
  // claim more tools than `tools/list` actually serves.
  let tools: CatalogTool[] = ESSENTIAL_FALLBACK

  // ── Boot handshake ─────────────────────────────────────────────────────────
  // Two failure classes, treated differently and never conflated:
  //   • FATAL config errors — a wrong key (401/403) or a --project that
  //     disagrees with the key. The server genuinely cannot function, and
  //     continuing would be dishonest (or dangerous: building the wrong
  //     backend). Exit with an actionable message BEFORE the transport connects,
  //     so the host reports a clean startup failure, not a mid-session crash.
  //   • TRANSIENT errors — a network blip or a 5xx from backenly.com. The
  //     `BackenlyClient` already retried these three times; if they still fail we
  //     DEGRADE (connect anyway, serve the fallback catalog) instead of exiting.
  //     A brief outage during install must not look like a broken MCP server.
  try {
    const health = await client.health()

    if (config.projectId && health.projectId && config.projectId !== health.projectId) {
      process.stderr.write(
        `[@backenly/mcp-server v${version}] project mismatch — the --project you passed ` +
          `(${config.projectId}) is not the project this key belongs to (${health.projectId}).\n` +
          `Re-copy the install command from your project's Connect → Agents tab.\n`,
      )
      process.exit(1)
    }

    projectLabel = health.project?.name ?? health.projectId
    process.stderr.write(
      `[@backenly/mcp-server v${version}] connected to Backenly — project ` +
        `${projectLabel} (${health.toolCount} tools available)\n`,
    )
  } catch (err) {
    if (err instanceof BackenlyHttpError && err.isAuthFailure) {
      process.stderr.write(
        `[@backenly/mcp-server v${version}] Backenly rejected the API key (HTTP ${err.status}). ` +
          `It is invalid, revoked, or scoped to a different project.\n` +
          `Re-copy the install command from your project's Connect → Agents tab: https://backenly.com/app\n`,
      )
      process.exit(1)
    }
    // Transient — log and carry on degraded. Tools still resolve once reachable.
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[@backenly/mcp-server v${version}] couldn't reach Backenly at boot (${msg}). ` +
        `Starting in degraded mode — backend_chat still works and the full tool list loads once the platform is reachable.\n`,
    )
  }

  // Manifest is the source of the full tool catalog. On success it replaces the
  // fallback; on an auth failure it's fatal (a wrong key that somehow passed the
  // health blip); on any other failure we keep the fallback and stay degraded.
  try {
    const manifest = await client.manifest()
    if (manifest.tools?.length) {
      tools = manifest.tools
    }
  } catch (err) {
    if (err instanceof BackenlyHttpError && err.isAuthFailure) {
      process.stderr.write(
        `[@backenly/mcp-server v${version}] Backenly rejected the API key (HTTP ${err.status}).\n` +
          `Re-copy the install command from your project's Connect → Agents tab: https://backenly.com/app\n`,
      )
      process.exit(1)
    }
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[@backenly/mcp-server v${version}] tool catalog unavailable (${msg}) — serving ${tools.length} essential tools until it loads.\n`,
    )
  }

  // `instructions` ships in the MCP `initialize` response. Hosts like Claude
  // Code inject it into the agent's context on connect, so the agent knows it
  // is wired into Backenly, confirms the connection to the user, and asks what
  // to build — instead of the connection landing silently.
  const server = new Server(
    { name: '@backenly/mcp-server', version },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: buildInstructions(projectLabel, tools.length),
    },
  )

  // ── tools/list ────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  // ── tools/call ────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    try {
      const result = await dispatch(client, name, args)
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { isError: true, content: [{ type: 'text', text: msg }] }
    }
  })

  // ── resources/list ────────────────────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }))

  // ── resources/read ────────────────────────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri
    const resource = RESOURCES.find((r) => r.uri === uri)
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}. Available: ${RESOURCES.map((r) => r.uri).join(', ')}`)
    }

    const result = await client.callTool(resource.tool, {})
    if (!result.ok) {
      throw new Error(result.error ?? `Could not read ${uri}`)
    }
    return {
      contents: [{
        uri,
        mimeType: resource.mimeType,
        text: JSON.stringify({ summary: result.summary, data: result.data }, null, 2),
      }],
    }
  })

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // MCP hosts (Claude Code etc.) send SIGTERM when the user closes the session.
  // Without explicit handlers the process would die mid-write to the transport
  // and leave the host with a half-written JSON-RPC frame, which it logs as
  // "MCP server crashed". The clean-shutdown path closes the transport so
  // the host sees an orderly EOF.
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`[@backenly/mcp-server] received ${signal}, shutting down…\n`)
    try {
      await server.close()
    } catch { /* best effort */ }
    process.exit(0)
  }
  process.on('SIGINT',  () => { void shutdown('SIGINT')  })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  // Surface uncaught failures to stderr instead of dying silently — helps the
  // user file actionable bug reports.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[@backenly/mcp-server] uncaught: ${err.stack ?? err.message}\n`)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[@backenly/mcp-server] unhandled rejection: ${String(reason)}\n`)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

/**
 * The greeting + operating brief the host injects on connect. Kept short on
 * purpose — it costs context on every session, so it earns its place by making
 * the agent (a) confirm the connection, (b) know what Backenly can build, and
 * (c) ground itself in real state before touching anything.
 */
function buildInstructions(projectLabel: string, toolCount: number | null): string {
  const project = projectLabel ? `"${projectLabel}"` : 'this project'
  const via = toolCount ? `${toolCount} Backenly tools` : `Backenly's governed tools`
  return [
    `Backenly is connected. You now have live, governed access to ${project}'s backend`,
    `through ${via} and the backenly:// resources — no backend code required.`,
    ``,
    `WHAT THIS CONNECTION LETS YOU BUILD: database tables, REST APIs, auth & end-user`,
    `accounts, file storage, realtime, event triggers, row-level-security policies, and`,
    `serverless functions. Every change is planned, verified, journaled with a receipt, and`,
    `reversible; destructive or auth-touching changes require explicit human approval.`,
    ``,
    `ON YOUR FIRST REPLY of this session, briefly tell the user that Backenly is connected to`,
    `${project} and ask what they'd like to build or change. Keep it to a sentence or two —`,
    `don't dump this whole list on them.`,
    ``,
    `OPERATING RULES:`,
    `- Ground decisions in real state: read the backenly://state resource (or call`,
    `  read_backend_state) before proposing or making changes. Never guess at tables or config.`,
    `- For natural-language builds ("add a posts table with comments"), use the backend_chat`,
    `  tool. For precise reads and row writes, use the db_* and list_* tools directly.`,
    `- Never fabricate results. If a tool returns nothing or errors, say so plainly.`,
  ].join('\n')
}

/**
 * Turn a failed brain response into an error an agent can act on.
 *
 * ── Why this is not a one-liner ─────────────────────────────────────────────
 *
 * This used to be `throw new Error(result.error ?? 'Brain run failed.')`, and
 * the reported symptom was exactly that string with nothing attached: "Two of
 * three runs returned only `Brain run failed.` — no detail."
 *
 * Three separate things produced that, and all three are fixed:
 *
 *   1. The remote transport STRIPPED `partialEvents` before the agent saw it
 *      (app/api/mcp/route.ts) — the one field describing what actually ran.
 *   2. The stdio transport discarded the same field when building its error
 *      (http.ts) — the server sent a full account and the client kept a
 *      sentence.
 *   3. The fallback here was a bare string with no status, no code, and no
 *      instruction, reached whenever the body had `ok:false` without `error`.
 *
 * A failure that says only "it failed" costs an agent a whole turn of blind
 * retrying — and if the run was PARTIAL, the retry duplicates whatever already
 * landed. Which is why the trail matters more than the message.
 */
function brainFailure(result: {
  ok: boolean
  error?: string
  summary?: string
  toolsRun?: string[]
  iterations?: number
  events?: Array<{ type: string; [k: string]: any }>
}): Error {
  const parts: string[] = []
  parts.push(result.error || result.summary || 'The brain run did not complete.')

  if (result.toolsRun?.length) {
    // The single most important thing an agent can know here: work may already
    // be done. Retrying a partially-applied run creates duplicates.
    parts.push(
      `Tools that ran before it stopped: ${result.toolsRun.join(', ')}. ` +
      `Some of this may already be applied — check with read_backend_state before retrying.`,
    )
  }
  if (result.iterations) parts.push(`Iterations: ${result.iterations}.`)

  const failedStep = result.events?.find((e) => e.type === 'tool_fail')
  if (failedStep) {
    parts.push(`Failed at: ${failedStep.tool ?? 'unknown step'}${failedStep.error ? ` — ${failedStep.error}` : ''}.`)
  }

  if (!result.error && !result.summary) {
    // No message at all from the server. Say THAT, rather than inventing a
    // description of a failure nobody described.
    parts.push(
      'The server reported failure without a reason, which is itself a bug — ' +
      'please report it. Retrying the same message is unlikely to help.',
    )
  }

  return new Error(parts.join(' '))
}

async function dispatch(
  client: BackenlyClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'backend_chat') {
    const message = String(args.message ?? '').trim()
    if (!message) throw new Error('`message` is required.')
    const result = await client.chat(message)
    if (!result.ok) throw brainFailure(result)
    return {
      summary: result.summary,
      needsUser: result.needsUser ?? false,
      toolsRun: result.toolsRun ?? [],
      iterations: result.iterations ?? 0,
    }
  }

  if (name === 'db_query')  return shapeOrThrow(await client.dbQuery(args))
  if (name === 'db_insert') return shapeOrThrow(await client.dbInsert(args))
  if (name === 'db_update') return shapeOrThrow(await client.dbUpdate(args))
  if (name === 'db_delete') return shapeOrThrow(await client.dbDelete(args))

  if (LOCAL_TOOLS.has(name)) {
    throw new Error(`Tool "${name}" is local but not routed. This is a bug.`)
  }
  const result = await client.callTool(name, args)
  if (!result.ok) throw new Error(result.error ?? result.summary ?? `Tool "${name}" failed.`)
  return { summary: result.summary, data: result.data, needsUser: result.needsUser ?? false }
}

function shapeOrThrow<T extends { ok: boolean; error?: string }>(result: T): T {
  if (!result.ok) throw new Error(result.error ?? 'Operation failed.')
  return result
}
