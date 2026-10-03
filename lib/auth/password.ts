import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

/**
 * Bcrypt rounds (work factor). 12 is the 2026 OWASP floor.
 * ALL password hashing in the codebase must go through hashPassword(),
 * never raw `bcrypt.hash(..., 10)`. The platform/end-user split that used
 * to allow 10 for end-users was a security drift; everything is 12 now.
 */
const BCRYPT_ROUNDS = 12

/**
 * Hash a password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, BCRYPT_ROUNDS)
}

/**
 * Verify a password against a hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash)
}

/**
 * A hash that exists only to be compared against and fail.
 *
 * Sign-in returns the same message for an unknown address and a wrong
 * password, but it used to return it at a very different SPEED: a missing user
 * skipped the bcrypt comparison entirely, while a real one paid for it. bcrypt
 * is deliberately slow, so that gap is tens of milliseconds and measurable
 * over a handful of samples. Matching error messages with unmatched timing is
 * an account-enumeration oracle wearing the right words.
 *
 * Derived from BCRYPT_ROUNDS rather than pasted in as a literal, because the
 * decoy only disguises the real comparison while it costs the same. A
 * hard-coded cost-10 digest sitting beside a cost-12 product is roughly four
 * times cheaper, which leaves the oracle open and the mitigation looking
 * present.
 *
 * Computed once, lazily, from a random secret nobody can submit. The compare
 * is guaranteed to fail; the only thing wanted is the work.
 */
let decoyHashPromise: Promise<string> | null = null

export async function verifyPasswordAgainstDecoy(password: string): Promise<false> {
  if (!decoyHashPromise) {
    decoyHashPromise = bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS)
  }
  await bcrypt.compare(password, await decoyHashPromise)
  return false
}

/**
 * Validate password strength. Used by signup, password reset, and any other
 * surface that accepts a new password. Lives in ./password-policy so the pages
 * can run the same check without bundling bcrypt.
 */
export { validatePasswordStrength } from './password-policy'
