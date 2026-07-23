/**
 * SMART ANSWERER
 * ==============
 * Handles the 'evaluate' intent: "is this enough for X?", "what's missing?",
 * "is this production ready?", etc.
 *
 * Unlike generic Q&A, this reads the ACTUAL project state (tables, APIs, auth,
 * storage, functions) and reasons about it against the user's stated purpose.
 * Returns a specific gap analysis like a senior architect reviewing the design.
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'
import { introspectSchema } from './minimal-executor'
import { prisma } from '@/lib/db/prisma'
import type { ConversationTurn } from './intent-classifier'

export interface EvaluationResult {
  /** Full formatted gap analysis message for display */
  message: string
  /** Structured list of missing features extracted from the analysis (for sticky store) */
  gaps: string[]
}

interface ProjectSnapshot {
  tables: string[]
  apiCount: number
  auth: { enabled: boolean; providers: string[] }
  storage: { enabled: boolean; buckets: string[] }
  functions: number
  triggers: number
}

async function getProjectSnapshot(projectId: string): Promise<ProjectSnapshot> {
  const [tables, apiCount, backendGraph, functions, triggers] = await Promise.all([
    prisma.table.findMany({ where: { projectId }, select: { name: true } }).catch(() => []),
    prisma.apiDefinition.count({ where: { projectId } }).catch(() => 0),
    prisma.backendGraph.findFirst({ where: { projectId } }).catch(() => null),
    prisma.aiFunction.count({ where: { projectId } }).catch(() => 0),
    prisma.appTrigger.count({ where: { projectId } }).catch(() => 0),
  ])

  // Extract auth and storage from backend graph if available
  let authEnabled = false
  let authProviders: string[] = []
  let storageEnabled = false
  let storageBuckets: string[] = []

  try {
    const graph = (backendGraph as any)?.graph
    if (graph && typeof graph === 'object') {
      const g = graph as Record<string, any>
      const providers = g.auth?.providers || {}
      authProviders = Object.entries(providers)
        .filter(([, v]: [string, any]) => (typeof v === 'boolean' ? v : v?.enabled === true))
        .map(([k]) => k)
      authEnabled = authProviders.length > 0

      const buckets = g.storage?.buckets || {}
      storageBuckets = Object.keys(buckets)
      storageEnabled = storageBuckets.length > 0
    }
  } catch { /* non-fatal */ }

  return {
    tables: tables.map(t => t.name),
    apiCount,
    auth: { enabled: authEnabled, providers: authProviders },
    storage: { enabled: storageEnabled, buckets: storageBuckets },
    functions,
    triggers,
  }
}

function formatSnapshotForLLM(snap: ProjectSnapshot): string {
  const lines: string[] = []

  if (snap.tables.length > 0) {
    lines.push(`Tables (${snap.tables.length}): ${snap.tables.join(', ')}`)
  } else {
    lines.push('Tables: none')
  }

  lines.push(`APIs: ${snap.apiCount} endpoints`)

  if (snap.auth.enabled) {
    lines.push(`Auth: JWT enabled — providers: ${snap.auth.providers.join(', ') || 'email'}`)
  } else {
    lines.push('Auth: not configured')
  }

  if (snap.storage.enabled) {
    lines.push(`Storage: enabled — buckets: ${snap.storage.buckets.join(', ')}`)
  } else {
    lines.push('Storage: not configured')
  }

  if (snap.functions > 0) lines.push(`Serverless AI functions: ${snap.functions}`)
  if (snap.triggers > 0) lines.push(`Event triggers: ${snap.triggers}`)

  return lines.join('\n')
}

/**
 * Generate a specific, project-aware evaluation response.
 * Reads actual project state and reasons about gaps for the stated use case.
 * Returns both the display message and a structured gaps list for sticky-store binding.
 */
export async function generateSmartEvaluation(
  question: string,
  projectId: string,
  projectName: string,
  recentHistory?: ConversationTurn[],
): Promise<EvaluationResult> {
  try {
    const openai = getOpenAIClient()

    // Load live schema text and structured snapshot in parallel
    const [liveSchema, snap] = await Promise.all([
      introspectSchema(projectId).catch(() => ''),
      getProjectSnapshot(projectId),
    ])

    const snapshotBlock = formatSnapshotForLLM(snap)

    // Use up to 8 recent turns so domain context set earlier in the conversation
    // (e.g. "I'm building a healthcare SaaS") is visible to the evaluator.
    const historyBlock = recentHistory && recentHistory.length > 0
      ? '\n\nRecent conversation:\n' + recentHistory.slice(-8).map(t => {
          const role = t.role === 'ai' ? 'Backenly AI' : 'Developer'
          return `${role}: ${t.content.substring(0, 500)}`
        }).join('\n')
      : ''

    const hasAnything = snap.tables.length > 0 || snap.apiCount > 0 || snap.auth.enabled || snap.storage.enabled

    const systemPrompt = `You are Backenly AI — a senior backend architect reviewing a project called "${projectName}".

The developer is asking you to evaluate whether their current backend is sufficient for a specific purpose.

## Current backend state:
${snapshotBlock}

## Live database schema:
${liveSchema || 'No tables yet.'}
${historyBlock}

## Your task:
Give a direct, specific gap analysis. Do NOT be vague or generic.

Respond with a JSON object in this exact format:
{
  "analysis": "The full formatted gap analysis message (markdown). Start with what they HAVE (✓ checkmarks), then what's MISSING (✗ marks). End with one concrete next step they can take, e.g. \\"Say 'add stripe webhook' to implement payment callbacks\\".",
  "gaps": ["Missing feature 1", "Missing feature 2", ...]
}

Rules for analysis:
- Reference actual table names from the schema above, not hypotheticals
- Be direct. No "it depends", no "you might want to consider"
- If they have nothing built yet, say so clearly and suggest the first thing to build
- Maximum 400 words. Think like a CTO doing a 10-minute architecture review.
- Never end with "let me know if you need anything"

Rules for gaps array:
- List only the MISSING features/components as short imperative phrases
- e.g. ["Add Stripe webhook handler", "Add order_items table", "Enable JWT auth"]
- Empty array [] if the backend is complete for the stated purpose
- Maximum 8 gap items`

    const response = await openai.chat.completions.create({
      model: getModel('respond'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content?.trim() || '{}'
    try {
      const parsed = JSON.parse(raw)
      const message = String(parsed.analysis || '').trim()
      const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.map(String).filter(Boolean) : []
      if (message) return { message, gaps }
    } catch { /* fall through to fallback */ }

    const fallbackMsg = hasAnything
      ? `Your backend has ${snap.tables.length} tables and ${snap.apiCount} APIs. Describe what you're building so I can give a specific gap analysis.`
      : `You haven't built anything yet. Describe your app and I'll identify exactly what to build first.`
    return { message: fallbackMsg, gaps: [] }
  } catch (err) {
    console.error('[SmartAnswerer] Evaluation failed:', err)
    return { message: `I couldn't load your project state right now. Try asking again in a moment.`, gaps: [] }
  }
}

/**
 * PROACTIVE AMBIENT INTELLIGENCE
 * ================================
 * Called automatically after every successful build to generate 1-3 unprompted
 * observations a senior architect would notice — things the developer didn't ask about
 * but would want to know. This is what makes the AI feel like a coworker, not a form.
 *
 * Examples of what this generates:
 *   "Your listings table has no index on category_id — at scale, browsing by category
 *    will be slow. Say 'add index on listings.category_id' to fix this."
 *
 *   "You have user_id on orders but no row-level security — any authenticated user can
 *    read all orders. Say 'add RLS to orders' to protect them."
 *
 *   "You built a marketplace but there's no reviews table — trust is critical for
 *    discovery. Say 'add reviews with rating' to add social proof."
 *
 * Returns a formatted markdown string or empty string if nothing notable was found.
 */
export async function generateProactiveObservations(
  projectId: string,
  builtThisSession: string[],  // table/feature names just created
): Promise<string> {
  try {
    const openai = getOpenAIClient()

    const [liveSchema, snap] = await Promise.all([
      introspectSchema(projectId).catch(() => ''),
      getProjectSnapshot(projectId),
    ])

    // Don't generate observations if nothing was built yet
    if (snap.tables.length === 0) return ''

    const snapshotBlock = formatSnapshotForLLM(snap)
    const sessionSummary = builtThisSession.length > 0
      ? `Just built in this session: ${builtThisSession.join(', ')}`
      : 'No new items built this session'

    const response = await openai.chat.completions.create({
      model: getModel('respond'),
      messages: [
        {
          role: 'system',
          content: `You are a senior backend architect reviewing a project immediately after a build.
Your job is to proactively notice 1-3 non-obvious things the developer did NOT ask about but should know.

ONLY flag things that are:
1. Concretely observable from the schema (not hypothetical)
2. Would matter in production (performance, security, or missing critical feature for the domain)
3. Actionable with a single Backenly command

DO NOT flag:
- Things the user explicitly built (they know)
- Obvious things that every developer knows
- Vague generic advice ("consider adding monitoring")
- More than 3 observations (quality over quantity)

Examples of GOOD observations:
  "Your products table has no index on category_id — category filtering will be slow at scale. Say 'add index on products.category_id'."
  "You have a marketplace with listings but no reviews table — discovery and trust both depend on ratings. Say 'add reviews table with rating'."
  "The orders table has user_id but no row-level security. Any logged-in user can read anyone's orders. Say 'add RLS to orders'."

Examples of BAD observations (too obvious, too vague, already built):
  "Consider adding authentication" (if auth was just built)
  "You might want monitoring" (vague)
  "Make sure to test your APIs" (not actionable via Backenly)

Return ONLY valid JSON:
{"observations": ["observation 1", "observation 2"]}
Return {"observations": []} if there is genuinely nothing non-obvious to note.`,
        },
        {
          role: 'user',
          content: `Project state:
${snapshotBlock}

Live schema:
${liveSchema || '(no schema)'}

${sessionSummary}

What non-obvious things do you notice that the developer should know?`,
        },
      ],
      temperature: 0.3,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content?.trim() || '{}'
    const parsed = JSON.parse(raw)
    const observations: string[] = Array.isArray(parsed.observations)
      ? parsed.observations.map(String).filter((o: string) => o.length > 10).slice(0, 3)
      : []

    if (observations.length === 0) return ''

    return '\n\n**I also noticed:**\n' + observations.map(o => `- ${o}`).join('\n')
  } catch {
    // Non-fatal — proactive observations are best-effort
    return ''
  }
}
