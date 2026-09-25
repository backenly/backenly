/**
 * Backenly MCP server.
 *
 * Wires the host LLM's stdio transport into Backenly's HTTP surfaces:
 *
 *   Host LLM ──stdio JSON-RPC──> this server ──HTTPS──> backenly.com
 *                                  │
 *                                  ├── tools/list  (the advertised allowlist)
 *                                  ├── tools/call  (wider: every dispatchable tool)
 *                                  └── resources/list, resources/read (live backend state)
 *
 * Those two are deliberately different sizes, and the gap is the design.
 * `tools/list` returns the allowlist from lib/mcp/catalog.ts, capped because
 * tool-selection accuracy degrades as a catalog grows. `tools/call` will still
 * execute anything `buildDispatchable()` emits, so an agent pinned to an older
 * manifest that still has `list_tables` in context does not get a 404. Neither
 * number is hardcoded here on purpose: `tools/list` on this server is the
 * authority, and lib/mcp/catalog.ts is the single definition behind it.
 *
 * The tool registry, the connection instructions and the resource list are
 * fetched from /api/mcp/manifest on boot, so when Backenly ships a new tool it
 * lights up in every MCP host without users updating this npm package.
 *
 * The official MCP SDK owns the protocol, for both eras: a 2025-era host opens
 * with `initialize`, a 2026-07-28 one with `server/discover`, and one factory
 * serves either. What this package serves is what the remote endpoint
 * (app/api/mcp) serves: calls go to the same two handlers (/api/mcp/tool and
 * /api/mcp/chat) and come back in the same shape (./result.ts), so an agent
 * sees the same thing whichever way it connected.
 */

import { ResourceNotFoundError, Server } from '@modelcontextprotocol/server'
import type { CallToolResult, Tool } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { loadConfig, type ConfigOverrides } from './config.js'
import { BackenlyClient, BackenlyHttpError, type ManifestResource, type ManifestTool } from './http.js'
import { shapeToolResult, type McpToolResult } from './result.js'
import { getPackageVersion } from './version.js'

/**
 * The resources served when the manifest does not list them: a server older
 * than manifest 1.1.0, or a boot that could not reach Backenly. Each reads
 * through a side-effect free tool.
 */
const FALLBACK_RESOURCES: ManifestResource[] = [
  { uri: 'backenly://state', name: 'Live backend state', description: 'Tables, APIs, auth status, storage buckets, RLS policies, integrations. Read this first to ground every decision.', mimeType: 'application/json', tool: 'read_backend_state' },
  { uri: 'backenly://tables', name: 'Tables', description: 'Every table in this project with column and row counts.', mimeType: 'application/json', tool: 'list_tables' },
  { uri: 'backenly://apis', name: 'REST endpoints', description: 'Every REST endpoint the project serves (method and path).', mimeType: 'application/json', tool: 'list_apis' },
  { uri: 'backenly://buckets', name: 'Storage buckets', description: 'Storage buckets with their visibility and file counts.', mimeType: 'application/json', tool: 'list_buckets' },
  { uri: 'backenly://triggers', name: 'Event triggers', description: 'Insert, update and delete triggers and their actions.', mimeType: 'application/json', tool: 'list_triggers' },
  { uri: 'backenly://rls', name: 'RLS policies', description: 'Row-level security policies on every table.', mimeType: 'application/json', tool: 'list_permissions' },
  { uri: 'backenly://functions', name: 'Functions', description: 'Server-side functions: triggers, schedules, on/off state.', mimeType: 'application/json', tool: 'list_ai_functions' },
  { uri: 'backenly://deploy', name: 'Deploy status', description: 'The live version, when it shipped and its state.', mimeType: 'application/json', tool: 'get_deploy_status' },
  { uri: 'backenly://metrics', name: 'Performance metrics', description: 'Request rate, p50/p95 latency and error rate over the last hour.', mimeType: 'application/json', tool: 'get_metrics' },
  { uri: 'backenly://errors', name: 'Recent errors', description: 'Recent 5xx errors grouped by endpoint, with status, message and count.', mimeType: 'application/json', tool: 'get_errors' },
  { uri: 'backenly://usage', name: 'Plan usage', description: 'AI credits, storage and request count against the plan limits.', mimeType: 'application/json', tool: 'get_usage' },
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
const ESSENTIAL_FALLBACK: ManifestTool[] = [
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
  const log = (line: string) => process.stderr.write(`[@backenly/mcp-server v${version}] ${line}\n`)

  // Human-readable project name, captured from the handshake so the greeting
  // the host injects on connect can name the project.
  let projectLabel = ''

  // What the server serves. Starts as the local fallback so `tools/list` always
  // has something useful; replaced by the live manifest when it loads. The
  // greeting's tool count is derived from THIS at connect time, so it can never
  // claim more tools than `tools/list` actually serves.
  let tools: ManifestTool[] = ESSENTIAL_FALLBACK
  let resources: ManifestResource[] = FALLBACK_RESOURCES
  let instructions: string | null = null

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
      log(
        `project mismatch — the --project you passed (${config.projectId}) is not the project this key ` +
          `belongs to (${health.projectId}).\nRe-copy the install command from your project's Connect → Agents tab.`,
      )
      process.exit(1)
    }

    projectLabel = health.project?.name ?? health.projectId
    log(`connected to Backenly — project ${projectLabel} (${health.toolCount} tools available)`)
  } catch (err) {
    if (err instanceof BackenlyHttpError && err.isAuthFailure) {
      log(
        `Backenly rejected the API key (HTTP ${err.status}). It is invalid, revoked, or scoped to a different project.\n` +
          `Re-copy the install command from your project's Connect → Agents tab: https://backenly.com/app`,
      )
      process.exit(1)
    }
    // Transient — log and carry on degraded. Tools still resolve once reachable.
    const msg = err instanceof Error ? err.message : String(err)
    log(
      `couldn't reach Backenly at boot (${msg}). Starting in degraded mode — backend_chat still works ` +
        `and the full tool list loads once the platform is reachable.`,
    )
  }

  // The manifest is the source of the full catalog. On success it replaces the
  // fallback; on an auth failure it's fatal (a wrong key that somehow passed the
  // health blip); on any other failure we keep the fallback and stay degraded.
  let catalogLoaded = false
  const adopt = (manifest: Awaited<ReturnType<BackenlyClient['manifest']>>): boolean => {
    if (!manifest.tools?.length) return false
    tools = manifest.tools
    if (manifest.resources?.length) resources = manifest.resources
    if (typeof manifest.instructions === 'string' && manifest.instructions) instructions = manifest.instructions
    catalogLoaded = true
    return true
  }
  try {
    adopt(await client.manifest())
  } catch (err) {
    if (err instanceof BackenlyHttpError && err.isAuthFailure) {
      log(
        `Backenly rejected the API key (HTTP ${err.status}).\n` +
          `Re-copy the install command from your project's Connect → Agents tab: https://backenly.com/app`,
      )
      process.exit(1)
    }
    const msg = err instanceof Error ? err.message : String(err)
    log(`tool catalog unavailable (${msg}) — serving ${tools.length} essential tools until it loads.`)
  }

  // ── The server for the connection ──────────────────────────────────────────
  // serveStdio calls the factory for the instance that serves the connection
  // (and once more for a probe it discards if the host falls back to the 2025
  // handshake), so the last instance built is the one serving. Handlers read
  // the current catalog on every request, so a recovered catalog is served the
  // moment it loads.
  let serving: Server | null = null

  const buildServer = (): Server => {
    // `instructions` reaches the host on connect; hosts like Claude Code inject
    // it into the agent's context, so the agent knows it is wired into Backenly
    // and confirms the connection instead of the connection landing silently.
    // `listChanged` because the tool list really can change: a catalog that
    // failed to load at boot is replaced once it loads (see recoverCatalog).
    const server = new Server(
      { name: '@backenly/mcp-server', version },
      {
        capabilities: { tools: { listChanged: true }, resources: {} },
        instructions: instructions ?? buildInstructions(projectLabel, tools.length),
      },
    )

    server.setRequestHandler('tools/list', async () => ({ tools: tools.map(toMcpTool) }))

    server.setRequestHandler('tools/call', async (req) => {
      const result = await callTool(client, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
      return server.projectCallToolResult(result as CallToolResult, undefined)
    })

    server.setRequestHandler('resources/list', async () => ({
      resources: resources.map(({ tool: _tool, ...r }) => r),
    }))

    server.setRequestHandler('resources/read', async (req) => {
      const uri = req.params.uri
      const resource = resources.find((r) => r.uri === uri)
      if (!resource) {
        throw new ResourceNotFoundError(uri, `Unknown resource: ${uri}. Available: ${resources.map((r) => r.uri).join(', ')}`)
      }
      const result = await callTool(client, resource.tool, {})
      if (result.isError) {
        throw new Error(String(result.structuredContent.error ?? `Could not read ${uri}`))
      }
      return { contents: [{ uri, mimeType: resource.mimeType, text: result.content[0].text }] }
    })

    serving = server
    return server
  }

  // Surface uncaught failures to stderr instead of dying silently — helps the
  // user file actionable bug reports.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[@backenly/mcp-server] uncaught: ${err.stack ?? err.message}\n`)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[@backenly/mcp-server] unhandled rejection: ${String(reason)}\n`)
  })

  const handle = serveStdio(buildServer, {
    legacy: 'serve',
    onerror: (err) => process.stderr.write(`[@backenly/mcp-server] protocol error: ${err.message}\n`),
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
      await handle.close()
    } catch { /* best effort */ }
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  if (!catalogLoaded) recoverCatalog()

  // ── Catalog recovery ──────────────────────────────────────────────────────
  // A manifest that failed at boot used to be fetched exactly once, so a brief
  // outage during install left the session on the three fallback tools for its
  // whole life while the log promised the full list would load. It is retried
  // in the background until it loads, and the host is told the list changed:
  // a 2025-era host gets `notifications/tools/list_changed`, a 2026-07-28 host
  // gets it on its `subscriptions/listen` stream, and either re-reads the list.
  // A key rejected mid-recovery stops the retries: every call will fail the
  // same way, and saying so once is the useful thing.
  function recoverCatalog(attempt = 0): void {
    const override = Number(process.env.BACKENLY_MCP_CATALOG_RETRY_MS)
    const delay = override > 0 ? override : CATALOG_RETRY_MS[Math.min(attempt, CATALOG_RETRY_MS.length - 1)]
    const timer = setTimeout(async () => {
      try {
        if (!adopt(await client.manifest())) return recoverCatalog(attempt + 1)
        log(`tool catalog loaded (${tools.length} tools).`)
        await serving?.sendToolListChanged().catch(() => {})
      } catch (err) {
        if (err instanceof BackenlyHttpError && err.isAuthFailure) {
          log(
            `Backenly rejected the API key (HTTP ${err.status}) while loading the tool catalog. ` +
              `Re-copy the install command from your project's Connect → Agents tab.`,
          )
          return
        }
        recoverCatalog(attempt + 1)
      }
    }, delay)
    // Never the reason the process stays alive: stdio owns the lifetime.
    timer.unref()
  }
}

/** Retry delays for a catalog that failed to load at boot; the last repeats. */
const CATALOG_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000]

/** A manifest tool as tools/list serves it. The same mapping as the remote endpoint's. */
function toMcpTool(t: ManifestTool): Tool {
  return {
    name: t.name,
    ...(t.annotations?.title ? { title: t.annotations.title } : {}),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  } as Tool
}

/**
 * Run one tool through the handler the remote endpoint uses for it, and shape
 * the result the way the remote endpoint does.
 *
 * backend_chat runs the brain at /api/mcp/chat; every other tool, the db_* row
 * tools included, goes to /api/mcp/tool. Those used to go to /api/mcp/db/*,
 * which answer in a different shape, so the same call looked different over
 * stdio than over the remote endpoint.
 *
 * A refusal is the server's own body (its `code`, `hint`, `applied`), not a
 * sentence made from it. Only a failure that never reached a response has no
 * body, and then the result says so in the client's own words.
 */
async function callTool(client: BackenlyClient, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const body =
      name === 'backend_chat'
        ? await client.chat(typeof args.message === 'string' ? args.message : '')
        : await client.callTool(name, args)
    return shapeToolResult(body, (body as { ok?: unknown })?.ok !== false)
  } catch (err) {
    if (err instanceof BackenlyHttpError && err.body) return shapeToolResult(err.body, false)
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof BackenlyHttpError ? err.code : undefined
    return shapeToolResult({ ok: false, error: message, ...(code ? { code } : {}) }, false)
  }
}

/**
 * The brief served when the manifest does not carry one: a server older than
 * manifest 1.1.0, or a boot that could not reach Backenly. With a current
 * manifest the package serves the remote endpoint's own text instead.
 *
 * It names no tool beyond backend_chat on purpose: without the manifest the
 * package cannot know which tools the server offers, and a brief that promises
 * tools the list does not have sends the agent looking for them.
 */
function buildInstructions(projectLabel: string, toolCount: number | null): string {
  const project = projectLabel ? `"${projectLabel}"` : 'this project'
  const via = toolCount ? `${toolCount} Backenly tools` : 'Backenly’s governed tools'
  return [
    `Backenly is connected. You now have live, governed access to ${project}'s backend`,
    `through ${via} and the backenly:// resources, with no backend code required.`,
    ``,
    `WHAT YOU CAN BUILD: database tables, REST APIs, auth and end-user accounts, file storage,`,
    `realtime, webhooks, row-level-security policies and server-side functions. Every change is`,
    `planned, verified and journaled; destructive or high-risk actions wait for a human's approval.`,
    ``,
    `ON YOUR FIRST REPLY of this session, briefly tell the user Backenly is connected to`,
    `${project} and ask what they'd like to build or change. Keep it to a sentence or two.`,
    ``,
    `OPERATING RULES:`,
    `- Ground decisions in real state: read backenly://state or call read_backend_state before`,
    `  proposing or making changes. Never guess at tables or config.`,
    `- Use the tools this server lists. backend_chat takes any request in plain English.`,
    `- Never fabricate results. If a tool returns nothing or errors, say so plainly.`,
  ].join('\n')
}
