/**
 * API KEY DETECTOR
 * ================
 * Detects when a user pastes a service API key into the AI chat.
 * Mirrors the OAuth credential detector pattern — no LLM needed.
 *
 * Handles messages like:
 *   "My Stripe key is sk_live_abc123..."
 *   "Here's my OpenAI key: sk-proj-abc123..."
 *   "Connect Resend: re_abc123..."
 */

export type ApiKeyIntegrationId =
  | 'stripe'
  | 'openai'
  | 'anthropic'
  | 'resend'
  | 'sendgrid'
  | 'posthog'
  | 'plausible'
  | 'runway'
  | 'stability'
  | 'kling'
  | 'pika'
  | 'replicate'

export interface DetectedApiKey {
  integrationId: ApiKeyIntegrationId
  key: string
}

interface KeyPattern {
  integrationId: ApiKeyIntegrationId
  /** Regex that matches the raw API key value itself */
  keyRegex: RegExp
  /** Optional: require this word in the message to avoid false positives */
  contextPattern?: RegExp
  /** Minimum key length sanity check */
  minLength: number
}

const KEY_PATTERNS: KeyPattern[] = [
  // Stripe — sk_live_... or sk_test_...
  {
    integrationId: 'stripe',
    keyRegex: /\b(sk_(?:live|test)_[A-Za-z0-9]{20,})\b/,
    minLength: 24,
  },

  // Anthropic — sk-ant-api03-... (must match before OpenAI to avoid prefix clash)
  {
    integrationId: 'anthropic',
    keyRegex: /\b(sk-ant-[A-Za-z0-9\-_]{20,})\b/,
    minLength: 28,
  },

  // OpenAI — sk-... or sk-proj-... (comes after Anthropic check)
  {
    integrationId: 'openai',
    keyRegex: /\b(sk-(?:proj-)?[A-Za-z0-9\-_]{20,})\b/,
    minLength: 24,
  },

  // Resend — re_... (minLength 10 to catch short test keys and give a format hint)
  {
    integrationId: 'resend',
    keyRegex: /\b(re_[A-Za-z0-9]{6,})\b/,
    minLength: 10,
  },

  // SendGrid — SG.xxx.yyy
  {
    integrationId: 'sendgrid',
    keyRegex: /\b(SG\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,})\b/,
    minLength: 44,
  },

  // PostHog — phc_...
  {
    integrationId: 'posthog',
    keyRegex: /\b(phc_[A-Za-z0-9]{20,})\b/,
    minLength: 24,
  },

  // Runway ML — key_... (40+ chars hex/alphanumeric)
  {
    integrationId: 'runway',
    keyRegex: /\b(key_[A-Za-z0-9]{32,})\b/,
    contextPattern: /\brunway\b/i,
    minLength: 36,
  },

  // Stability AI — sk-... (Stability uses same sk- prefix as OpenAI but context needed)
  // Detected separately via contextPattern so it doesn't collide with openai
  {
    integrationId: 'stability',
    keyRegex: /\b(sk-[A-Za-z0-9]{40,})\b/,
    contextPattern: /\bstability\b|\bstable[\s-]?diffusion\b|\bsdxl\b/i,
    minLength: 44,
  },

  // Replicate — r8_... (used by many OSS video models including Kling)
  {
    integrationId: 'replicate',
    keyRegex: /\b(r8_[A-Za-z0-9]{32,})\b/,
    minLength: 36,
  },

  // Pika Labs — pika_... or bearer token patterns with pika context
  {
    integrationId: 'pika',
    keyRegex: /\b(pika_[A-Za-z0-9\-_]{20,})\b/,
    contextPattern: /\bpika\b/i,
    minLength: 24,
  },
]

/**
 * Patterns that look like partial or malformed keys for known services.
 * Used to detect key *attempts* that don't fully match — so we can
 * return a format-error hint instead of silently ignoring them.
 */
const PARTIAL_KEY_HINTS: Array<{
  integrationId: ApiKeyIntegrationId
  /** Prefix regex — catches keys with the right prefix but wrong format/length */
  prefixRegex: RegExp
  example: string
}> = [
  { integrationId: 'stripe',    prefixRegex: /\bsk_(live|test)_[A-Za-z0-9]{1,19}\b/, example: 'sk_live_...' },
  { integrationId: 'openai',    prefixRegex: /\bsk-[A-Za-z0-9]{1,19}\b/,             example: 'sk-proj-...' },
  { integrationId: 'anthropic', prefixRegex: /\bsk-ant-[A-Za-z0-9\-_]{1,19}\b/,      example: 'sk-ant-api03-...' },
  { integrationId: 'resend',    prefixRegex: /\bre_[A-Za-z0-9]{1,5}\b/,               example: 're_...' },
  { integrationId: 'sendgrid',  prefixRegex: /\bSG\.[A-Za-z0-9\-_]{1,19}\b/,         example: 'SG.xxx.yyy' },
  { integrationId: 'posthog',   prefixRegex: /\bphc_[A-Za-z0-9]{1,19}\b/,            example: 'phc_...' },
  { integrationId: 'runway',    prefixRegex: /\bkey_[A-Za-z0-9]{1,31}\b/,             example: 'key_...' },
  { integrationId: 'replicate', prefixRegex: /\br8_[A-Za-z0-9]{1,31}\b/,              example: 'r8_...' },
  { integrationId: 'pika',      prefixRegex: /\bpika_[A-Za-z0-9\-_]{1,19}\b/,         example: 'pika_...' },
]

export interface PartialKeyAttempt {
  integrationId: ApiKeyIntegrationId
  example: string
}

/**
 * Mask an API key for safe display: first 7 chars + bullets + last 4 chars.
 * e.g.  sk_live_••••••••••••kZ9f
 */
export function maskApiKey(key: string): string {
  if (key.length <= 11) return '•'.repeat(key.length)
  return key.substring(0, 7) + '•'.repeat(12) + key.slice(-4)
}

/**
 * Detect an API key in the user's message.
 * Returns the FIRST match found (users rarely paste multiple keys at once).
 * When a pattern has a contextPattern, the message must also match it.
 */
export function detectApiKey(message: string): DetectedApiKey | null {
  for (const { integrationId, keyRegex, contextPattern, minLength } of KEY_PATTERNS) {
    const match = message.match(keyRegex)
    if (match) {
      const key = match[1].trim()
      if (key.length >= minLength) {
        // If this pattern requires a context word (e.g. "runway", "stability"),
        // skip if the message doesn't mention it — prevents false positives.
        if (contextPattern && !contextPattern.test(message)) continue
        return { integrationId, key }
      }
    }
  }
  return null
}

/**
 * Detect a partial or malformed key attempt (right prefix, too short / wrong format).
 * Returns a hint so the caller can surface a format-error response rather than
 * silently routing the message to the intent planner.
 */
export function detectPartialKeyAttempt(message: string): PartialKeyAttempt | null {
  for (const { integrationId, prefixRegex, example } of PARTIAL_KEY_HINTS) {
    if (prefixRegex.test(message)) {
      return { integrationId, example }
    }
  }
  return null
}

/**
 * Where a key can begin in stored text: not inside a word, as \b required, or
 * right after an escape such as the "\n" of JSON text, where \b sees the "n"
 * and the key and finds no boundary between them.
 */
const STORED_KEY_START = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[bfnrt])|(?<=\\u[0-9A-Fa-f]{4}))`

/**
 * Each key shape as storage looks for it: every occurrence, from the start
 * above, and through the end of its token. A trailing \b missed a key followed
 * by "_" or another word character, since the match can only end where a word
 * character meets a non-word one and inside a key there is none; it also cut
 * short keys with "_" or "-" inside, such as Resend's re_<id>_<secret>.
 */
const STORED_KEY_SHAPES: RegExp[] = KEY_PATTERNS.map(({ keyRegex }) => new RegExp(
  `${STORED_KEY_START}${keyRegex.source.replace(/^\\b/, '').replace(/\\b$/, '')}[A-Za-z0-9_-]*`,
  'g',
))

/**
 * Return a copy of the message with any detected API key replaced by a redaction
 * placeholder — safe to write to ConversationMessage.
 */
export function sanitizeMessageForStorage(message: string): string {
  let sanitized = message
  for (const shape of STORED_KEY_SHAPES) sanitized = sanitized.replace(shape, '[KEY_REDACTED]')
  // Also redact webhook secrets (whsec_...) which have their own detection path
  sanitized = sanitized.replace(/whsec_[A-Za-z0-9+/=_\-]{6,}/g, '[WEBHOOK_SECRET_REDACTED]')
  return sanitized
}

// ── Webhook secret detection ──────────────────────────────────────────────────

export interface DetectedWebhookSecret {
  integrationId: 'stripe'
  webhookSecret: string
}

/**
 * Detect a Stripe webhook signing secret (whsec_...) in the user's message.
 * Called by the credential-guard pipeline to intercept and store the secret
 * before the message reaches the orchestration layer.
 */
export function detectWebhookSecret(message: string): DetectedWebhookSecret | null {
  // whsec_ followed by at least 16 alphanumeric/base64/hyphen characters
  const match = message.match(/whsec_([A-Za-z0-9+/=_\-]{6,})/i)
  if (match && match[0].length >= 12) {
    return { integrationId: 'stripe', webhookSecret: match[0] }
  }
  return null
}

// ── Known integration key patterns ────────────────────────────────────────────
// Keys matching these formats belong to legitimate third-party providers and
// must never be misclassified as generic secrets or AWS keys.

const KNOWN_PROVIDER_KEY_PATTERNS: RegExp[] = [
  // Anthropic — sk-ant-...
  /^sk-ant-[A-Za-z0-9\-_]{20,}$/,
  // OpenAI & Stability AI — sk-... (including sk-proj-...)
  /^sk-[A-Za-z0-9\-_]{20,}$/,
  // Stripe secret / restricted keys
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}$/,
  // Stripe webhook signing secret
  /^whsec_[A-Za-z0-9+/=_\-]{12,}$/,
  // Resend
  /^re_[A-Za-z0-9_\-]{6,}$/,
  // SendGrid
  /^SG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}$/,
  // PostHog
  /^phc_[A-Za-z0-9_\-]{20,}$/,
  // Replicate
  /^r8_[A-Za-z0-9_\-]{20,}$/,
  // Runway ML
  /^key_[A-Za-z0-9_\-]{20,}$/,
  // Pika Labs
  /^pika_[A-Za-z0-9\-_]{20,}$/,
  // Twilio Account SID or full sid:token:from credential
  /^AC[0-9a-fA-F]{32}(?::[0-9a-fA-F]{32}:[+0-9]+)?$/,
  // Email sender configuration (Resend/SendGrid fromEmail)
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
]

export function isKnownProviderKey(value: string): boolean {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  return KNOWN_PROVIDER_KEY_PATTERNS.some((p) => p.test(trimmed))
}

// ── Dangerous secret patterns ─────────────────────────────────────────────────
// These patterns detect high-entropy or clearly dangerous values that should
// never be stored as integration keys (private keys, JWTs, database passwords, etc.)

interface DangerousSecretPattern {
  label: string
  regex?: RegExp
  matches?: (value: string) => boolean
  description: string
}

const DANGEROUS_PATTERNS: DangerousSecretPattern[] = [
  {
    label: 'private_key',
    regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    description: 'RSA/EC/OpenSSH private key',
  },
  {
    label: 'jwt_secret',
    regex: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/,
    description: 'JWT token (three-segment base64url)',
  },
  {
    label: 'database_url',
    regex: /^(postgresql|postgres|mysql|mongodb(\+srv)?|redis):\/\/[^:]+:[^@]+@/i,
    description: 'Database connection URL with embedded credentials',
  },
  {
    label: 'aws_secret_key',
    description: 'Possible AWS secret access key (40-char base64)',
    matches: (val) => {
      // Never fire on a value matching a known provider's key format
      if (isKnownProviderKey(val)) return false

      const trimmed = val.trim()

      // 1. Standalone secret: the entire value is exactly 40 base64 characters
      if (/^[A-Za-z0-9/+=]{40}$/.test(trimmed)) return true

      // 2. Paired with an AWS access key ID (AKIA, ASIA, ABIA, ACCA)
      const hasKeyId = /\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/.test(trimmed)
      if (hasKeyId) {
        if (/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/.test(trimmed) || /aws_secret/i.test(trimmed)) {
          return true
        }
      }

      // 3. Explicit AWS secret assignment (e.g. aws_secret_access_key = ...)
      if (/\baws_secret(?:_access)?_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i.test(trimmed)) {
        return true
      }

      return false
    },
  },
  {
    label: 'github_token',
    regex: /\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}\b/,
    description: 'GitHub personal access token',
  },
  {
    label: 'npm_token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/,
    description: 'npm publish token',
  },
  {
    label: 'generic_high_entropy',
    // Matches long strings (>40 chars) of hex that look like raw secrets/hashes,
    // excluding known provider keys
    matches: (val) => !isKnownProviderKey(val) && /\b[0-9a-fA-F]{64}\b/.test(val),
    description: 'Long hex string (possible raw secret/hash)',
  },
]

export interface SecretScanResult {
  /** Whether the value looks dangerous and should NOT be stored */
  isDangerous: boolean
  /** Human-readable description of the detected pattern */
  label?: string
  description?: string
  /** Suggested user-facing warning */
  warning?: string
}

/**
 * Scan a value before storing it as an integration key.
 * Returns { isDangerous: true, ... } if the value matches a known dangerous pattern.
 *
 * Usage:
 *   const scan = scanForDangerousSecret(value)
 *   if (scan.isDangerous) {
 *     throw new Error(scan.warning)
 *   }
 */
export function scanForDangerousSecret(value: string): SecretScanResult {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return { isDangerous: false }

  for (const { label, regex, matches, description } of DANGEROUS_PATTERNS) {
    const isMatch = matches ? matches(trimmed) : regex ? regex.test(trimmed) : false
    if (isMatch) {
      return {
        isDangerous: true,
        label,
        description,
        warning: `This value looks like a ${description}. Storing private keys, database URLs, or JWT tokens as integration keys is not allowed — this could expose your infrastructure. Please provide only a service API key (e.g. sk_live_..., re_..., key_...).`,
      }
    }
  }

  return { isDangerous: false }
}
