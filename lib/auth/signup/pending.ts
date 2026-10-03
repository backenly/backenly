/**
 * What a signup carries between "code sent" and "code proven".
 *
 * Stored as the payload of its `signup` email code, and nowhere else. It holds
 * the bcrypt hash of the chosen password, never the password, and the
 * admission verdict reached when the gates ran, so the verify step creates
 * exactly the account the gates admitted without running them again.
 */
export interface PendingSignup {
  passwordHash: string
  name: string | null
  referralCode: string | null
  untrusted: boolean
  score: number | null
  signals: string[]
  ip: string
}

/**
 * Read a stored payload back, or null if it is not one.
 *
 * A row this code did not write, or one from an older shape, must not become an
 * account with a missing password hash.
 */
export function parsePendingSignup(payload: unknown): PendingSignup | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (typeof p.passwordHash !== 'string' || !p.passwordHash.startsWith('$2')) return null
  if (typeof p.ip !== 'string') return null
  return {
    passwordHash: p.passwordHash,
    name: typeof p.name === 'string' ? p.name : null,
    referralCode: typeof p.referralCode === 'string' ? p.referralCode : null,
    untrusted: p.untrusted === true,
    score: typeof p.score === 'number' ? p.score : null,
    signals: Array.isArray(p.signals) ? p.signals.filter((s): s is string => typeof s === 'string') : [],
    ip: p.ip,
  }
}
