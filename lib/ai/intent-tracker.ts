/**
 * INTENT TRACKER
 * ==============
 * Resolves context-dependent, pronoun-heavy, and reference-heavy messages
 * against prior conversation state and session history.
 *
 * Problem it solves:
 *   "do it"             → last build intent
 *   "fix that"          → last failed component
 *   "add it too"        → last created entity + add feature to it
 *   "use Google instead"→ replace current auth with Google OAuth
 *   "deploy"            → trigger deployment of current project
 *   "continue"          → resume last blocked build
 *   "try again"         → retry last failed action
 *   "what about auth?"  → question about auth in context of current schema
 *
 * This is what separates Replit/Lovable from simpler chatbots:
 * not message parsing, but intent resolution over prior state.
 *
 * Resolution priority:
 *   1. Active session state (AWAITING_INPUT → resolve blocker)
 *   2. Last failed component (for "fix that", "retry")
 *   3. Last created/modified entity (for "add it too", "add field to it")
 *   4. Last build intent (for "do it", "continue", "build it")
 *   5. Context from conversation history (for pronouns like "it", "that")
 */

import type { SessionState } from './workflow-session-state'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IntentResolution {
  /** The resolved, enriched goal for the pipeline */
  resolvedGoal: string
  /** Whether we successfully resolved a vague reference */
  wasResolved: boolean
  /** What type of resolution happened */
  resolutionType:
    | 'blocker_response'    // User responded to a blocker
    | 'retry_last_failed'   // "fix that" / "try again"
    | 'continue_build'      // "do it" / "continue"
    | 'add_to_entity'       // "add it too" / "add [field] to it"
    | 'switch_provider'     // "use Google instead"
    | 'pronoun_resolved'    // generic pronoun from conversation history
    | 'referential_list'    // "start implementing all these updates" / "do everything you suggested"
    | 'no_resolution'       // could not resolve — pass through as-is
  /** Confidence 0–1 */
  confidence: number
}

export interface IntentContext {
  message: string
  sessionState: SessionState | null
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  lastBuiltEntities?: string[]    // tables/integrations built in the last turn
  lastFailedComponents?: string[] // components that failed in the last build
}

// ── Vague reference patterns ───────────────────────────────────────────────────

const RETRY_PATTERNS = [
  /^(try again|retry|fix that|fix it|repair it|repair that|resolve it|resolve that)\s*[.!]?$/i,
  /^(again|one more time|once more)\s*[.!]?$/i,
  /^fix (the (?:error|issue|problem|bug))\s*[.!]?$/i,
]

const CONTINUE_PATTERNS = [
  /^(continue|proceed|go ahead|keep going|keep building|carry on)\s*[.!]?$/i,
  /^(next|what'?s next|next step)\s*[.!]?$/i,
]

const ADD_TO_ENTITY_PATTERNS = [
  /^add (it|that) (to |as well|too)\s*/i,
  /^(also add|add .{1,40} (to|for) (it|that|the (?:table|entity|model)))\s*/i,
  /^(same for|do the same for)\s*/i,
]

const SWITCH_PROVIDER_PATTERNS = [
  /use (\w+) instead/i,
  /switch to (\w+)/i,
  /change (auth|provider|payment) to (\w+)/i,
  /replace .{0,20} with (\w+)/i,
]

const PRONOUN_PATTERNS = [
  /\b(it|that|this|those|them|they)\b/i,
  /\b(the (?:table|model|entity|schema|endpoint|api|function|bucket|integration))\b/i,
  /\b(what you just (built|created|added|made))\b/i,
]

/** Phrases that point to a prior assistant list/recommendation set rather than
 *  any specific entity. Examples:
 *    "start implementing all these updates"
 *    "apply all of those fixes"
 *    "do everything you suggested"
 *    "implement the recommendations"
 *  Resolution prepends the items from the most recent assistant list so the
 *  downstream build runtime sees concrete work instead of a vague phrase.
 *
 *  Bare "all" is only matched when an object noun follows ("all updates",
 *  "all of the fixes") so neutral build phrases like "add all the users"
 *  don't get mis-routed. */
const REFERENTIAL_LIST_PATTERNS: RegExp[] = [
  /\b(?:start|begin|let'?s|go\s+ahead\s+(?:and\s+)?|please\s+)?\s*(?:implement|build|create|add|do|execute|apply|patch|fix|finish|complete|set\s*up|configure|enable|make|tackle|handle|knock\s+out|push\s+through|roll\s+out|ship)(?:s|ing|ed)?\s+(?:up\s+)?(?:the\s+|all\s+(?:of\s+)?)?(?:(?:these|those|them|every(?:thing)?|all\s+of\s+(?:it|them|these|those))(?:\s+(?:of\s+(?:the\s+)?)?(?:updates|changes|fixes|improvements|enhancements|suggestions|recommendations|features|items|things|steps|points|tasks|todos|to-?dos|action\s+items|gaps|issues|problems))?|all\s+(?:of\s+(?:the\s+)?)?(?:updates|changes|fixes|improvements|enhancements|suggestions|recommendations|features|items|things|steps|points|tasks|todos|to-?dos|action\s+items|gaps|issues|problems))\b/i,
  /\b(?:everything|all|the\s+(?:items|points|steps|fixes|updates|recommendations|suggestions|enhancements|improvements|features|things))\s+you\s+(?:just\s+)?(?:suggested|recommended|mentioned|listed|said|told\s+me|proposed|outlined|laid\s+out)\b/i,
]

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * Resolves a potentially vague message into a concrete, actionable goal.
 *
 * Call this BEFORE intent classification.
 * If wasResolved=false, pass the original message to the classifier unchanged.
 */
export function resolveIntent(ctx: IntentContext): IntentResolution {
  const { message, sessionState, conversationHistory, lastBuiltEntities, lastFailedComponents } = ctx
  const trimmed = message.trim()

  // ── 1. Active blocker response — highest priority ─────────────────────
  if (sessionState?.phase === 'AWAITING_INPUT' && sessionState.activeBlocker) {
    const blocker = sessionState.activeBlocker
    // Any substantive message in AWAITING_INPUT is treated as a blocker response
    // (the pendingWorkflowStage handles actual validation)
    return {
      resolvedGoal: trimmed,
      wasResolved: true,
      resolutionType: 'blocker_response',
      confidence: 0.9,
    }
  }

  // ── 2. Retry last failed ───────────────────────────────────────────────
  for (const pattern of RETRY_PATTERNS) {
    if (pattern.test(trimmed)) {
      const failed = lastFailedComponents?.[0]
      if (failed) {
        return {
          resolvedGoal: `Fix and retry: ${failed}`,
          wasResolved: true,
          resolutionType: 'retry_last_failed',
          confidence: 0.85,
        }
      }

      // Check conversation history for last failure mention
      const failureContext = extractLastFailureFromHistory(conversationHistory)
      if (failureContext) {
        return {
          resolvedGoal: `Fix and retry: ${failureContext}`,
          wasResolved: true,
          resolutionType: 'retry_last_failed',
          confidence: 0.7,
        }
      }
      break
    }
  }

  // ── 3. Continue last build ─────────────────────────────────────────────
  for (const pattern of CONTINUE_PATTERNS) {
    if (pattern.test(trimmed)) {
      const pendingTask = sessionState?.pendingTask
      if (pendingTask?.remainingActions?.length) {
        return {
          resolvedGoal: `Continue building: ${pendingTask.originalRequest}. Remaining: ${pendingTask.remainingActions.join(', ')}`,
          wasResolved: true,
          resolutionType: 'continue_build',
          confidence: 0.9,
        }
      }
      // Fall through to sticky intent (handled by sticky-intent-store)
      break
    }
  }

  // ── 4. "Add it too" / "add [X] to it" ────────────────────────────────
  for (const pattern of ADD_TO_ENTITY_PATTERNS) {
    if (pattern.test(trimmed)) {
      const lastEntity = lastBuiltEntities?.[0]
        ?? extractLastEntityFromHistory(conversationHistory)

      if (lastEntity) {
        return {
          resolvedGoal: `${trimmed.replace(/\b(it|that)\b/gi, lastEntity)} (refers to: ${lastEntity})`,
          wasResolved: true,
          resolutionType: 'add_to_entity',
          confidence: 0.75,
        }
      }
      break
    }
  }

  // ── 5. "Use Google instead" / "switch to Stripe" ──────────────────────
  for (const pattern of SWITCH_PROVIDER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) {
      const newProvider = match[1] ?? match[2]
      const context = extractCurrentSystemFromHistory(conversationHistory)
      if (context && newProvider) {
        return {
          resolvedGoal: `Switch ${context} to ${newProvider}`,
          wasResolved: true,
          resolutionType: 'switch_provider',
          confidence: 0.8,
        }
      }
      break
    }
  }

  // ── 5b. Referential list — "start implementing all these updates" ─────
  // Resolves before plain pronoun handling because the trigger phrases
  // include pronouns ("them", "these") that would otherwise hijack the
  // simpler PRONOUN_PATTERNS branch with a single-word resolution.
  if (REFERENTIAL_LIST_PATTERNS.some(p => p.test(trimmed))) {
    const listFromHistory = extractListFromAssistantHistory(conversationHistory)
    if (listFromHistory) {
      const items = listFromHistory.items.length > 0
        ? listFromHistory.items.map(i => `- ${i}`).join('\n')
        : listFromHistory.raw.slice(0, 1500)
      return {
        resolvedGoal: `Implement the items from the previous AI recommendation list:\n\n${items}\n\n[User confirmed: ${trimmed}]`,
        wasResolved: true,
        resolutionType: 'referential_list',
        confidence: 0.85,
      }
    }
    // No prior list found — still mark resolved so downstream stages don't
    // try to compile the bare phrase. Caller falls through to sticky-store
    // or asks the user to be specific instead of inventing a fresh build.
    return {
      resolvedGoal: `${trimmed}\n\n[Referential follow-up — bind to the most recent AI recommendation list. If none exists, ask the user to be specific instead of compiling a fresh build.]`,
      wasResolved: true,
      resolutionType: 'referential_list',
      confidence: 0.55,
    }
  }

  // ── 6. Pronoun resolution from conversation history ───────────────────
  if (PRONOUN_PATTERNS.some(p => p.test(trimmed)) && trimmed.length < 100) {
    const lastEntity = lastBuiltEntities?.[0]
      ?? extractLastEntityFromHistory(conversationHistory)

    if (lastEntity) {
      const resolved = trimmed.replace(/\b(it|that|this)\b/gi, lastEntity)
      if (resolved !== trimmed) {
        return {
          resolvedGoal: resolved,
          wasResolved: true,
          resolutionType: 'pronoun_resolved',
          confidence: 0.65,
        }
      }
    }
  }

  // ── No resolution ─────────────────────────────────────────────────────
  return {
    resolvedGoal: trimmed,
    wasResolved: false,
    resolutionType: 'no_resolution',
    confidence: 1.0,
  }
}

// ── History analysis helpers ──────────────────────────────────────────────────

/** Extracts the most recently mentioned entity from conversation history. */
function extractLastEntityFromHistory(
  history: Array<{ role: string; content: string }>,
): string | null {
  // Scan recent assistant messages for entity names
  const recentAssistant = history
    .filter(h => h.role === 'assistant')
    .slice(-3)
    .reverse()

  for (const turn of recentAssistant) {
    // Look for patterns like "created X table", "X is ready", "added X"
    const match =
      turn.content.match(/(?:created?|built|added?|set up|configured?|ready)[:\s]+(\w+)\s+table/i) ??
      turn.content.match(/(\w+)\s+(?:table|api|bucket|function|integration)\s+(?:is\s+)?ready/i) ??
      turn.content.match(/added?\s+(\w+)\s+to/i)

    if (match?.[1]) return match[1]
  }

  // Also scan recent user messages for the last noun they mentioned
  const recentUser = history
    .filter(h => h.role === 'user')
    .slice(-2)
    .reverse()

  for (const turn of recentUser) {
    const match = turn.content.match(
      /(?:create?|add|build|make)\s+(?:a\s+)?(\w+)\s+(?:table|api|bucket|model|schema)?/i,
    )
    if (match?.[1]) return match[1]
  }

  return null
}

/** Walk recent assistant turns and return the most recent message that looks
 *  like a recommendation list (≥2 bullet/numbered items). Also returns the
 *  parsed items so callers can render a compact, deduped goal instead of the
 *  full transcript.
 *
 *  Intentionally lightweight — does not import the markdown-aware
 *  `lib/ai/list-extractor` to keep this file free of pipeline-specific deps. */
function extractListFromAssistantHistory(
  history: Array<{ role: string; content: string }>,
): { raw: string; items: string[] } | null {
  const recent = [...history].reverse().slice(0, 10)
  for (const turn of recent) {
    if (turn.role !== 'assistant') continue
    if (!turn.content || turn.content.length < 40) continue
    const lines = turn.content.split(/\r?\n/)
    const items: string[] = []
    for (const line of lines) {
      const match = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/)
      if (!match) continue
      const text = match[1]
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim()
      if (text.length >= 4) items.push(text)
      if (items.length >= 20) break
    }
    if (items.length >= 2) {
      return { raw: turn.content, items }
    }
  }
  return null
}

/** Extracts the last failure context from conversation history. */
function extractLastFailureFromHistory(
  history: Array<{ role: string; content: string }>,
): string | null {
  const recentAssistant = history
    .filter(h => h.role === 'assistant')
    .slice(-3)
    .reverse()

  for (const turn of recentAssistant) {
    const match =
      turn.content.match(/(?:failed|error|couldn'?t|issue with)\s+(?:setting up\s+)?(\w+)/i) ??
      turn.content.match(/(\w+)\s+(?:failed|errored|isn'?t working)/i)

    if (match?.[1]) return match[1]
  }

  return null
}

/** Extracts the current system being discussed (auth type, payment provider, etc.) */
function extractCurrentSystemFromHistory(
  history: Array<{ role: string; content: string }>,
): string | null {
  const recent = history.slice(-6)

  for (const turn of [...recent].reverse()) {
    // Auth system
    if (/\b(auth|authentication|sign.?in|login)\b/i.test(turn.content)) return 'auth'
    // Payment
    if (/\b(payment|stripe|billing)\b/i.test(turn.content)) return 'payments'
    // Email
    if (/\b(email|smtp|sendgrid|resend)\b/i.test(turn.content)) return 'email'
    // Storage
    if (/\b(storage|bucket|upload|s3)\b/i.test(turn.content)) return 'storage'
  }

  return null
}

// ── Exported helper for pipeline use ─────────────────────────────────────────

/**
 * Quick check: is this message clearly context-dependent?
 * Use to decide whether to run full intent resolution.
 */
export function isContextDependent(message: string): boolean {
  const trimmed = message.trim()

  // Very short messages are almost always context-dependent
  if (trimmed.length < 20 && !/\b(create|add|build|make|enable|deploy|delete|list)\b/i.test(trimmed)) {
    return true
  }

  const allPatterns = [
    ...RETRY_PATTERNS,
    ...CONTINUE_PATTERNS,
    ...ADD_TO_ENTITY_PATTERNS,
    ...SWITCH_PROVIDER_PATTERNS,
    ...PRONOUN_PATTERNS,
    ...REFERENTIAL_LIST_PATTERNS,
  ]

  return allPatterns.some(p => p.test(trimmed))
}
