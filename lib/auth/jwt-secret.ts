/**
 * THE ONE PLACE THAT RESOLVES A SIGNING SECRET
 * ============================================
 *
 * Every site that signs or verifies a token used to read the environment
 * directly with an `||` fallback:
 *
 *   const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'
 *
 * There were eight of those, and the string is published — this repository is
 * public. A fallback like that fails OPEN: if the variable is ever missing or
 * empty, the process does not refuse to work, it starts signing AND VERIFYING
 * tokens with a constant that anybody can read on GitHub. At that point a forged
 * token is indistinguishable from a real one, and nothing in the logs looks
 * unusual because from the code's point of view everything is working.
 *
 * The failure mode matters more than the odds. A deploy that loses an env var,
 * a new environment brought up from an incomplete `.env`, a container missing a
 * secret mount — each of those is an ordinary operational mistake, and the
 * fallback silently converted every one of them into an authentication bypass
 * instead of a loud startup failure.
 *
 * So: no defaults, ever. Absent or too-short secret throws.
 *
 * WHY THIS IS A FUNCTION AND NOT A MODULE CONSTANT
 * ------------------------------------------------
 * Throwing at module scope would make `import` itself fail, and Next.js imports
 * route modules during the production build. One missing variable would then
 * break the BUILD rather than the request, taking down deploys of unrelated
 * pages. Resolving lazily keeps the failure at the point of use, where it is
 * attributable and where it cannot take anything else with it.
 */

/** Shortest secret we will sign with. Matches the per-project jwtSecret rule. */
const MIN_SECRET_LENGTH = 32

function resolve(varName: string, value: string | undefined, purpose: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(
      `${varName} is not set — refusing to ${purpose}. There is deliberately no ` +
      `default: a hardcoded fallback in a public repository would mean signing and ` +
      `verifying tokens with a publicly known key, which is an authentication bypass. ` +
      `Set ${varName} in the environment.`,
    )
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${varName} is only ${value.length} characters — refusing to ${purpose}. ` +
      `Use at least ${MIN_SECRET_LENGTH} characters of high-entropy random data ` +
      `(e.g. \`openssl rand -base64 48\`).`,
    )
  }
  return value
}

/**
 * The platform signing secret, for tokens that authenticate a Backenly ACCOUNT
 * (dashboard login, OAuth callbacks, password reset).
 *
 * NOT for end-user tokens belonging to a customer's project — those are signed
 * with that project's own `Project.jwtSecret` so one project's compromise cannot
 * forge identities in another.
 *
 * @param purpose short verb phrase used in the error, e.g. "sign a session token"
 */
export function requireJwtSecret(purpose = 'issue a token'): string {
  return resolve('JWT_SECRET', process.env.JWT_SECRET, purpose)
}

/**
 * Secret for preview-share links. Prefers a dedicated PREVIEW_TOKEN_SECRET so a
 * shareable preview link cannot be turned into a platform session token, and
 * falls back to the platform secret — but never to a constant.
 */
export function requirePreviewTokenSecret(purpose = 'issue a preview token'): string {
  const dedicated = process.env.PREVIEW_TOKEN_SECRET
  if (dedicated && dedicated.trim().length > 0) {
    return resolve('PREVIEW_TOKEN_SECRET', dedicated, purpose)
  }
  return resolve('JWT_SECRET', process.env.JWT_SECRET, purpose)
}

/**
 * HMAC key for storage access tokens (signed-URL equivalents).
 *
 * This one was live, not latent. `STORAGE_SECRET` is unset on production, so
 * every storage access token was HMAC'd with
 * 'default-secret-change-in-production' — a string in a public repository. The
 * token is `HMAC(fileId:expires)`, so anyone could mint a valid token for any
 * file with any expiry and read private objects. Signed URLs are a load-bearing
 * part of the storage product; they cannot have a default.
 */
export function requireStorageSecret(purpose = 'issue a storage access token'): string {
  return resolve('STORAGE_SECRET', process.env.STORAGE_SECRET, purpose)
}

/**
 * Passphrase for encrypting stored OAuth client secrets at rest.
 *
 * Also live: unset on production, so customer OAuth client secrets were
 * encrypted under a published passphrase, making any database dump or backup
 * trivially decryptable. The value is stretched with scryptSync before use, so
 * length matters less than entropy — but a known value defeats it entirely.
 *
 * NOTE: the KDF salt at the call site is the literal string 'salt'. A static
 * salt gives no per-deployment separation and permits precomputation. Changing
 * it re-keys every stored secret, so it is left alone here and tracked
 * separately; with a high-entropy passphrase it is a weakness, not a break.
 */
export function requireOAuthEncryptionKey(purpose = 'encrypt an OAuth client secret'): string {
  return resolve('OAUTH_ENCRYPTION_KEY', process.env.OAUTH_ENCRYPTION_KEY, purpose)
}

/**
 * Non-throwing probe for readiness/diagnostic surfaces that need to REPORT on
 * configuration rather than act on it. Never use this to pick a signing key.
 */
export function jwtSecretStatus(): { configured: boolean; tooShort: boolean } {
  const v = process.env.JWT_SECRET
  if (!v || v.trim().length === 0) return { configured: false, tooShort: false }
  return { configured: true, tooShort: v.length < MIN_SECRET_LENGTH }
}
