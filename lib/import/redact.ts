/**
 * Keeping an import's credentials out of every sentence Backenly says or keeps.
 *
 * A connection string, a database password, a Supabase service_role key and a
 * Firebase service account key live in memory for one job and nowhere else
 * (lib/import/jobs.ts). The way they leak is not a write someone meant to make:
 * it is an error message. `pg` echoes the user and sometimes the host, a URL
 * parser's error carries the whole URL, a failed fetch names the URL it was
 * given, and a stack trace quotes the arguments. So every message on its way to
 * a job row, an HTTP answer or a log line goes through `redact` first, with the
 * job's own secrets named, and generic shapes (a URL's userinfo, a JWT, a PEM
 * private key) are removed even when nobody named them.
 *
 * Pure: no I/O. Tested in __tests__/import/redact.test.ts.
 */

import type { ImportConnection } from './contract'

const REDACTED = '…'

/** Shortest secret worth matching: below this a match would mangle ordinary words. */
const MIN_SECRET = 4

/** The values an import must never repeat, longest first so a key is never half-removed. */
export function secretsOf(connection: ImportConnection | null | undefined): string[] {
  if (!connection) return []
  const out = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim().length >= MIN_SECRET) out.add(v.trim())
  }
  switch (connection.source) {
    case 'supabase':
    case 'postgres': {
      add(connection.connectionString)
      for (const part of urlSecrets(connection.connectionString)) add(part)
      if (connection.source === 'supabase') add(connection.serviceRoleKey)
      break
    }
    case 'firebase': {
      add(connection.serviceAccountJson)
      try {
        const parsed = JSON.parse(connection.serviceAccountJson) as Record<string, unknown>
        add(parsed.private_key)
        add(parsed.private_key_id)
      } catch {
        /* not JSON: the whole text is already listed */
      }
      break
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** The password of a connection string, raw and decoded, when it has one. */
function urlSecrets(raw: string | undefined): string[] {
  if (!raw) return []
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(raw.trim())
  if (!m) return []
  const userinfo = m[1]
  const colon = userinfo.indexOf(':')
  if (colon === -1) return []
  const encoded = userinfo.slice(colon + 1)
  const out = [encoded]
  try {
    out.push(decodeURIComponent(encoded))
  } catch {
    /* malformed escape: the raw form is enough */
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `text` with every named secret and every credential-shaped token removed.
 * Never throws; a non-string comes back as its String().
 */
export function redact(text: unknown, secrets: readonly string[] = []): string {
  let s = typeof text === 'string' ? text : text instanceof Error ? text.message : String(text ?? '')
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET) continue
    const forms = new Set([secret, encodeURIComponent(secret)])
    for (const form of forms) s = s.replace(new RegExp(escapeRegExp(form), 'g'), REDACTED)
  }
  return s
    // A URL's userinfo: postgres://user:pass@host → postgres://…@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, `$1${REDACTED}@`)
    // A key=value password, as libpq and some drivers print it.
    .replace(/\b(password|passwd|pwd)\s*=\s*('[^']*'|"[^"]*"|[^\s&;]+)/gi, `$1=${REDACTED}`)
    // A JWT (Supabase keys are JWTs).
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED)
    // Supabase's newer opaque keys.
    .replace(/\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g, REDACTED)
    // A PEM private key, including the escaped-newline form inside JSON.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    // A bearer header someone printed.
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/g, `$1 ${REDACTED}`)
}

/** An error's message, redacted, cut to what a person can read under a field. */
export function redactedMessage(err: unknown, secrets: readonly string[] = [], max = 400): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as any)?.message ?? err ?? '')
  const s = redact(raw, secrets).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
