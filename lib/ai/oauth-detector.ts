/**
 * OAuth Credential Detector
 * =========================
 * Detects when a user pastes OAuth credentials (Client ID + Secret) into the AI chat
 * and extracts structured provider config for immediate execution — no LLM needed.
 *
 * Handles messages like:
 *   "Enable Google login
 *    Client ID: 123abc.apps.googleusercontent.com
 *    Client Secret: GOCSPX-xxxxx"
 */

export type OAuthProviderName = 'google' | 'github' | 'discord' | 'facebook' | 'apple'

export interface OAuthCredentials {
  provider: OAuthProviderName
  clientId: string
  clientSecret: string
}

const PROVIDER_PATTERNS: Array<{ provider: OAuthProviderName; pattern: RegExp }> = [
  { provider: 'google',   pattern: /\bgoogle\b/i },
  { provider: 'github',   pattern: /\bgithub\b/i },
  { provider: 'discord',  pattern: /\bdiscord\b/i },
  { provider: 'facebook', pattern: /\bfacebook\b/i },
  { provider: 'apple',    pattern: /\bapple\b/i },
]

// Extracts the value after "Client ID:", "client_id:", "clientId:", etc.
const CLIENT_ID_RE = /client[\s_-]*id\s*[:\-]?\s*([^\s\n\r]+)/i
const CLIENT_SECRET_RE = /client[\s_-]*secret\s*[:\-]?\s*([^\s\n\r]+)/i

/**
 * Detect if the message contains an OAuth provider setup intent with credentials.
 * Returns null if this is NOT an OAuth configuration message.
 */
export function detectOAuthCredentials(message: string): OAuthCredentials | null {
  // Must mention at least one provider
  let detectedProvider: OAuthProviderName | null = null
  for (const { provider, pattern } of PROVIDER_PATTERNS) {
    if (pattern.test(message)) {
      detectedProvider = provider
      break
    }
  }
  if (!detectedProvider) return null

  // Must contain both Client ID and Client Secret
  const clientIdMatch = message.match(CLIENT_ID_RE)
  const clientSecretMatch = message.match(CLIENT_SECRET_RE)

  if (!clientIdMatch || !clientSecretMatch) return null

  const clientId = clientIdMatch[1].trim()
  const clientSecret = clientSecretMatch[1].trim()

  // Basic sanity: credentials should not be empty placeholders
  if (!clientId || !clientSecret || clientId.length < 4 || clientSecret.length < 4) return null

  return { provider: detectedProvider, clientId, clientSecret }
}
