/**
 * DOMAIN BLUEPRINT REGISTRY + DETECTOR
 * ====================================
 * Single entry point for the blueprint system.
 *
 *   detectDomain(prompt)  →  BlueprintMatch | null
 *   getBlueprint(domain)  →  Blueprint
 *   getBlueprintForPrompt(prompt)  →  { blueprint, match } | null
 *
 * ROUTING CONTRACT (in authority order):
 *   1. The user's own spec is law. A prompt that carries its own schema
 *      (isExplicitSpec) NEVER hits a curated template — it goes to the LLM
 *      architect, which is instructed to build exactly what was written.
 *   2. Curated templates are a fast-path for SHORT prompts (≤500 chars) that
 *      NAME a known app class via an identity-strength signal ("social
 *      media", "instagram", "marketplace", "saas"…). Circumstantial
 *      vocabulary ("timeline", "posts", "follow-ups") can never select a
 *      template on its own.
 *   3. Everything else → LLM architect reads the full prompt.
 *
 * The curated fast-path is deterministic, free, and debuggable (every match
 * carries the signal that fired it) — but it is a cost optimisation, never
 * an authority over what the user actually asked for.
 */

import type { Blueprint, BlueprintDomain, BlueprintMatch } from './types'
import { SOCIAL_MEDIA_BLUEPRINT } from './social-media'
import { MARKETPLACE_BLUEPRINT } from './marketplace'
import { SAAS_BLUEPRINT } from './saas'
import { CHAT_APP_BLUEPRINT } from './chat-app'
import { BLOG_BLUEPRINT } from './blog'
import { PROJECT_MGMT_BLUEPRINT } from './project-mgmt'

const REGISTRY: Record<BlueprintDomain, Blueprint> = {
  'social-media': SOCIAL_MEDIA_BLUEPRINT,
  'marketplace': MARKETPLACE_BLUEPRINT,
  'saas': SAAS_BLUEPRINT,
  'chat-app': CHAT_APP_BLUEPRINT,
  'blog': BLOG_BLUEPRINT,
  'project-mgmt': PROJECT_MGMT_BLUEPRINT,
}

export function getBlueprint(domain: BlueprintDomain): Blueprint {
  return REGISTRY[domain]
}

/**
 * Each entry: { domain, signals } — `signals` are case-insensitive substrings
 * or whole-word regex patterns. STRONGER signals come first; the detector
 * scores by (count × strength) so a long prompt with multiple keywords
 * still resolves to the right blueprint.
 *
 * The phrasings are tuned for how non-technical founders describe their app
 * (we don't expect them to say "social graph" or "multi-tenant" — they say
 * "instagram" / "twitter" / "ecommerce store" / "marketplace" / "internal
 * project tracker").
 */
type Rule = { domain: BlueprintDomain; signals: Array<{ pattern: RegExp; weight: number; label: string }> }

const RULES: Rule[] = [
  {
    domain: 'social-media',
    signals: [
      { pattern: /\bsocial[\s-]?(media|network(ing)?)\b/i, weight: 5, label: 'social media' },
      { pattern: /\b(instagram|twitter|tiktok|threads|mastodon|bluesky|x\.com)\b/i, weight: 5, label: 'social-network-name' },
      { pattern: /\bfeed\b/i, weight: 3, label: 'feed' },
      // "followers/following" only — bare "follow" false-positives on
      // "follow-up", the core vocabulary of CRM/outreach apps.
      { pattern: /\bfollow(ers|ing)\b/i, weight: 3, label: 'followers/following' },
      { pattern: /\bhashtag(s)?\b/i, weight: 3, label: 'hashtags' },
      { pattern: /\bstor(y|ies)\b/i, weight: 2, label: 'stories' },
      // "timeline" is weak evidence: audit/activity timelines appear in
      // every ops-flavoured app, not just social feeds.
      { pattern: /\btimeline\b/i, weight: 1, label: 'timeline' },
      { pattern: /\bpost(s)?\b/i, weight: 1, label: 'posts' },
      { pattern: /\blike(s)?\b/i, weight: 1, label: 'likes' },
    ],
  },
  {
    domain: 'marketplace',
    signals: [
      { pattern: /\b(marketplace|e-?commerce|online store|shopping app)\b/i, weight: 5, label: 'marketplace' },
      { pattern: /\b(shopify|amazon|etsy|stockx|ebay|walmart)\b/i, weight: 5, label: 'marketplace-name' },
      { pattern: /\bproducts?\b/i, weight: 2, label: 'products' },
      { pattern: /\borders?\b/i, weight: 2, label: 'orders' },
      { pattern: /\bcheckout\b/i, weight: 3, label: 'checkout' },
      { pattern: /\bcart\b/i, weight: 2, label: 'cart' },
      { pattern: /\b(sellers?|vendors?|merchants?)\b/i, weight: 2, label: 'sellers' },
      { pattern: /\b(payments?|payouts?)\b/i, weight: 1, label: 'payments' },
    ],
  },
  {
    domain: 'saas',
    signals: [
      { pattern: /\bsaas\b/i, weight: 5, label: 'saas' },
      { pattern: /\b(subscription|billing)[\s-]?(platform|app|product)?\b/i, weight: 4, label: 'subscription/billing' },
      { pattern: /\b(b2b|multi[\s-]?tenant|workspace|teams?\b.{0,40}\borgs?\b)\b/i, weight: 4, label: 'b2b/multi-tenant' },
      { pattern: /\b(stripe|paddle).{0,30}\b(subscription|invoice|billing)\b/i, weight: 4, label: 'stripe/paddle billing' },
      { pattern: /\b(organi[sz]ations?|tenants?)\b/i, weight: 3, label: 'organizations' },
      { pattern: /\bseats?\b/i, weight: 2, label: 'seats' },
      { pattern: /\bplan(s|s pricing)?\b/i, weight: 1, label: 'plans' },
    ],
  },
  {
    domain: 'chat-app',
    signals: [
      { pattern: /\b(chat|messaging|messenger)[\s-]?(app|platform)?\b/i, weight: 5, label: 'chat/messaging' },
      { pattern: /\b(slack|discord|whatsapp|telegram|signal)\b/i, weight: 5, label: 'chat-app-name' },
      { pattern: /\b(direct messages|dms?)\b/i, weight: 4, label: 'dms' },
      { pattern: /\b(rooms?|channels?)\b.{0,30}\b(chat|message)/i, weight: 3, label: 'rooms/channels' },
      { pattern: /\b(typing indicator|read receipt|presence)\b/i, weight: 3, label: 'typing/presence' },
    ],
  },
  {
    domain: 'blog',
    signals: [
      { pattern: /\b(blog|blogging|cms)\b/i, weight: 5, label: 'blog/cms' },
      { pattern: /\b(substack|medium|ghost|wordpress)\b/i, weight: 5, label: 'blog-platform-name' },
      { pattern: /\b(newsletter|subscribers?|publishing platform)\b/i, weight: 3, label: 'newsletter/publishing' },
      { pattern: /\barticles?\b/i, weight: 2, label: 'articles' },
      { pattern: /\bauthors?\b/i, weight: 1, label: 'authors' },
    ],
  },
  {
    domain: 'project-mgmt',
    signals: [
      { pattern: /\b(project management|task tracker|task management|issue tracker|todo app)\b/i, weight: 5, label: 'pm-app' },
      { pattern: /\b(asana|linear|trello|jira|notion|monday\.com|clickup)\b/i, weight: 5, label: 'pm-tool-name' },
      { pattern: /\b(kanban|sprint|backlog|milestone)\b/i, weight: 4, label: 'kanban/sprint/backlog' },
      { pattern: /\b(task|ticket|issue)s?\b/i, weight: 2, label: 'tasks/tickets' },
      { pattern: /\b(assignee|assigned to)\b/i, weight: 2, label: 'assignees' },
    ],
  },
]

/**
 * Score every rule against the prompt and return the strongest match above a
 * minimum threshold. We score on TOTAL weighted signals so a long, specific
 * prompt ("marketplace with products, orders, sellers, payments, reviews")
 * resolves more confidently than a vague one ("an app with users and posts").
 */
/**
 * A signal at or above this weight means the user NAMED the app class
 * ("social media", "instagram", "marketplace", "saas", "kanban", …) rather
 * than merely using vocabulary that co-occurs with it ("timeline", "posts").
 * A domain may only win on at least one identity signal — circumstantial
 * vocabulary alone must never select a template. This is the rule that stops
 * a founder-outreach CRM ("follow-ups" + "activity timeline") from being
 * built as a social network.
 */
const IDENTITY_WEIGHT = 4

export function detectDomain(prompt: string): BlueprintMatch | null {
  if (!prompt) return null
  const text = prompt.slice(0, 4000) // bound regex work on pathological inputs
  type Hit = { domain: BlueprintDomain; score: number; matchedOn: string[]; named: boolean }
  const hits: Hit[] = []

  for (const rule of RULES) {
    let score = 0
    let named = false
    const matched: string[] = []
    for (const sig of rule.signals) {
      if (sig.pattern.test(text)) {
        score += sig.weight
        matched.push(sig.label)
        if (sig.weight >= IDENTITY_WEIGHT) named = true
      }
    }
    if (score > 0) hits.push({ domain: rule.domain, score, matchedOn: matched, named })
  }

  if (hits.length === 0) return null

  // Only domains the user actually named are eligible to win. Everything
  // else falls through to the LLM architect, which reads the whole prompt.
  const eligible = hits.filter(h => h.named)
  if (eligible.length === 0) return null

  eligible.sort((a, b) => b.score - a.score)
  const winner = eligible[0]

  // Require minimum confidence so a stray "post" word doesn't trigger
  // social-media on a "build a project tracker" prompt.
  if (winner.score < 4) return null

  // Confidence on 0..1: 4 → 0.55, 10+ → 0.95.
  const confidence = Math.min(0.95, 0.4 + winner.score * 0.06)
  return {
    domain: winner.domain,
    confidence,
    matchedOn: winner.matchedOn.join(', '),
  }
}

/** Convenience: detect + lookup against the curated keyword set only (sync). */
export function getCuratedBlueprintForPrompt(prompt: string): { blueprint: Blueprint; match: BlueprintMatch } | null {
  const match = detectDomain(prompt)
  if (!match) return null
  return { blueprint: getBlueprint(match.domain as Parameters<typeof getBlueprint>[0]), match }
}

/**
 * EXPLICIT-SPEC DETECTION — the highest-authority routing rule.
 *
 * When the user's prompt contains its own schema (a "create these tables"
 * list, numbered table sections, bullet column lists, repeated audit columns)
 * they have already done the architecture. No template — curated or otherwise
 * — is allowed to replace their spec. The prompt must reach the LLM architect,
 * which is instructed to treat the user's tables as law.
 *
 * Scored on independent structural signals so a single stray word can't flip
 * it either way; exported for regression tests.
 */
export function isExplicitSpec(prompt: string): boolean {
  if (!prompt) return false
  const text = prompt.slice(0, 12000)
  let score = 0

  // "Create these tables:" / "the following tables" / "tables:" heading
  if (/\b(these|following)\s+(tables?|collections?|models?|entities)\b/i.test(text)) score += 3
  if (/^\s*tables?\s*:/im.test(text)) score += 3

  // Numbered table sections — "3. contacts" on its own line
  const numberedSections = (text.match(/^\s*\d+[.)]\s*[a-z_][a-z0-9_]*\s*$/gim) ?? []).length
  score += Math.min(5, numberedSections)

  // Bullet column lists — "- user_id", "- next_followup_at"
  const bulletColumns = (text.match(/^\s*[-*•]\s*[a-z_][a-z0-9_]{1,40}\s*(:.*)?$/gim) ?? []).length
  score += Math.min(4, Math.floor(bulletColumns / 5))

  // Audit/identity column vocabulary appearing repeatedly
  const auditCols = (text.match(/\b(created_at|updated_at|user_id)\b/gi) ?? []).length
  if (auditCols >= 3) score += 2

  // Inline enum specs — "status: pending, completed, overdue"
  const enumSpecs = (text.match(/^\s*[-*•]?\s*[a-z_]+\s*:\s*[a-z_]+(,\s*[a-z_]+){2,}/gim) ?? []).length
  score += Math.min(2, enumSpecs)

  return score >= 4
}

/**
 * Curated-template eligibility. The curated blueprints are a free,
 * deterministic fast-path for SHORT, template-shaped asks ("build me an
 * instagram clone", "marketplace with products and orders"). Any prompt with
 * real detail deserves the architect actually reading it — a keyword score
 * must never outvote three paragraphs of product description.
 */
const CURATED_MAX_CHARS = 500

export function shouldUseCuratedBlueprint(prompt: string): boolean {
  const trimmed = (prompt ?? '').trim()
  if (trimmed.length === 0 || trimmed.length > CURATED_MAX_CHARS) return false
  return !isExplicitSpec(trimmed)
}

/**
 * Resolve a Blueprint for the user's prompt. Tries the curated keyword
 * fast-path first (free, deterministic, six top domains). When that misses,
 * dispatches to the LLM architect — which designs a comprehensive,
 * production-grade backend for ANY domain the user invents.
 *
 *   • Curated hit         → { blueprint, match: keyword-matched }
 *   • Architect success   → { blueprint, match: { domain, confidence, matchedOn: 'llm-architect' } }
 *   • Architect VAGUE     → { vague: true, askUser }
 *   • Architect failure   → null  (caller falls back to the standard agent loop)
 */
export async function getBlueprintForPrompt(
  prompt: string,
  projectId: string,
): Promise<
  | { blueprint: Blueprint; match: BlueprintMatch; architectTokens: number }
  | { vague: true; askUser: string; architectTokens: number }
  | null
> {
  // The curated fast-path only runs for short, template-shaped prompts that
  // NAME a known app class and carry no schema of their own. Everything else
  // — long descriptions, explicit table specs, ambiguous vocabulary — goes to
  // the architect, which reads the full prompt. The user's own spec is the
  // highest authority; a keyword template must never override it.
  if (shouldUseCuratedBlueprint(prompt)) {
    const curated = getCuratedBlueprintForPrompt(prompt)
    if (curated) return { ...curated, architectTokens: 0 }
  } else {
    console.log(
      `[Blueprints] curated fast-path skipped (len=${prompt?.trim().length ?? 0}, explicitSpec=${isExplicitSpec(prompt)}) → architect`,
    )
  }

  // No curated hit → ask the LLM architect to design the backend.
  const { architectBackend } = await import('./architect')
  const result = await architectBackend(prompt, projectId)
  if (!result) return null
  if ('vague' in result) {
    // Architect ran but returned a clarifying question — those tokens are still
    // real spend, but they're not charged: the user got no built artefact and
    // the next turn will architect again with a sharper prompt. Charging here
    // would double-bill the same build attempt.
    return { vague: true, askUser: result.askUser, architectTokens: 0 }
  }
  return {
    blueprint: result.blueprint,
    match: {
      domain: result.blueprint.domain,
      confidence: 0.85,
      matchedOn: 'llm-architect',
    },
    architectTokens: result.tokensUsed,
  }
}
