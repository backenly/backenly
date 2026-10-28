/**
 * What the support first responder is told beyond the case text: the agent
 * docs that cover the case, and what the account's own records say.
 *
 * The responder used to get five fixed sentences about the product, so a case
 * like "MCP not connecting to Claude Code" was answered (when it was answered)
 * without the install commands, the start-a-new-session rule or the error codes
 * that settle it. The ground is public/docs/agents: one file per topic, written
 * for a model and held to the live product by
 * tests/unit/agent-docs-conformance.spec.ts. The records add what no doc can:
 * whether the project has an MCP key at all, and whether any client has ever
 * reached Backenly with one.
 */
import type { DocSlug } from '@/app/docs/content'
import { prisma } from '@/lib/db/prisma'
import { AGENT_DOC_TOPICS, agentDocPublicPath } from '@/lib/mcp/agent-docs'
import { readPublicDoc } from '@/lib/mcp/public-docs'
import type { SupportCategory } from './constants'

/** Where each category starts, most relevant first. */
export const CATEGORY_TOPICS: Record<SupportCategory, string[]> = {
  agent: ['client-setup', 'errors', 'connect'],
  api: ['client-setup', 'errors', 'connect'],
  database: ['database', 'errors'],
  auth: ['auth', 'errors'],
  storage: ['storage', 'errors'],
  functions: ['functions', 'errors'],
  realtime: ['realtime'],
  deploy: ['deploy', 'branches'],
  billing: [],
  account: [],
  security: ['connect'],
  other: [],
}

/**
 * Words in the case that name a topic its category does not, checked in order.
 * Curated rather than the registry's aliases: "claude" is an alias of the
 * anthropic topic (calling Claude from a function), and a case about Claude
 * Code connecting over MCP needs client-setup instead.
 */
export const KEYWORD_TOPICS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bmcp\b|claude[\s-]?code|\bcursor\b|\bcodex\b|antigravity|\bcline\b|windsurf|x-api-key|coding agent/i, 'client-setup'],
  [/\b(401|403|429)\b|invalid[_\s]key|no[_\s]auth|read[_\s]only[_\s]key|rate[_\s]limited|plan[_\s]limit|unauthori[sz]ed/i, 'errors'],
  [/\bapi[\s-]?keys?\b|service[\s-]?role|publishable|\benv(ironment)? var/i, 'connect'],
  [/\b(migrations?|schema|columns?|row[\s-]level|rls|sql|postgres|foreign key)\b/i, 'database'],
  [/\b(sign[\s-]?ups?|sign[\s-]?ins?|log[\s-]?in|oauth|jwt|password|magic link|end[\s-]users?)\b/i, 'auth'],
  [/\b(buckets?|uploads?|signed url|file storage)\b/i, 'storage'],
  [/\b(functions?|cron|scheduled?)\b/i, 'functions'],
  [/\b(realtime|subscribe|presence|broadcast)\b/i, 'realtime'],
  [/\bwebhooks?\b/i, 'webhooks'],
  [/\bstripe\b/i, 'stripe'],
  [/\b(resend|sendgrid)\b/i, 'resend'],
  [/\b(branch|branches|preview)\b/i, 'branches'],
  [/\b(deploy|deployment|publish|rollback|roll back)\b/i, 'deploy'],
  [/\b(autonomy|approvals?|approve|healing|findings?)\b/i, 'autonomy'],
]

/** The human docs page for a topic. /docs is written for people; the agent docs are not linked to them. */
const HUMAN_DOC: Partial<Record<string, DocSlug>> = {
  'client-setup': 'connect',
  connect: 'connect',
  database: 'database',
  auth: 'auth',
  storage: 'storage',
  functions: 'functions',
  realtime: 'realtime',
  integrations: 'integrations',
  stripe: 'integrations',
  resend: 'integrations',
  openai: 'integrations',
  anthropic: 'integrations',
  posthog: 'integrations',
  autonomy: 'autonomy',
  monitoring: 'monitoring',
  branches: 'branches',
  deploy: 'deploy',
  webhooks: 'webhooks',
}

const HUMAN_DOC_TITLE: Record<DocSlug, string> = {
  database: 'Database',
  auth: 'Auth & Users',
  storage: 'Storage',
  functions: 'Functions',
  realtime: 'Realtime',
  integrations: 'Integrations',
  autonomy: 'Autonomy',
  monitoring: 'Monitoring',
  branches: 'Branches',
  deploy: 'Deploy',
  connect: 'Connect',
  webhooks: 'Webhooks',
  settings: 'Settings',
}

export const MAX_REFERENCE_TOPICS = 4
/** About 7k tokens: room for the four largest topics, at a few cents per case. */
export const MAX_REFERENCE_CHARS = 28_000

const KNOWN_TOPICS = new Set(AGENT_DOC_TOPICS.map((t) => t.id))
const TOPIC_TITLE = new Map(AGENT_DOC_TOPICS.map((t) => [t.id, t.title]))

/** The agent-doc topics that cover a case: its category's first, then any its text names. */
export function supportDocTopics(category: string, text: string): string[] {
  const picked: string[] = [...(CATEGORY_TOPICS[category as SupportCategory] ?? [])]
  for (const [pattern, topic] of KEYWORD_TOPICS) {
    if (pattern.test(text)) picked.push(topic)
  }
  return Array.from(new Set(picked)).filter((t) => KNOWN_TOPICS.has(t)).slice(0, MAX_REFERENCE_TOPICS)
}

export interface DocLink {
  title: string
  url: string
}

/** The /docs pages a customer can read for these topics, once each. */
export function humanDocLinks(topics: string[], origin: string): DocLink[] {
  const slugs = Array.from(new Set(topics.map((t) => HUMAN_DOC[t]).filter((s): s is DocSlug => !!s)))
  return slugs.map((slug) => ({ title: HUMAN_DOC_TITLE[slug], url: `${origin}/docs/${slug}` }))
}

// The files are part of the build, so a topic read once stays true for the
// life of the process. A miss is not remembered: the HTTP fallback can recover.
const docCache = new Map<string, string>()

async function agentDoc(topic: string): Promise<string> {
  const cached = docCache.get(topic)
  if (cached !== undefined) return cached
  const text = (await readPublicDoc(agentDocPublicPath(topic))).trim()
  if (text) docCache.set(topic, text)
  return text
}

export interface SupportReference {
  /** Topics whose text made it into `text`. */
  topics: string[]
  /** The reference block for the model, or '' when no doc could be read. */
  text: string
}

/** The agent docs for these topics as one reference block, within MAX_REFERENCE_CHARS. */
export async function supportReference(topics: string[]): Promise<SupportReference> {
  const docs = await Promise.all(topics.map(async (topic) => ({ topic, text: await agentDoc(topic).catch(() => '') })))
  const used: string[] = []
  const blocks: string[] = []
  let budget = MAX_REFERENCE_CHARS
  for (const { topic, text } of docs) {
    if (!text || budget < 500) continue
    const body = text.length > budget ? `${text.slice(0, budget)}\n…(truncated)` : text
    budget -= body.length
    used.push(topic)
    blocks.push(`<doc topic="${topic}" title="${TOPIC_TITLE.get(topic) ?? topic}">\n${body}\n</doc>`)
  }
  if (!blocks.length) return { topics: [], text: '' }
  return {
    topics: used,
    text: [
      'Reference: the Backenly docs that cover this case. They are true of the live product; quote commands, paths and error codes from them exactly.',
      ...blocks,
    ].join('\n\n'),
  }
}

/** "3 minutes", "2 hours", "5 days": how far apart two moments are. */
function span(ms: number): string {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60_000))
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} hours`
  return `${Math.round(h / 24)} days`
}

/**
 * What the records say about coding agents reaching Backenly over MCP, for the
 * attached project or, with none attached, for the keys this person created.
 * Counts and timestamps only; never a key. `filedAt` anchors the timing, so
 * "never used" and "used 3 minutes before filing" are told apart.
 */
export async function mcpAccessFacts(
  scope: { projectId: string } | { userId: string },
  filedAt: Date,
): Promise<string[]> {
  const rows = await prisma.apiKey.findMany({
    where: 'projectId' in scope ? { projectId: scope.projectId, scope: 'mcp' } : { userId: scope.userId, scope: 'mcp' },
    select: { keyType: true, mcpReadOnly: true, lastUsed: true, expiresAt: true, projectId: true },
    take: 200,
  })
  const where = 'projectId' in scope ? 'this project' : 'any project of this account'
  if (rows.length === 0) {
    return [`MCP access: no agent key and no browser sign-in connection exists for ${where}, so no coding agent can reach it yet.`]
  }
  const keys = rows.filter((r) => r.keyType !== 'mcp_oauth')
  const connections = rows.length - keys.length
  const readOnly = keys.filter((k) => k.mcpReadOnly).length
  const expired = keys.filter((k) => k.expiresAt && k.expiresAt <= filedAt).length
  const parts = [`${keys.length} agent key${keys.length === 1 ? '' : 's'}`]
  if (readOnly) parts.push(`${readOnly} of them read-only`)
  if (expired) parts.push(`${expired} expired`)
  const lines = [
    `MCP access for ${where}: ${parts.join(', ')}; ${connections} browser sign-in connection${connections === 1 ? '' : 's'}.`,
  ]
  const last = rows.reduce<Date | null>((acc, r) => (r.lastUsed && (!acc || r.lastUsed > acc) ? r.lastUsed : acc), null)
  if (!last) {
    lines.push('None of them has ever made an MCP request: no client has reached Backenly with these credentials.')
  } else {
    const rel = last <= filedAt ? `${span(filedAt.getTime() - last.getTime())} before the case was filed` : 'after the case was filed'
    lines.push(`The latest MCP request with any of them was at ${last.toISOString()} (${rel}).`)
  }
  return lines
}
