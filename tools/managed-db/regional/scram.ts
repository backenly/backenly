/**
 * A PostgreSQL SCRAM-SHA-256 password verifier, computed where the password is.
 *
 * `ALTER ROLE r PASSWORD '<verifier>'` stores a verifier PostgreSQL accepts
 * as-is, so the database (and the one-off admin task that talks to it) never
 * sees the password itself: only the operator's machine holds it, long enough
 * to write the connection string to Secrets Manager.
 *
 * Format (PostgreSQL src/common/scram-common.c):
 *   SCRAM-SHA-256$<iterations>:<salt, base64>$<StoredKey, base64>:<ServerKey, base64>
 * where SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations),
 *       StoredKey      = SHA-256(HMAC(SaltedPassword, "Client Key")),
 *       ServerKey      = HMAC(SaltedPassword, "Server Key").
 *
 * Only printable ASCII passwords are accepted. PostgreSQL runs SASLprep on the
 * password before hashing; for ASCII that is the identity, so the verifier
 * computed here is exactly the one PostgreSQL would compute. The procedure's
 * own passwords are random hex, so this costs nothing.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

export const SCRAM_ITERATIONS = 4096

export function scramSha256Verifier(
  password: string,
  { salt = randomBytes(16), iterations = SCRAM_ITERATIONS }: { salt?: Buffer; iterations?: number } = {},
): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('Only printable ASCII passwords are supported (no spaces), so SASLprep cannot change them.')
  }
  if (!Number.isInteger(iterations) || iterations < 4096) {
    throw new Error('SCRAM iterations must be an integer of at least 4096.')
  }
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** A random password the procedure can use: 32 bytes of hex. */
export function generatePassword(): string {
  return randomBytes(32).toString('hex')
}
