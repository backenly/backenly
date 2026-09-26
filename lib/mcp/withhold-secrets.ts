/**
 * Keep credentials a tool just minted or revealed out of what Backenly stores.
 *
 * Several tools hand the agent a secret exactly once, in the result: a new API
 * key, a rotated webhook signing secret. That hand-off is intended. What was
 * not intended is the copy: recordMcpCall writes the first 200 characters of
 * every summary to api_key_usage and the first 240 to audit_logs, and a new
 * key sits well inside both. So every key an agent created over MCP, service
 * role included, was kept in plaintext in two platform tables, although the
 * key table itself deliberately stores no plaintext.
 *
 * Values are withheld two ways. Those the tool names in its structured `data`
 * under a credential field are removed wherever they appear. As a net for
 * values nothing names, the shapes Backenly itself issues are masked, and so
 * are provider keys (the existing storage sanitizer). Withholding happens only
 * on the way to storage; the agent's own response is untouched.
 */

import { sanitizeMessageForStorage } from '@/lib/ai/api-key-detector'

const PLACEHOLDER = '[withheld]'

/** Field names whose string values are credentials. */
const SECRET_FIELD = /^(apiKey|newKey|secret|webhookSecret|signingSecret|password|connectionString|psqlCommand|pgDumpCommand|token|accessToken|refreshToken|clientSecret)$/i

/** Credential shapes Backenly issues. */
const ISSUED_SHAPES: RegExp[] = [
  /\b(?:proj|svc|mcp|bkn)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // Rotated API keys, until rotation mints the project prefixes too.
  /\bsk_(?:live|test)_[0-9a-f]{32,}\b/g,
  /\bwhsec_[A-Za-z0-9+/=_-]{16,}/g,
  /\bbk_admin_[A-Za-z0-9_-]{16,}/g,
]

/** A password inside a connection string, keeping the rest readable. */
const URL_PASSWORD = /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/g

function collect(value: unknown, out: string[], depth: number, named: boolean): void {
  if (depth > 5 || value == null) return
  if (typeof value === 'string') {
    if (named && value.length >= 8) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1, named)
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collect(v, out, depth + 1, SECRET_FIELD.test(k))
    }
  }
}

/** The credential values a tool result names in its structured data. */
export function namedSecrets(data: unknown): string[] {
  const out: string[] = []
  collect(data, out, 0, false)
  // Longest first, so a value that contains another is removed whole.
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

/** `text` as it may be stored: named values and issued shapes withheld. */
export function withholdSecrets(text: string, data?: unknown): string {
  let out = text
  for (const secret of namedSecrets(data)) out = out.split(secret).join(PLACEHOLDER)
  for (const shape of ISSUED_SHAPES) out = out.replace(shape, PLACEHOLDER)
  out = out.replace(URL_PASSWORD, `$1${PLACEHOLDER}@`)
  return sanitizeMessageForStorage(out)
}
