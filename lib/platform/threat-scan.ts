/**
 * Threat scanning for AI prompts.
 *
 * Observe-only — these scans NEVER block a request. They exist so the founder
 * can see, on the Security tab, when users are (a) pasting real credentials
 * into the chat (secret leak — a support + liability signal) or (b) trying
 * prompt-injection / cross-tenant exfiltration ("ignore previous instructions",
 * "show me other users' data", raw SQL to read another schema).
 *
 * Detection is deliberately conservative: a false positive just adds a low-
 * severity row to a feed only the founder sees, but a noisy scanner that fires
 * on every "delete my table" would be useless, so the patterns are tight.
 */

export interface ThreatHit {
  kind: 'secret_leak' | 'suspicious_prompt'
  severity: 'info' | 'warn' | 'high' | 'critical'
  label: string
  // A redacted excerpt safe to store — never the raw secret.
  excerpt: string
}

// ── Secret patterns ──────────────────────────────────────────────────────────
// Each entry: a label + a regex that matches a *real-looking* credential.
const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'AWS secret key', re: /\baws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+]{30,}/i },
  { label: 'Google OAuth secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { label: 'Stripe secret key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'Twilio auth token', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { label: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'Postgres connection string', re: /\bpostgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@[^\s/]+/i },
  { label: 'Generic password assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{8,}/i },
]

// ── Prompt-injection / exfiltration patterns ─────────────────────────────────
const INJECTION_PATTERNS: { label: string; re: RegExp; severity: ThreatHit['severity'] }[] = [
  { label: 'Instruction override', re: /\bignore\b.{0,30}\b(previous|above|prior|all)\b.{0,20}\b(instructions?|prompts?|rules?)\b/i, severity: 'warn' },
  { label: 'System-prompt probe', re: /\b(reveal|show|print|repeat|leak|dump)\b.{0,30}\b(system\s*prompt|your\s*instructions|developer\s*message)\b/i, severity: 'warn' },
  { label: 'Role escalation', re: /\b(you\s*are\s*now|act\s*as|pretend\s*to\s*be)\b.{0,30}\b(admin|root|superuser|developer\s*mode|dan)\b/i, severity: 'warn' },
  { label: 'Cross-tenant data request', re: /\b(other|another|different|all)\b.{0,20}\b(users?|tenants?|projects?|customers?|accounts?)\b.{0,30}\b(data|rows?|records?|table|emails?|passwords?)\b/i, severity: 'high' },
  { label: 'Schema exfiltration', re: /\b(select|dump|read|export)\b.{0,40}\b(workspace_|information_schema|pg_catalog|pg_user|pg_shadow)\b/i, severity: 'high' },
  { label: 'Env / secret exfiltration', re: /\b(print|show|reveal|dump|cat)\b.{0,20}\b(process\.env|environment\s*variables?|\.env|secrets?|JWT_SECRET|DATABASE_URL)\b/i, severity: 'high' },
]

function redact(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 24)
  const end = Math.min(text.length, matchIndex + 40)
  let slice = text.slice(start, end).replace(/\s+/g, ' ').trim()
  // Mask anything that looks like a long token so we never persist a real secret.
  slice = slice.replace(/[A-Za-z0-9_\-+/]{16,}/g, m => `${m.slice(0, 4)}…${m.slice(-2)}`)
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '')
}

/**
 * Scan a prompt. Returns the single highest-severity hit, or null.
 * Secret leaks always win (they outrank injection attempts for the founder).
 */
export function scanPrompt(text: string): ThreatHit | null {
  if (!text || text.length < 8) return null

  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(text)
    if (m) {
      return {
        kind: 'secret_leak',
        severity: 'high',
        label: p.label,
        excerpt: redact(text, m.index),
      }
    }
  }

  let best: ThreatHit | null = null
  const rank = { info: 0, warn: 1, high: 2, critical: 3 } as const
  for (const p of INJECTION_PATTERNS) {
    const m = p.re.exec(text)
    if (m) {
      const hit: ThreatHit = {
        kind: 'suspicious_prompt',
        severity: p.severity,
        label: p.label,
        excerpt: redact(text, m.index),
      }
      if (!best || rank[hit.severity] > rank[best.severity]) best = hit
    }
  }
  return best
}
