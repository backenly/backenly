/**
 * TONE GOVERNOR
 * =============
 * The product confidence layer. Every AI output passes through here
 * before it reaches the client.
 *
 * This is what Replit and Lovable spend enormous effort on:
 * "product confidence behavior" — the AI always sounds decisive, calm,
 * structured, and intentional, even when it fails or is limited.
 *
 * Three axes of control:
 *   1. DECISIVENESS — sounds certain and structured, never uncertain
 *   2. CALMNESS     — never panics even when failing
 *   3. GUIDANCE     — always points to the next meaningful action
 *
 * This module also prevents "empty turns" — every response must produce
 * either meaningful movement OR a clear explanation of why it can't.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToneContext = 'build' | 'error' | 'blocked' | 'question' | 'fallback' | 'greeting'

export interface GovernedResponse {
  message: string
  context: ToneContext
}

// ── Uncertainty patterns to scrub ─────────────────────────────────────────────
// These are language patterns that destroy product confidence.
// Replit/Lovable NEVER produce these — we must strip or rewrite them all.

const UNCERTAINTY_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Sycophantic openers (the AI appearing eager to please)
  { pattern: /^(great!?|sure!?|of course!?|absolutely!?|certainly!?|happy to help!?)[,\s.]*/i, replacement: '' },
  { pattern: /^(no problem!?|got it!?|i understand!?)[,\s.]*/i, replacement: '' },

  // Uncertainty hedges
  { pattern: /\bi'm not (entirely|100%|completely) sure\b/i, replacement: "I'd need more context to be certain" },
  { pattern: /\bit (seems|appears|looks like) (that\s)?/i, replacement: '' },
  { pattern: /\bif i (understand|understood) correctly[,\s]*/i, replacement: '' },
  { pattern: /\bif that makes sense\b/i, replacement: '' },
  { pattern: /\bif you'd like\b/i, replacement: '' },
  { pattern: /\bfeel free to\b/i, replacement: '' },
  { pattern: /\bplease (let me know|tell me)\b/i, replacement: 'tell me' },

  // Trailing invitations that make the AI seem unsure
  { pattern: /\blet me know (if|what|how|whether)[^.!?]*[.!?]?\s*$/i, replacement: '' },
  { pattern: /\bwould you (like|want) me to[^?]*\??/i, replacement: '' },
  { pattern: /\bshould i (also|additionally)[^?]*\??/i, replacement: '' },
  { pattern: /\bis there anything else[^?]*\??/i, replacement: '' },
  { pattern: /\bdo you (want|need|have)[^?]*\??/i, replacement: '' },
  { pattern: /\bwhat would you like[^?]*\??/i, replacement: '' },
  { pattern: /\blet me know[^.]*\./i, replacement: '' },

  // Mechanical completion phrases
  { pattern: /\bi('ve| have) successfully (created|built|set up|configured|added)\b/i, replacement: '' },
  { pattern: /\bi('ve| have) (gone ahead and|taken the liberty)\b/i, replacement: '' },
  { pattern: /\bhere('s| is) what i('ve| have) (done|created|built)\b/i, replacement: '' },
  { pattern: /\bhere('s| is) a (breakdown|summary|overview|list) of\b/i, replacement: '' },

  // Raw telemetry that leaked past the rewriter
  { pattern: /\bFK constraint(s)?\b/gi, replacement: 'relationship' },
  { pattern: /\bforeign key(s)?\b/gi, replacement: 'connection' },
  { pattern: /\bPrisma\b/g, replacement: 'the database' },
  { pattern: /\bpg pool\b/gi, replacement: 'the database' },
  { pattern: /\bworkspace_[a-z0-9_]+\b/gi, replacement: 'your database' },
  { pattern: /\bpublic schema\b/gi, replacement: 'the platform' },
  { pattern: /\bRLS\b/g, replacement: 'security rules' },
  { pattern: /\brow.level.security\b/gi, replacement: 'security rules' },
  { pattern: /\bJWT\b/g, replacement: 'authentication token' },
]

// ── Fallback response library ─────────────────────────────────────────────────
// Intentional, calm fallbacks for every possible failure mode.
// "Empty turns" are forbidden — every path here produces movement or guidance.

const FALLBACK_LIBRARY = {
  noOp: [
    "I'm ready to build. Describe what you'd like to add — tables, auth, file storage, or APIs.",
    "Tell me what to build next: a table, an endpoint, an integration, or a workflow.",
    "What would you like to add to your backend?",
  ],

  ambiguous: [
    "Could you be more specific? For example: 'add a comments table' or 'enable email auth'.",
    "I want to get this right — what exactly should I build?",
    "Be more specific and I'll build it immediately.",
  ],

  credentialMissing: [
    "Paste your API key in chat and I'll activate it immediately.",
    "Drop your API key here — everything else is already wired up.",
    "The integration is ready. Paste your key to go live.",
  ],

  buildFailed: [
    "I ran into an issue with that. Rephrase what you'd like to build and I'll try again.",
    "Something went wrong. Try: 'add a users table' or '/status' to see your current backend.",
    "I couldn't complete that action. Type /status to see what's currently built.",
  ],

  unknownIntent: [
    "I'm not sure what you'd like to do. Type /help to see what I can build, or describe it in plain terms.",
    "Describe what your app needs and I'll build the backend for it.",
    "What should your backend do? I can create tables, APIs, auth, storage, and integrations.",
  ],
} as const

// ── Core tone governance ──────────────────────────────────────────────────────

/**
 * Apply tone governance to any outgoing message.
 * Strips uncertainty language, removes trailing invitations,
 * and ensures the message sounds decisive and product-confident.
 */
export function governTone(raw: string, context: ToneContext = 'build'): string {
  if (!raw || raw.trim().length === 0) {
    return selectFallback(context)
  }

  let result = raw.trim()

  // Apply all uncertainty pattern rewrites
  for (const { pattern, replacement } of UNCERTAINTY_PATTERNS) {
    result = result.replace(pattern, replacement)
  }

  // Clean up artifacts from pattern replacement
  result = result
    .replace(/\s{2,}/g, ' ')       // collapse double spaces
    .replace(/^\s*[,.\-–—]\s*/g, '') // strip leading punctuation
    .replace(/\n{3,}/g, '\n\n')    // collapse excessive newlines
    .trim()

  // Prevent completely empty result
  if (result.length < 5) {
    return selectFallback(context)
  }

  // Ensure the message ends cleanly (no dangling "or" / "and")
  result = result.replace(/\s+(or|and|but|so)\s*\.?\s*$/i, '.')

  return result
}

/**
 * Govern a blocked-state message — always calm, always guiding.
 */
export function governBlockedResponse(
  rawMessage: string,
  providerName?: string,
): string {
  const sanitized = governTone(rawMessage, 'blocked')

  // If sanitization left us with something meaningful, use it
  if (sanitized.length > 20) return sanitized

  // Otherwise use a calm blocked fallback
  const provider = providerName ?? 'the integration'
  return `Everything is configured and ready — paste your ${provider} API key to activate it.`
}

/**
 * Govern an error response — never panics, always guides forward.
 */
export function governErrorResponse(rawError: string): string {
  // Never expose stack traces or internal error codes
  if (/stack trace|at \w+\s*\(|Error:/i.test(rawError)) {
    return "I ran into an unexpected issue. Try rephrasing your request, or type /status to check your backend."
  }

  // Never expose DB connection errors
  if (/ECONNREFUSED|connection refused|getaddrinfo|ETIMEDOUT/i.test(rawError)) {
    return "There was a temporary connection issue. I'll retry automatically — if it persists, refresh the page."
  }

  // Never expose Prisma/SQL errors
  if (/prisma|p\d{4}|syntax error|pg error|column .* does not exist/i.test(rawError)) {
    return "I ran into a schema issue. Type /status to see your current tables, or describe what you'd like to fix."
  }

  // For other errors, sanitize and return
  const sanitized = governTone(rawError, 'error')
  if (sanitized.length > 10) return sanitized

  return "Something went wrong. Describe what you'd like to build and I'll try again."
}

/**
 * Govern a fallback — ensures "empty turns" are never shown to users.
 * Always produces a meaningful forward-moving response.
 */
export function governFallback(context: ToneContext = 'fallback'): string {
  return selectFallback(context)
}

/**
 * Checks if a message is an "empty turn" — a response that produces
 * no meaningful movement. Replit/Lovable forbid these entirely.
 */
export function isEmptyTurn(message: string): boolean {
  if (!message || message.trim().length < 5) return true

  const emptyIndicators = [
    /^(ok|okay|got it|sure|alright|understood)\.?\s*$/i,
    /^(done|complete)\.?\s*$/i,
    /^(processing|working on it)\.?\s*$/i,
    /^null$/i,
    /^undefined$/i,
    /^(yes|no)\.?\s*$/i,
  ]

  return emptyIndicators.some(p => p.test(message.trim()))
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function selectFallback(context: ToneContext): string {
  let pool: readonly string[]

  switch (context) {
    case 'build':
    case 'fallback':
      pool = FALLBACK_LIBRARY.noOp
      break
    case 'error':
      pool = FALLBACK_LIBRARY.buildFailed
      break
    case 'blocked':
      pool = FALLBACK_LIBRARY.credentialMissing
      break
    case 'question':
      pool = FALLBACK_LIBRARY.ambiguous
      break
    default:
      pool = FALLBACK_LIBRARY.unknownIntent
  }

  // Deterministic (not random) — use index 0 for consistency
  return pool[0]
}
