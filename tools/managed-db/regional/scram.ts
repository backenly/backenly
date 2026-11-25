/**
 * A PostgreSQL SCRAM-SHA-256 password verifier, computed where the password is.
 *
 * `ALTER ROLE r PASSWORD '<verifier>'` stores a verifier PostgreSQL accepts
 * as-is, so the database (and the one-off admin task that talks to it) never
 * sees the password itself: only the operator's machine holds it, long enough
 * to write it to Secrets Manager.
 *
 * ONE IMPLEMENTATION. The verifier is lib/data-plane/scram.ts's, the same code
 * that computes the verifiers of customers' logins for the connection pooler,
 * re-exported here so the procedure and the application can never disagree on
 * the format. Only launch.ts (run from a checkout with `npx tsx`) and the tests
 * import this file; the procedure's image carries bootstrap.sh and SQL alone
 * (image-files.txt, Dockerfile.bootstrap), so the relative import never has to
 * resolve inside it.
 *
 * Its rules suit every password the procedure makes: printable ASCII without
 * spaces (generatePassword() is hex), a random 16-byte salt, and 4096
 * iterations, PostgreSQL's default and what backenly_pooler.logins requires.
 */

import { randomBytes } from 'node:crypto'

export { SCRAM_ITERATIONS, scramSha256Verifier } from '../../../lib/data-plane/scram'

/** A random password the procedure can use: 32 bytes of hex. */
export function generatePassword(): string {
  return randomBytes(32).toString('hex')
}
