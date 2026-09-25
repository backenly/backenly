/**
 * What both MCP transports serve, defined once.
 *
 * Backenly is reached over MCP two ways: the remote endpoint (app/api/mcp) and
 * the stdio package (packages/mcp-server), which runs on the user's machine and
 * cannot import this repository. They used to carry their own copies of the
 * instructions, the resource list and the result shape, and the copies had
 * drifted: the remote endpoint served no resources at all, and a failed call
 * reached an agent as JSON over one transport and as prose over the other.
 *
 * The remote endpoint uses these directly. The stdio package receives the same
 * instructions and resources through /api/mcp/manifest, and shapes results with
 * the same rule, so what an agent sees does not depend on how it connected.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import { leanForAgent } from '@/lib/mcp/agent-response'

/** A readable view of live project state, read through a side-effect free tool. */
export interface McpResourceDescriptor {
  uri: string
  name: string
  description: string
  mimeType: 'application/json'
  /** The read-only tool the read delegates to. */
  tool: string
}

export const MCP_RESOURCES: McpResourceDescriptor[] = [
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

/** The resource list as MCP serves it: the delegate tool is an implementation detail. */
export function publicResources(): Array<Omit<McpResourceDescriptor, 'tool'>> {
  return MCP_RESOURCES.map(({ tool: _tool, ...r }) => r)
}

/**
 * The brief an MCP host injects on connect. Short on purpose: it costs context
 * in every session, so it earns its place by getting the agent to confirm the
 * connection, know what it can do, and ground itself before changing anything.
 */
export function buildMcpInstructions(projectLabel: string, toolCount: number | null): string {
  const project = projectLabel ? `"${projectLabel}"` : 'this project'
  const via = toolCount ? `${toolCount} Backenly tools` : 'Backenly’s governed tools'
  return [
    `Backenly is connected. You now have live, governed access to ${project}'s backend`,
    `through ${via} and the backenly:// resources, with no backend code required.`,
    ``,
    `WHAT YOU CAN BUILD: database tables, REST APIs, auth and end-user accounts, file storage,`,
    `realtime, webhooks, row-level-security policies and server-side functions. Each dashboard`,
    `section has one tool with an \`action\` (auth, storage, functions, realtime, integrations,`,
    `monitoring, autonomy, webhooks, deploy, connect). Every change is planned, verified and`,
    `journaled; destructive or high-risk actions wait for a human's approval.`,
    ``,
    `ON YOUR FIRST REPLY of this session, briefly tell the user Backenly is connected to`,
    `${project} and ask what they'd like to build or change. Keep it to a sentence or two.`,
    ``,
    `OPERATING RULES:`,
    `- Ground decisions in real state: read backenly://state or call read_backend_state before`,
    `  proposing or making changes. Never guess at tables or config.`,
    `- For precise work use run_query, apply_migration, set_rls, db_* and the section tools. Use`,
    `  backend_chat for what you would rather describe than specify.`,
    `- Never fabricate results. If a tool returns nothing or errors, say so plainly.`,
  ].join('\n')
}

/** A tools/call result: the same object as text, for older clients, and as structuredContent. */
export type McpToolResult = CallToolResult & {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
  isError: boolean
}

/**
 * Shape a handler's JSON body into a tools/call result.
 *
 * The body goes through leanForAgent, then out twice: as text, which every
 * client reads, and as structuredContent, which a client can read field by
 * field (ok, code, retryable, applied, partial, approval, …). Nothing is added
 * to it here: a field the handler did not send stays absent.
 *
 * A failure also gets a second text block saying what its fields mean for the
 * next step (see failureGuidance), which is what the stdio package used to send
 * in place of the body.
 */
export function shapeToolResult(body: unknown, ok: boolean): McpToolResult {
  const lean = leanForAgent(body)
  const guidance = ok ? null : failureGuidance(lean)
  return {
    content: [
      { type: 'text', text: JSON.stringify(lean, null, 2) },
      ...(guidance ? [{ type: 'text' as const, text: guidance }] : []),
    ],
    structuredContent: lean,
    isError: !ok,
  }
}

/**
 * What a failed result means for an agent's next step, read only from the
 * fields the handler sent. A field that is absent says nothing, so a body with
 * none of them gets no guidance rather than a guess.
 *
 * What already landed comes first: retrying a partly applied run duplicates
 * whatever succeeded, which is worse than the original failure.
 */
export function failureGuidance(lean: Record<string, unknown>): string | null {
  const parts: string[] = []

  const applied = Array.isArray(lean.applied) ? lean.applied : []
  const trail = Array.isArray(lean.whatRanBeforeItFailed) ? lean.whatRanBeforeItFailed : []
  const toolsRun = Array.isArray(lean.toolsRun) ? lean.toolsRun : []
  if (applied.length) {
    const named = applied.map((a) => (typeof a === 'string' ? a : (a as { summary?: string })?.summary ?? JSON.stringify(a)))
    parts.push(`ALREADY APPLIED, do not repeat: ${named.join('; ')}. Verify with read_backend_state and ask only for what is missing.`)
  } else if (lean.partial === false) {
    parts.push('Nothing was applied.')
  } else if (toolsRun.length || trail.length) {
    parts.push('Steps ran before it stopped, so some of this may already be applied: check with read_backend_state before retrying.')
  }

  if (lean.retryable === true) {
    const ms = typeof lean.retryAfterMs === 'number' ? lean.retryAfterMs : null
    parts.push(`This is transient: the same request is worth retrying after ${ms ? `${Math.round(ms / 1000)}s` : 'a moment'}.`)
  } else if (lean.retryable === false) {
    parts.push('Retrying the identical request will fail the same way; change the request.')
  }

  if (!lean.error && !lean.summary) {
    parts.push('The server reported a failure without a reason, which is itself a bug worth reporting.')
  }

  return parts.length ? parts.join(' ') : null
}
