/**
 * The agent docs: one short index and one file per topic.
 *
 * public/llms.txt used to be the whole guide in one file, 34 KB of it, and
 * `fetch_docs { topic }` cut a section out by matching the topic against its
 * headings. An agent asking about Stripe got the integrations section with
 * every other provider in it, one asking about "deploy" got whatever heading
 * contained the word first, and the file also carried pricing and positioning
 * copy that every coding agent paid for in context and none could act on.
 *
 * Now llms.txt is an index and each topic is its own file under
 * public/docs/agents/, served at https://backenly.com/docs/agents/<id>.md and
 * by fetch_docs. This registry is the one list of topics: fetch_docs routes by
 * it, its description is built from it, the index links it, and
 * tests/unit/agent-docs-conformance.spec.ts holds all four to it.
 *
 * Kept free of imports so the catalog can read it without pulling in the
 * domain tables (the generated tables are lib/mcp/agent-docs-render.ts).
 */

export interface AgentDocTopic {
  id: string
  title: string
  /** One line for the index. */
  summary: string
  /** The section tool this topic documents; its action table is generated from lib/mcp/domains.ts. */
  domain?: string
  /** Other words fetch_docs accepts for this topic, including the section names it matched before. */
  aliases?: string[]
}

export const AGENT_DOC_TOPICS: AgentDocTopic[] = [
  { id: 'client-setup', title: 'Connecting a client', summary: 'MCP setup per host, the CLI when the tools are not loaded yet, the REST base and headers, the SDK', aliases: ['mcp', 'setup', 'install', 'cli', 'sdk', 'rest'] },
  { id: 'database', title: 'Database', summary: 'reading schema, migrations, row writes, row-level security, types, direct access', aliases: ['db', 'schema', 'rls', 'sql', 'migrations', 'tables'] },
  { id: 'auth', title: 'End-user auth', summary: 'sign-up and sign-in for the app you are building, OAuth providers, auth email', domain: 'auth', aliases: ['users', 'authentication', 'smtp'] },
  { id: 'storage', title: 'Storage', summary: 'buckets, files and signed URLs', domain: 'storage', aliases: ['files', 'buckets'] },
  { id: 'functions', title: 'Functions', summary: 'server-side code: the two runtime contracts, deploying code you wrote, running it, its logs, schedules', domain: 'functions', aliases: ['function', 'cron', 'schedules', 'deploy_code'] },
  { id: 'realtime', title: 'Realtime', summary: 'table change events over SSE, presence and broadcast', domain: 'realtime', aliases: ['sse', 'presence', 'broadcast'] },
  { id: 'integrations', title: 'Integrations', summary: 'connecting provider keys and calling providers from functions', domain: 'integrations', aliases: ['providers', 'integration'] },
  { id: 'stripe', title: 'Stripe', summary: 'payments: connecting, the signed webhook receiver, ctx.integrations.stripe', aliases: ['payments', 'checkout'] },
  { id: 'resend', title: 'Resend', summary: 'email: connecting, ctx.integrations.email.send, SendGrid', aliases: ['email', 'sendgrid'] },
  { id: 'openai', title: 'OpenAI', summary: 'completions and embeddings from functions', aliases: ['embeddings'] },
  { id: 'anthropic', title: 'Anthropic', summary: 'Claude completions from functions', aliases: ['claude'] },
  { id: 'posthog', title: 'PostHog', summary: 'analytics events and feature flags from functions', aliases: ['analytics'] },
  { id: 'autonomy', title: 'Autonomy and approvals', summary: 'the maintenance loop, findings, and how a parked action is approved and polled', domain: 'autonomy', aliases: ['approvals', 'approval', 'findings', 'maintenance'] },
  { id: 'monitoring', title: 'Monitoring', summary: 'metrics, errors, request logs, usage', domain: 'monitoring', aliases: ['metrics', 'logs', 'request-logs', 'alerts', 'usage'] },
  { id: 'branches', title: 'Branches', summary: 'preview branches: create, diff, merge (Backenly Cloud)', aliases: ['branch', 'preview'] },
  { id: 'deploy', title: 'Deploy', summary: 'readiness, publishing, history and rollback', domain: 'deploy', aliases: ['deployments', 'rollback', 'readiness', 'publish'] },
  { id: 'webhooks', title: 'Webhooks', summary: 'signed outbound endpoints, test deliveries, replays, trigger webhooks', domain: 'webhooks', aliases: ['webhook', 'triggers'] },
  { id: 'connect', title: 'Keys, env and connections', summary: 'which project a connection acts on, API keys, env variables, database credentials, connected apps', domain: 'connect', aliases: ['keys', 'api-keys', 'env', 'whoami', 'credentials'] },
  { id: 'errors', title: 'Errors', summary: 'the error shape and the codes an agent should branch on', aliases: ['error', 'codes', 'troubleshooting'] },
]

export const AGENT_DOCS_URL = 'https://backenly.com/docs/agents'

/** The file under public/ that holds a topic. */
export function agentDocPublicPath(id: string): string {
  return `docs/agents/${id}.md`
}

function normalise(word: string): string {
  return word.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/** The topic `word` names, by id or alias, in any case and with `_` or `-`. */
export function resolveDocTopic(word: string): AgentDocTopic | null {
  const w = normalise(word)
  if (!w) return null
  return AGENT_DOC_TOPICS.find((t) => t.id === w || (t.aliases ?? []).some((a) => normalise(a) === w)) ?? null
}
