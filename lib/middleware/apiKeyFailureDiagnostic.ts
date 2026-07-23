/**
 * Shared API-key failure classifier.
 *
 * Lives in its own file (no next/server, no express) so it can be imported
 * from BOTH the Next.js route middleware (lib/api/v1/middleware.ts) and the
 * Express runtime server (server/lib/auth.ts). The previous split — where
 * only the Next.js side knew how to explain a 401 — meant the diagnostic
 * never reached production, because nginx routes /api/v1/* to Express on
 * port 3001.
 *
 * The output is safe-to-display: `sentKeyShape` only ever contains a 16-char
 * prefix or a known placeholder value like "undefined". Never echoes the
 * full key — even when the key is rejected, treat it as if it could be a
 * valid credential for some other system.
 */

export type ApiKeyFailureKind =
  | 'missing'
  | 'placeholder'
  | 'malformed'
  | 'unknown_key'
  | 'expired'

export interface ApiKeyFailureDiagnostic {
  kind: ApiKeyFailureKind
  sentKeyShape: string
  hint: string
}

export function classifyKeyFailure(
  providedKey: string | null,
  kind: 'missing' | 'unknown_key' | 'expired' = 'unknown_key',
): ApiKeyFailureDiagnostic {
  if (!providedKey) {
    return {
      kind: 'missing',
      sentKeyShape: '(none)',
      hint:
        'No API key was sent. Pass your project anon key to createClient: ' +
        'createClient({ projectId: "...", apiKey: "proj_live_..." }). ' +
        'Get the key from your dashboard at https://backenly.com → project → Connect Frontend.',
    }
  }

  const trimmed = providedKey.trim()
  const lower = trimmed.toLowerCase()

  if (lower === 'undefined' || lower === 'null' || lower === 'nan' || trimmed === '') {
    return {
      kind: 'placeholder',
      sentKeyShape: `"${trimmed || '(empty)'}"`,
      hint:
        `Your frontend bundle is sending the literal string "${trimmed || '(empty)'}" as the API key. ` +
        'This happens when an environment variable (e.g. VITE_BACKENLY_API_KEY, ' +
        'NEXT_PUBLIC_BACKENLY_API_KEY) is referenced in your code but not set at ' +
        "build time, so the bundler inlines the value `undefined`. The Backenly anon " +
        'key is PUBLIC by design — paste it as a string ' +
        'literal in your createClient() call. No env var needed.',
    }
  }

  if (
    lower.includes('your-api-key') ||
    lower.includes('your_api_key') ||
    lower.includes('placeholder') ||
    lower === 'xxx' ||
    lower.startsWith('replace') ||
    lower.startsWith('paste')
  ) {
    return {
      kind: 'placeholder',
      sentKeyShape: `"${trimmed.substring(0, 32)}"`,
      hint:
        'Your frontend is sending a placeholder string instead of a real API key. ' +
        'Replace it with your project anon key (format: proj_live_...) from the ' +
        'Connect Frontend page in your dashboard.',
    }
  }

  const isBackenlyShape =
    /^proj_(live|test)_[a-f0-9]+$/i.test(trimmed) ||
    /^sk_(live|test)_[a-f0-9]+$/i.test(trimmed)

  if (!isBackenlyShape) {
    const prefix = trimmed.substring(0, 8)
    let serviceHint = ''
    if (/^sk-/.test(trimmed) || /^pk-/.test(trimmed)) serviceHint = ' (looks like an OpenAI / Anthropic key)'
    else if (/^sk_(live|test)_/.test(trimmed)) serviceHint = ' (looks like a Stripe secret key)'
    else if (/^AIza/.test(trimmed)) serviceHint = ' (looks like a Firebase / Google API key)'
    else if (/^eyJ/.test(trimmed)) serviceHint = ' (looks like a JWT — Backenly anon keys are not JWTs)'

    return {
      kind: 'malformed',
      sentKeyShape: `"${prefix}…" (length=${trimmed.length})`,
      hint:
        `The key you sent does not match the Backenly anon key format${serviceHint}. ` +
        'Backenly anon keys look like "proj_live_341c51f37b..." (prefix "proj_live_"). ' +
        'Copy yours from the Connect Frontend page in your dashboard.',
    }
  }

  if (kind === 'expired') {
    return {
      kind: 'expired',
      sentKeyShape: `"${trimmed.substring(0, 16)}…"`,
      hint:
        'The key you sent is recognized but has expired. Generate a new one from ' +
        'the Connect Frontend page.',
    }
  }

  return {
    kind: 'unknown_key',
    sentKeyShape: `"${trimmed.substring(0, 16)}…"`,
    hint:
      'Your key has the correct format but does not match any active API key for ' +
      'this project. Most common causes: the key belongs to a different project, ' +
      'it was rotated/deleted, or there is a typo. Copy the current key from the ' +
      'Connect Frontend page in your dashboard.',
  }
}
