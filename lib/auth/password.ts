import bcrypt from 'bcrypt'
import { randomBytes } from 'crypto'

/**
 * Bcrypt rounds (work factor). OWASP's Password Storage Cheat Sheet asks for
 * at least 10; Backenly uses 12.
 * ALL password hashing in the codebase must go through hashPassword(),
 * never raw `bcrypt.hash(..., 10)`. The platform/end-user split that used
 * to allow 10 for end-users was a security drift; everything is 12 now.
 */
const BCRYPT_ROUNDS = 12

/**
 * Hashing runs in native code on libuv's worker threads, never on the event
 * loop.
 *
 * It ran bcryptjs, a JavaScript port, on the event loop. One cost-12 hash is
 * about 0.4 s of CPU, done in 100 ms slices, and every other request in the
 * process waited out each slice. The production web task has one vCPU, so a
 * few sign-ups at once slowed every page and API call it served (production
 * QA, 2026-11-09: sign-up p95 8.5 s, uploads of a few bytes p95 5.5 s). The
 * algorithm, the cost and the format are unchanged: every stored hash still
 * verifies, and bcryptjs, which functions can use, verifies these.
 *
 * At most HASH_SLOTS run at once. Hashing is all CPU, so on one or two vCPUs
 * more at once finishes none of them sooner, and each holds one of libuv's
 * four worker threads, which DNS lookups and file reads wait for too.
 */
const HASH_SLOTS = Math.max(1, Math.floor(Number(process.env.PASSWORD_HASH_CONCURRENCY)) || 2)

let running = 0
const waiting: Array<() => void> = []

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= HASH_SLOTS) await new Promise<void>((resolve) => waiting.push(resolve))
  else running++
  try {
    return await work()
  } finally {
    // The slot passes straight to the next in line, so `running` counts it still.
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/**
 * Hash a password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return inSlot(() => bcrypt.hash(password, BCRYPT_ROUNDS))
}

/**
 * The dearest bcrypt cost a stored hash is checked at. Backenly makes its own
 * at BCRYPT_ROUNDS (12), and bcrypt hashes moved in from other systems use 10
 * or so. Each step of cost doubles a check's time, and a check holds one of
 * the HASH_SLOTS every sign-in in this process shares, whatever the project:
 * a stored hash at cost 31 would hold one for hours. So a hash dearer than this
 * is not checked at all; the check answers no, and the user sets a new password
 * with "Forgot password".
 */
export const MAX_VERIFIED_BCRYPT_COST = 14

/** The cost a bcrypt hash declares, or null when it is not a bcrypt hash. */
export function bcryptCost(hash: string): number | null {
  const m = /^\$2[abxy]\$(\d{2})\$/.exec(hash)
  return m ? Number(m[1]) : null
}

/**
 * Verify a password against a hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const cost = typeof hash === 'string' ? bcryptCost(hash) : null
  if (cost !== null && cost > MAX_VERIFIED_BCRYPT_COST) return false
  return inSlot(() => bcrypt.compare(password, hash))
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
    decoyHashPromise = hashPassword(randomBytes(32).toString('hex'))
  }
  await verifyPassword(password, await decoyHashPromise)
  return false
}

/**
 * Validate password strength. Used by signup, password reset, and any other
 * surface that accepts a new password. Lives in ./password-policy so the pages
 * can run the same check without bundling bcrypt.
 */
export { validatePasswordStrength } from './password-policy'
