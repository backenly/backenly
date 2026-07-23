/**
 * PRODUCT RESPONSE REWRITER
 * =========================
 * The orchestration layer that separates "reasoning" from "presentation".
 *
 * Raw execution telemetry → polished product communication.
 *
 * This is the single biggest perceived-intelligence lever:
 * Replit, Lovable, and Base44 never expose internal execution states.
 * They convert everything into calm, decisive, user-facing product language.
 *
 * Rules:
 *  - NEVER expose raw agent telemetry ("RLS applied to 5/6 tables")
 *  - NEVER expose partial build states ("Partial — structure built")
 *  - NEVER expose internal routing decisions
 *  - NEVER expose unfinished execution states
 *  - ALWAYS sound intentional, even in failure
 *  - ALWAYS produce a next-step or next-action if possible
 *  - ALWAYS maintain product confidence voice
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RawExecutionOutput {
  message?: string
  success?: boolean
  error?: string
  built?: Array<{ label?: string; id?: string; type?: string }>
  blocked?: Array<{ label?: string; id?: string; reason?: string }>
  artifacts?: {
    tables?: string[]
    apis?: Array<{ method: string; path: string }>
    buckets?: string[]
    functions?: string[]
    auth?: boolean
  }
}

export interface RewrittenResponse {
  message: string
  /** Whether the UI should show this as a success state */
  isSuccess: boolean
  /** Whether the user needs to provide something */
  isBlocked: boolean
  /** Structured next steps (shown as suggestion chips) */
  nextActions?: string[]
}

// ── Telemetry pattern map ─────────────────────────────────────────────────────
// Maps raw internal language → polished product language.
// Order matters — more specific patterns first.

const TELEMETRY_REWRITES: Array<{ pattern: RegExp; replacement: string | ((m: RegExpMatchArray) => string) }> = [
  // Partial completion states
  {
    pattern: /partial[—\-–\s]+structure built/i,
    replacement: 'Your backend structure is ready. Some components are still being configured.',
  },
  {
    pattern: /rls applied to (\d+)\/(\d+) tables?/i,
    replacement: (m) => `Security rules are configured${m[1] === m[2] ? '' : ` — ${m[2] === '1' ? 'one table' : `one table`} has a permission rule that needs your attention`}.`,
  },
  {
    pattern: /build complete/i,
    replacement: 'Your backend is ready.',
  },
  {
    pattern: /waiting for credentials/i,
    replacement: 'Everything is built — paste your API key in chat to activate the integration.',
  },
  {
    pattern: /next:\s*connect\s+(\w+)/i,
    replacement: (m) => `Paste your ${m[1]} API key to finish the integration.`,
  },
  // Raw executor vocabulary leaking through
  {
    pattern: /^done:\s*/i,
    replacement: '',
  },
  {
    pattern: /^fixed:\s*/i,
    replacement: '',
  },
  {
    pattern: /fk constraints?:\s*\d+ enforced/i,
    replacement: '',
  },
  {
    pattern: /build paused\s*[—\-–]\s*credentials missing for:\s*/i,
    replacement: 'Almost there — paste your ',
  },
  // Generic fallback / empty turn leakage
  {
    pattern: /nothing changed[—\-–\s]+i could not identify a safe action/i,
    replacement: "I didn't catch what you'd like to change. Try describing what you want to add or adjust, or type /status to see your current backend.",
  },
  {
    pattern: /build produced no response/i,
    replacement: "I ran into an issue processing that. Try rephrasing or type /status to see your current backend.",
  },
  {
    pattern: /could not identify what to build/i,
    replacement: "Could you be more specific? For example: 'add a comments table' or 'enable auth'.",
  },
  // Expose internal routing
  {
    pattern: /routing to\s+\w+/i,
    replacement: '',
  },
  {
    pattern: /sub-?behavior[:\s]+\w+/i,
    replacement: '',
  },
  {
    pattern: /pipeline\s+stage/i,
    replacement: '',
  },
]

// ── Blocked-state rewrites ────────────────────────────────────────────────────
// Convert technical block reasons into calm, specific, guided messages.

const BLOCKED_REWRITES: Record<string, string> = {
  stripe: 'Your Stripe integration is scaffolded and ready. Paste your Stripe secret key (sk_live_... or sk_test_...) to activate payments.',
  resend: 'Email sending is wired up. Paste your Resend API key to activate transactional emails.',
  sendgrid: 'Email sending is wired up. Paste your SendGrid API key to activate transactional emails.',
  openai: 'The AI features are ready. Paste your OpenAI API key to activate them.',
  twilio: 'SMS notifications are wired up. Paste your Twilio credentials to activate them.',
  github: 'GitHub integration is ready. Paste your GitHub OAuth credentials to activate social login.',
  google: 'Google login is scaffolded. Paste your Google OAuth credentials to activate it.',
  aws: 'S3 storage is configured. Paste your AWS credentials to activate file uploads.',
  cloudinary: 'Image storage is ready. Paste your Cloudinary API key to activate it.',
  pusher: 'Realtime is wired up. Paste your Pusher credentials to activate live events.',
}

// ── Core rewrite function ─────────────────────────────────────────────────────

/**
 * Converts raw executor output into polished product-facing language.
 * This is the single post-processing gate all AI outputs pass through.
 */
export function rewriteResponse(raw: RawExecutionOutput): RewrittenResponse {
  const blocked = raw.blocked ?? []
  const built = raw.built ?? []
  const hasBuilt = built.length > 0
  const hasBlocked = blocked.length > 0
  const isSuccess = raw.success ?? hasBuilt

  // ── Case 1: Blocked on credentials ───────────────────────────────────────
  if (hasBlocked && !hasBuilt) {
    const firstBlock = blocked[0]
    const label = (firstBlock?.label ?? firstBlock?.id ?? '').toLowerCase()
    const reason = firstBlock?.reason ?? ''

    // Find best credential prompt from known providers
    const knownProvider = Object.entries(BLOCKED_REWRITES).find(
      ([key]) => label.includes(key) || reason.toLowerCase().includes(key)
    )

    if (knownProvider) {
      return {
        message: knownProvider[1],
        isSuccess: false,
        isBlocked: true,
        nextActions: ['Skip for now', 'What key do I need?'],
      }
    }

    const providerName = firstBlock?.label ?? 'the integration'
    return {
      message: `Your backend is ready — paste your ${providerName} API key to activate the integration.`,
      isSuccess: false,
      isBlocked: true,
      nextActions: ['Skip for now', `How do I get the ${providerName} key?`],
    }
  }

  // ── Case 2: Partially blocked (some built, some blocked) ─────────────────
  if (hasBuilt && hasBlocked) {
    const builtLabels = built
      .map(b => b.label ?? b.id ?? '')
      .filter(Boolean)
      .slice(0, 3)

    const blockedProvider = (blocked[0]?.label ?? blocked[0]?.id ?? 'an integration').toLowerCase()
    const knownBlock = Object.entries(BLOCKED_REWRITES).find(([k]) => blockedProvider.includes(k))

    const builtSummary = builtLabels.length > 0
      ? `${builtLabels.join(', ')} ${builtLabels.length === 1 ? 'is' : 'are'} ready.`
      : 'Your backend components are ready.'

    const blockMsg = knownBlock
      ? knownBlock[1]
      : `Paste your ${blocked[0]?.label ?? 'API'} key to activate the remaining integration.`

    return {
      message: `${builtSummary} ${blockMsg}`,
      isSuccess: true,
      isBlocked: true,
      nextActions: ['Skip for now', 'What key do I need?'],
    }
  }

  // ── Case 3: Successful build ──────────────────────────────────────────────
  if (hasBuilt && isSuccess) {
    let message = raw.message ?? ''
    message = sanitizeTelemetry(message)

    // If message is now empty or too short after sanitization, reconstruct
    if (message.length < 10) {
      message = buildSuccessMessage(raw.artifacts, built)
    }

    return {
      message,
      isSuccess: true,
      isBlocked: false,
      nextActions: deriveNextActions(raw.artifacts),
    }
  }

  // ── Case 4: Failure / error ───────────────────────────────────────────────
  if (raw.error || (!isSuccess && !hasBlocked)) {
    const rawMsg = raw.message ?? raw.error ?? ''
    const sanitized = sanitizeTelemetry(rawMsg)

    if (sanitized.length > 10) {
      return {
        message: sanitized,
        isSuccess: false,
        isBlocked: false,
        nextActions: ['Try /status', 'What can I build?'],
      }
    }

    return {
      message: "I ran into an issue with that. Try rephrasing what you'd like to build, or type /status to see your current backend.",
      isSuccess: false,
      isBlocked: false,
      nextActions: ['Show me what I can build', '/status'],
    }
  }

  // ── Case 5: Pass-through for informational messages ───────────────────────
  const message = sanitizeTelemetry(raw.message ?? '')
  return {
    message: message || "Your backend is ready.",
    isSuccess: true,
    isBlocked: false,
  }
}

/**
 * Runs all telemetry pattern rewrites against a raw message string.
 * Strips internal state language and returns clean product copy.
 */
export function sanitizeTelemetry(raw: string): string {
  if (!raw) return ''

  let result = raw

  for (const { pattern, replacement } of TELEMETRY_REWRITES) {
    if (typeof replacement === 'string') {
      result = result.replace(pattern, replacement)
    } else {
      const match = result.match(pattern)
      if (match) {
        result = result.replace(pattern, replacement(match))
      }
    }
  }

  // Collapse multiple spaces/newlines
  result = result.replace(/\n{3,}/g, '\n\n').trim()

  return result
}

/**
 * Constructs a success message from artifacts when the raw message was empty/telemetry.
 */
function buildSuccessMessage(
  artifacts: RawExecutionOutput['artifacts'],
  built: Array<{ label?: string; id?: string; type?: string }>,
): string {
  const parts: string[] = []

  if (artifacts?.tables && artifacts.tables.length > 0) {
    const names = artifacts.tables.slice(0, 4).join(', ')
    parts.push(`${names} ${artifacts.tables.length === 1 ? 'table is' : 'tables are'} set up`)
  } else if (built.length > 0) {
    const labels = built.map(b => b.label ?? b.id ?? '').filter(Boolean).slice(0, 3)
    if (labels.length > 0) parts.push(labels.join(', ') + (labels.length === 1 ? ' is ready' : ' are ready'))
  }

  if (artifacts?.apis && artifacts.apis.length > 0) {
    parts.push(`${artifacts.apis.length} API endpoint${artifacts.apis.length === 1 ? '' : 's'} generated`)
  }

  if (artifacts?.auth) {
    parts.push('authentication enabled')
  }

  if (artifacts?.buckets && artifacts.buckets.length > 0) {
    parts.push('file storage configured')
  }

  if (parts.length === 0) return 'Your backend is ready.'

  return parts.join(', ') + '.'
}

/**
 * Derives natural next-action suggestions from what was just built.
 */
function deriveNextActions(artifacts: RawExecutionOutput['artifacts']): string[] {
  const actions: string[] = []

  if (artifacts?.tables && artifacts.tables.length > 0 && !artifacts.auth) {
    actions.push('Enable user auth')
  }

  if (artifacts?.auth && !artifacts?.apis) {
    actions.push('Generate API endpoints')
  }

  if (artifacts?.tables && artifacts.tables.length > 0 && !artifacts.buckets) {
    actions.push('Add file storage')
  }

  if (actions.length === 0) {
    actions.push('What else should I add?', 'Deploy to production')
  }

  return actions.slice(0, 3)
}
