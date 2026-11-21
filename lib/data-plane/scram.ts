/**
 * SCRAM-SHA-256 PASSWORD VERIFIERS, AS POSTGRESQL STORES THEM
 * ===========================================================
 * A customer connects psql or an ORM to their project's own database through
 * the connection pooler (services/pooler). The pooler never sees a stored
 * password from the server, so Backenly computes each login's verifier here
 * and puts the SAME string in two places:
 *
 *   ALTER ROLE <login> PASSWORD '<verifier>'    PostgreSQL stores a string
 *                                               that parses as a verifier
 *                                               as-is, without rehashing it
 *   backenly_pooler.logins.verifier             what the pooler's auth_query
 *                                               returns for the login
 *                                               (tools/managed-db/regional/sql/pooler.sql)
 *
 * The pooler checks the client's proof against that verifier and then signs
 * in to the server with the keys the proof carried, which works only because
 * the server holds the identical salt, iteration count and keys.
 *
 * Format (PostgreSQL src/common/scram-common.c, scram_build_secret):
 *
 *   SCRAM-SHA-256$<iterations>:<salt, base64>$<StoredKey, base64>:<ServerKey, base64>
 *
 * with, per RFC 5802 section 3 and RFC 7677:
 *
 *   SaltedPassword = Hi(password, salt, iterations)    (PBKDF2-HMAC-SHA-256, 32 bytes)
 *   ClientKey      = HMAC(SaltedPassword, "Client Key")
 *   StoredKey      = SHA-256(ClientKey)
 *   ServerKey      = HMAC(SaltedPassword, "Server Key")
 *
 * PASSWORDS ARE PRINTABLE ASCII, WITHOUT SPACES. PostgreSQL normalizes a
 * password with SASLprep before hashing it, except when the password is pure
 * ASCII, which it uses byte for byte; libpq does the same on the client side,
 * while other clients (node-postgres among them) never normalize. For an ASCII
 * password every client and the server therefore agree, and the verifier
 * computed here is exactly the one PostgreSQL would compute. Spaces are
 * refused too: a password with one must be quoted in a key=value connection
 * string and is split by tools that read whitespace-separated values. The
 * passwords Backenly issues are random, so neither rule costs anything.
 *
 * Nothing here logs, and no error message carries the password.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/** PostgreSQL's default (scram_iterations), and what backenly_pooler.logins requires. */
export const SCRAM_ITERATIONS = 4096

/** PostgreSQL's salt length (SCRAM_DEFAULT_SALT_LEN). */
export const SCRAM_SALT_BYTES = 16

/**
 * PgBouncer 1.26 refuses a SCRAM exchange that asks for more iterations than
 * this, so a verifier above it could never be used through the pooler.
 */
export const SCRAM_MAX_ITERATIONS = 1_000_000

const KEY_BYTES = 32
const PREFIX = 'SCRAM-SHA-256$'

export interface ScramVerifierOptions {
  /** Fixed salt, for tests and known vectors. Default: 16 random bytes. */
  salt?: Buffer
  /** Default 4096. */
  iterations?: number
}

/**
 * The PostgreSQL SCRAM-SHA-256 verifier for `password`.
 *
 * Throws (without echoing the password) for a password that is not printable
 * ASCII without spaces, an empty salt, or an iteration count outside
 * 4096..1,000,000.
 */
export function scramSha256Verifier(password: string, options: ScramVerifierOptions = {}): string {
  const { salt = randomBytes(SCRAM_SALT_BYTES), iterations = SCRAM_ITERATIONS } = options
  if (typeof password !== 'string' || !/^[\x21-\x7e]+$/.test(password)) {
    throw new Error(
      'A password must be non-empty printable ASCII without spaces, so that PostgreSQL and every client hash it the same way.',
    )
  }
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw new Error('The SCRAM salt must be a non-empty Buffer.')
  }
  if (!Number.isInteger(iterations) || iterations < SCRAM_ITERATIONS || iterations > SCRAM_MAX_ITERATIONS) {
    throw new Error(`SCRAM iterations must be an integer from ${SCRAM_ITERATIONS} to ${SCRAM_MAX_ITERATIONS}.`)
  }
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, KEY_BYTES, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `${PREFIX}${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** Canonical, padded base64 of at least one byte, and the bytes it decodes to. */
function decodeBase64(text: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) || text.length === 0) return null
  const bytes = Buffer.from(text, 'base64')
  // Unused low bits in the last character would decode to the same bytes, so
  // only the encoding Node itself produces is accepted.
  return bytes.toString('base64') === text ? bytes : null
}

/**
 * True when `value` is a SCRAM-SHA-256 verifier that PostgreSQL stores as-is
 * and the pooler can use: the exact layout above, a decimal iteration count
 * from 1 to 1,000,000, a base64 salt, and a StoredKey and ServerKey of 32 bytes
 * each.
 *
 * This is at least as strict as PostgreSQL's own parse_scram_secret
 * (src/backend/libpq/auth-scram.c), which matters: a string PostgreSQL does
 * NOT recognise as a verifier is taken as a plaintext password and hashed, so
 * `ALTER ROLE ... PASSWORD` would quietly set a different password from the
 * one the pooler serves. Check with this before writing either place.
 */
export function isScramVerifier(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return false
  const match = /^SCRAM-SHA-256\$([1-9][0-9]{0,6}):([^$:]+)\$([^$:]+):([^$:]+)$/.exec(value)
  if (!match) return false
  const iterations = Number(match[1])
  if (iterations > SCRAM_MAX_ITERATIONS) return false
  const salt = decodeBase64(match[2])
  const storedKey = decodeBase64(match[3])
  const serverKey = decodeBase64(match[4])
  return Boolean(salt && storedKey?.length === KEY_BYTES && serverKey?.length === KEY_BYTES)
}
