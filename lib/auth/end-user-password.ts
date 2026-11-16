/**
 * The end-user password check both sign-in servers run
 * (app/api/v1/[projectId]/auth/signin/route.ts and server/routes/auth.ts).
 *
 * A stored password is Backenly's bcrypt, or a hash brought in by an import
 * that sign-in still has to accept once: Firebase's scrypt
 * (lib/auth/firebase-scrypt.ts), written only by the Firebase importer. A
 * Supabase import brings bcrypt, which needs nothing here.
 *
 * An imported hash is checked once. When it matches, the person's password is
 * known for that moment, so it is hashed again with bcrypt and the imported
 * hash is dropped: after one sign-in the account is exactly like any other.
 * The replacement is a compare-and-swap on the old value, so a password reset
 * that landed between the check and the write is never undone.
 *
 * Timing: every failed check answers at the same moment, whatever was stored.
 * The work differs: an unknown address pays the bcrypt decoy
 * (verifyPasswordAgainstDecoy, lib/auth/password.ts), a bcrypt account its own
 * comparison, and an imported Firebase account one scrypt AND the decoy, which
 * is tens of milliseconds more. Left to show, that difference would tell anyone
 * which addresses were moved in from Firebase and have not signed in since. So
 * the callers time each check (startPasswordCheckTimer) and hold a failure until
 * FAILED_CHECK_FLOOR_MS after the check began. Work that ran past the floor
 * (a loaded server) is held to the next whole multiple of it, so even then the
 * answer lands on a boundary every path shares. A success is never held: the
 * person proved the password and there is nothing left to learn from its timing.
 */

import { hashPassword, verifyPassword, verifyPasswordAgainstDecoy } from './password'
import { isFirebaseHash, verifyFirebaseHash } from './firebase-scrypt'

/**
 * The least time a failed password check takes, from its start to the answer.
 * Well above any one path's work on a normal day (bcrypt at cost 12 plus one
 * Firebase scrypt is a few hundred milliseconds), so every failure ends here.
 */
export const FAILED_CHECK_FLOOR_MS = 1_000

/**
 * How long to hold a failure whose check took `elapsedMs`: to the floor, or to
 * the next whole multiple of it when the work itself took longer.
 */
export function failedCheckPadding(elapsedMs: number, floorMs: number = FAILED_CHECK_FLOOR_MS): number {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const boundary = Math.max(1, Math.ceil(elapsed / floorMs)) * floorMs
  return boundary - elapsed
}

/** Where a check's time comes from: the real clock, or a test's. */
export interface CheckClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const REAL_CLOCK: CheckClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Start timing a password check; call `failed()` before answering a failure.
 * Both sign-in routes start it just before checkEndUserPassword, so the time
 * measured is the check's own, whichever kind of hash (or none) it met.
 */
export function startPasswordCheckTimer(clock: CheckClock = REAL_CLOCK, floorMs: number = FAILED_CHECK_FLOOR_MS) {
  const started = clock.now()
  return {
    /** Hold this failure until it costs what every failure costs. */
    async failed(): Promise<void> {
      await clock.sleep(failedCheckPadding(clock.now() - started, floorMs))
    },
  }
}

export interface EndUserPasswordCheck {
  valid: boolean
  /** The password matched a hash from another system: store Backenly's bcrypt in its place. */
  rehash: boolean
}

/**
 * Check `password` against what the users row stores. With nothing stored (no
 * such user, or a user who signs in only with a provider) the decoy is paid and
 * the answer is no.
 */
export async function checkEndUserPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<EndUserPasswordCheck> {
  if (!storedHash) {
    await verifyPasswordAgainstDecoy(password)
    return { valid: false, rehash: false }
  }
  if (isFirebaseHash(storedHash)) {
    if (await verifyFirebaseHash(password, storedHash)) return { valid: true, rehash: true }
    await verifyPasswordAgainstDecoy(password)
    return { valid: false, rehash: false }
  }
  return { valid: await verifyPassword(password, storedHash), rehash: false }
}

/**
 * Writes `newHash` in place of `oldHash` for one account; true when a row
 * changed. A sign-in route hands over the real one (endUserPasswordWriter).
 */
export type PasswordHashWriter = (newHash: string, oldHash: string) => Promise<boolean>

/**
 * Hash `password` with bcrypt and store it in place of the imported `oldHash`.
 * True when the row now holds bcrypt; false when it had changed meanwhile (a
 * reset), which leaves that newer password alone.
 */
export async function replaceImportedPasswordHash(
  password: string,
  oldHash: string,
  write: PasswordHashWriter,
): Promise<boolean> {
  const newHash = await hashPassword(password)
  return write(newHash, oldHash)
}

/**
 * The writer for a project's users table: one UPDATE by the account's email
 * (unique, indexed, and the address sign-in just looked up), only while the
 * column still holds the hash that was checked. Service-role, as sign-in reads
 * the row: the caller has no session yet, and the table's own-rows policy
 * would hide it.
 */
export function endUserPasswordWriter(
  projectId: string,
  schemaName: string,
  passwordColumn: string,
  email: string,
): PasswordHashWriter {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordColumn)) {
    throw new Error(`Unexpected password column name: ${passwordColumn}`)
  }
  return async (newHash, oldHash) => {
    const { executeWithUserContext } = await import('@/lib/services/workspace-rls')
    const rows = await executeWithUserContext<{ x: number }>(
      projectId,
      '',
      true,
      `UPDATE "${schemaName}"."users" SET "${passwordColumn}" = $1
        WHERE email = $2 AND "${passwordColumn}" = $3
        RETURNING 1 AS x`,
      [newHash, email, oldHash],
    )
    return rows.length > 0
  }
}
