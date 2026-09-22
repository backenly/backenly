/**
 * THE ONLY ADDRESS AN OAUTH SIGN-IN MAY TREAT AS PROVEN
 * =====================================================
 * A platform account created or linked through OAuth is marked
 * `emailVerified: true`, and linking happens BY ADDRESS: an OAuth sign-in
 * whose address matches an existing email account takes over that account.
 *
 * So the address has to be one the provider itself says it verified. Both
 * callbacks used to take whatever the provider handed them:
 *
 *   GitHub  the public profile email, else simply `emails[0]`
 *   Google  `userinfo.email`, with `verified_email` never consulted
 *
 * Google lets an account hold an unverified address, and GitHub's list is
 * mostly unverified addresses. Either one let somebody claim an address they
 * do not control, be recorded as having proven it, and land on whichever
 * Backenly account already owned it. That is the same proof email signup now
 * demands a mailed code for, so it cannot be weaker here.
 *
 * Returns the normalised address, or null. Null means refuse the sign-in:
 * there is no safe fallback to "the address they told us".
 */

function normalize(raw: unknown): string | null {
  const email = String(raw ?? '').trim().toLowerCase()
  return email.includes('@') ? email : null
}

/** Providers send booleans, and sometimes the strings "true"/"false". */
function isTrue(flag: unknown): boolean {
  return flag === true || flag === 'true'
}

/**
 * Google, from either userinfo shape.
 *
 * `/oauth2/v2/userinfo` calls it `verified_email`; the OIDC userinfo and the
 * id_token call it `email_verified`. Neither is optional here: an absent flag
 * is not a verified address.
 */
export function googleVerifiedEmail(profile: unknown): string | null {
  const p = (profile ?? {}) as Record<string, unknown>
  if (!isTrue(p.verified_email) && !isTrue(p.email_verified)) return null
  return normalize(p.email)
}

/**
 * GitHub, from `GET /user/emails`.
 *
 * Prefers the primary address, and otherwise takes the first verified one, so
 * an account whose primary is unverified can still sign in with an address it
 * has proven. `user:email` is always in the requested scope, so this list is
 * always available.
 */
export function githubVerifiedEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null
  const verified = emails.filter(e => {
    const entry = (e ?? {}) as Record<string, unknown>
    return isTrue(entry.verified) && normalize(entry.email) !== null
  }) as Array<Record<string, unknown>>
  if (verified.length === 0) return null
  const primary = verified.find(e => isTrue(e.primary))
  return normalize((primary ?? verified[0]).email)
}
