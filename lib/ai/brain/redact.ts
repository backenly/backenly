/**
 * SECRET REDACTION — for what the brain writes down, never for what it does
 * =========================================================================
 *
 * Two records outlive a turn, and neither should hold a credential:
 *
 *   • The server log, which records each tool call with its arguments. Some
 *     arguments are secrets by nature (an environment variable's value, an
 *     OAuth client secret, a webhook signing secret).
 *   • The conversation history, which stores each turn's messages. A user may
 *     paste a key, and a tool that mints one (create_api_key) answers with it
 *     so the caller can copy it once.
 *
 * Redaction applies ONLY to those records. The live tool call, the live
 * response the caller receives, and anything the executor stores on purpose
 * are untouched; this module never changes behaviour, only what is retained.
 *
 * Over-redaction is the safe direction here: a log line that hides a harmless
 * value costs a little debugging, a log line that shows a secret is an
 * incident. So argument names match broadly, and text patterns cover
 * Backenly's own key prefixes plus the provider formats people paste.
 */

import { ISSUED_PREFIX, LEGACY_PREFIXES } from '@/lib/auth/key-prefix'

export const REDACTED = '[REDACTED]'

/**
 * Argument names whose value is a credential regardless of its shape.
 * `key` is deliberately absent: in set_env_var it is the variable NAME.
 */
const SECRET_ARG_NAME =
  /^(value|secret|password|passwd|pass|token|auth_?token|access_?token|refresh_?token|bearer|api_?key|apikey|client_?secret|private_?key|signing_?secret|webhook_?secret|credentials?|connection_?string|database_?url|dsn)$/i

/** Prefixes Backenly mints credentials with, current and legacy. */
const BACKENLY_PREFIXES: readonly string[] = [
  ...Object.values(ISSUED_PREFIX),
  ...LEGACY_PREFIXES,
]

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Also the start of a token: right after an escape such as the "\n" of JSON
 * text. There the character before a key is the escape's letter, which a guard
 * against starting inside a word reads as part of one, so a key on its own
 * line in a stored JSON blob was kept.
 */
const AFTER_ESCAPE = String.raw`(?<=\\[bfnrt])|(?<=\\u[0-9A-Fa-f]{4})`

/** `re` with its start-of-token guard also met right after an escape. */
function startingAfterEscapes(re: RegExp): RegExp {
  return new RegExp(re.source.replace(/^\(\?<!(\[[^\]]+\])\)/, `(?:(?<!$1)|${AFTER_ESCAPE})`), re.flags)
}

/**
 * A Backenly key: a known prefix at the start of a token, followed by its
 * random body (minted as 48-64 hex characters). The 24-character floor and the
 * start-of-token anchor keep ordinary identifiers that happen to share a
 * prefix (a table named `proj_live_metrics`) out of it.
 */
const BACKENLY_KEY_RE = new RegExp(
  `(?:(?<![A-Za-z0-9_])|${AFTER_ESCAPE})(${BACKENLY_PREFIXES.map(escapeForRegex).join('|')})[A-Za-z0-9]{24,}`,
  'g',
)

/**
 * Provider credential formats, each replaced in full. Every pattern is anchored
 * to the start of a token: unanchored, `re_…` matched inside the table name
 * `store_inventory_movements_history` and `sk-…` inside `risk-assessment-…`,
 * which would have corrupted ordinary history text.
 */
const PROVIDER_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, // OpenAI
  /(?<![A-Za-z0-9_])rk_(?:live|test)_[A-Za-z0-9]{20,}/g, // Stripe restricted
  /(?<![A-Za-z0-9_])whsec_[A-Za-z0-9+/=_-]{16,}/g, // webhook signing secrets
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key id
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9_])re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g, // Resend (re_<id>_<secret>)
  /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM
].map(startingAfterEscapes)

/** The password segment of a URL-style connection string. */
const CONNECTION_STRING_RE =
  /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi

/**
 * Replace every credential-shaped substring. Safe on any text; returns the
 * input unchanged when nothing matches.
 */
export function redactSecretsInText(text: string): string {
  if (!text) return text
  let out = text.replace(CONNECTION_STRING_RE, `$1${REDACTED}$3`)
  out = out.replace(BACKENLY_KEY_RE, `$1${REDACTED}`)
  for (const re of PROVIDER_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

const MAX_DEPTH = 8

/**
 * A copy of tool arguments that is safe to log: values under a secret-named
 * key are replaced outright, and every other string is scanned for
 * credential-shaped content. The input is never mutated.
 */
export function redactArgs<T>(input: T): T {
  return redactValue(input, 0) as T
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (typeof value === 'string') return redactSecretsInText(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SECRET_ARG_NAME.test(k) && v !== null && v !== undefined && typeof v !== 'object'
          ? REDACTED
          : redactValue(v, depth + 1)
    }
    return out
  }
  return value
}
