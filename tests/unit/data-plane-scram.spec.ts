/**
 * SCRAM-SHA-256 VERIFIERS, CHECKED AGAINST VECTORS THIS CODE DID NOT MAKE
 * ======================================================================
 * lib/data-plane/scram.ts computes the verifier a customer login gets on the
 * server and in the pooler's login table. If it differs from what PostgreSQL
 * computes by one byte, the login fails everywhere, so it is checked against
 * four things it did not produce:
 *
 *   - a verifier PostgreSQL 16 stored for a known password and salt
 *     (read back from pg_authid; the same vector pins the regional
 *     procedure's copy in tests/unit/regional-bootstrap.spec.ts);
 *   - PostgreSQL 16's own regression suite (src/test/regress/sql/password.sql
 *     on REL_16_STABLE), whose regress_passwd_empty verifier PostgreSQL
 *     recognises as the empty password, and whose regress_passwd_sha_len*
 *     roles mark which strings it stores as verifiers and which it rehashes;
 *   - the SCRAM-SHA-256 exchange printed in RFC 7677 section 3 (user "user",
 *     password "pencil"), completed with the keys computed here;
 *   - Hi() written out from RFC 5802 section 2.2 in this file, HMAC by HMAC,
 *     sharing nothing with the implementation but node:crypto's HMAC.
 *
 * tests/integration/pooler-auth.spec.ts then logs in to a real PostgreSQL 16
 * with the plain password of a role whose verifier came from here.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'

import {
  SCRAM_ITERATIONS,
  SCRAM_MAX_ITERATIONS,
  isScramVerifier,
  scramSha256Verifier,
} from '@/lib/data-plane/scram'

const hmac = (key: Buffer, data: Buffer | string) => createHmac('sha256', key).update(data).digest()
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest()
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((byte, i) => byte ^ b[i]))

/** RFC 5802 section 2.2: Hi(str, salt, i) = U1 XOR U2 XOR ... XOR Ui. */
function hi(password: Buffer, salt: Buffer, iterations: number): Buffer {
  let u = hmac(password, Buffer.concat([salt, Buffer.from([0, 0, 0, 1])]))
  let result = u
  for (let k = 2; k <= iterations; k++) {
    u = hmac(password, u)
    result = xor(result, u)
  }
  return result
}

/** RFC 5802 section 3, in PostgreSQL's layout. */
function rfcVerifier(password: string, salt: Buffer, iterations: number): string {
  const salted = hi(Buffer.from(password, 'utf8'), salt, iterations)
  const storedKey = sha256(hmac(salted, 'Client Key'))
  const serverKey = hmac(salted, 'Server Key')
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

function parts(verifier: string) {
  const [, iterations, salt, storedKey, serverKey] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier)!
  return {
    iterations: Number(iterations),
    salt: Buffer.from(salt, 'base64'),
    storedKey: Buffer.from(storedKey, 'base64'),
    serverKey: Buffer.from(serverKey, 'base64'),
  }
}

// PostgreSQL 16, CREATE ROLE ... PASSWORD 'correct-horse-battery-staple' with
// password_encryption = scram-sha-256, read back from pg_authid.
const POSTGRES_16_STORED =
  'SCRAM-SHA-256$4096:l1q1LM5wulE09eK5ch5D1Q==$UsgAQStG1CcCMWs28EHHX+0CuWgtlMCFF1FG5Evjv8o=:f7pMc9/OFuRTZPys2pz7heAXtNgsi8BlcjouNjQOquw='

// src/test/regress/sql/password.sql (REL_16_STABLE). PostgreSQL answers
// "empty string is not a valid password" to this one (expected/password.out),
// which it can only do by verifying "" against it.
const REGRESS_EMPTY_PASSWORD =
  'SCRAM-SHA-256$4096:hpFyHTUsSWcR7O9P$LgZFIt6Oqdo27ZFKbZ2nV+vtnYM995pDh9ca6WSi120=:qVV5NeluNfUPkwm7Vqat25RjSPLkGeoZBQs6wVv+um4='
// Same file: len0 is stored as a verifier; len1 and len2 have keys longer than
// 32 bytes and PostgreSQL rehashes them as plaintext.
const REGRESS_SHA_LEN0 =
  'SCRAM-SHA-256$4096:A6xHKoH/494E941doaPOYg==$Ky+A30sewHIH3VHQLRN9vYsuzlgNyGNKCh37dy96Rqw=:COPdlNiIkrsacU5QoxydEuOH6e/KfiipeETb/bPw8ZI='
const REGRESS_SHA_LEN1 =
  'SCRAM-SHA-256$4096:A6xHKoH/494E941doaPOYg==$Ky+A30sewHIH3VHQLRN9vYsuzlgNyGNKCh37dy96RqwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:COPdlNiIkrsacU5QoxydEuOH6e/KfiipeETb/bPw8ZI='
const REGRESS_SHA_LEN2 =
  'SCRAM-SHA-256$4096:A6xHKoH/494E941doaPOYg==$Ky+A30sewHIH3VHQLRN9vYsuzlgNyGNKCh37dy96Rqw=:COPdlNiIkrsacU5QoxydEuOH6e/KfiipeETb/bPw8ZIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
// Same file, regress_passwd3: stored as-is (a 10-byte salt).
const REGRESS_PASSWD3 =
  'SCRAM-SHA-256$4096:VLK4RMaQLCvNtQ==$6YtlR4t69SguDiwFvbVgVZtuz6gpJQQqUMZ7IQJK5yI=:ps75jrHeYU4lXCcXI4O8oIdJ3eO8o2jirjruw9phBTo='

describe('scramSha256Verifier', () => {
  it('is the verifier PostgreSQL 16 stored for the same password and salt', () => {
    const salt = Buffer.from('l1q1LM5wulE09eK5ch5D1Q==', 'base64')
    expect(scramSha256Verifier('correct-horse-battery-staple', { salt })).toBe(POSTGRES_16_STORED)
  })

  it('is built by the algorithm that reproduces PostgreSQL’s own regression vector', () => {
    // The empty password cannot be issued (PostgreSQL refuses it as a
    // password at all), so the vector proves the independent Hi() below, and
    // the next cases tie that to scram.ts.
    const salt = Buffer.from('hpFyHTUsSWcR7O9P', 'base64')
    expect(rfcVerifier('', salt, 4096)).toBe(REGRESS_EMPTY_PASSWORD)
    expect(rfcVerifier('correct-horse-battery-staple', Buffer.from('l1q1LM5wulE09eK5ch5D1Q==', 'base64'), 4096)).toBe(
      POSTGRES_16_STORED,
    )
  })

  it('agrees with RFC 5802 written out by hand, for random passwords, salts and iteration counts', () => {
    for (const iterations of [4096, 4096, 5000, 8192]) {
      const password = randomBytes(24).toString('base64')
      const salt = randomBytes(16)
      expect(scramSha256Verifier(password, { salt, iterations })).toBe(rfcVerifier(password, salt, iterations))
    }
  })

  it('completes the SCRAM-SHA-256 exchange printed in RFC 7677', () => {
    const verifier = scramSha256Verifier('pencil', { salt: Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64') })
    const { storedKey, serverKey } = parts(verifier)
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
    const authMessage = [
      'n=user,r=rOprNGfwEbeRWgbNEkqO',
      `r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`,
      `c=biws,r=${nonce}`,
    ].join(',')

    // The server's final message is HMAC(ServerKey, AuthMessage).
    expect(hmac(serverKey, authMessage).toString('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')

    // The client's proof verifies against StoredKey, as PostgreSQL and the
    // pooler check it: ClientKey = proof XOR HMAC(StoredKey, AuthMessage).
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64')
    const clientKey = xor(proof, hmac(storedKey, authMessage))
    expect(sha256(clientKey).equals(storedKey)).toBe(true)
  })

  it('salts every verifier with 16 fresh random bytes and 4096 iterations by default', () => {
    const a = scramSha256Verifier('the-same-password')
    const b = scramSha256Verifier('the-same-password')
    expect(a).not.toBe(b)
    for (const v of [a, b]) {
      const { iterations, salt, storedKey, serverKey } = parts(v)
      expect(iterations).toBe(SCRAM_ITERATIONS)
      expect(salt).toHaveLength(16)
      expect(storedKey).toHaveLength(32)
      expect(serverKey).toHaveLength(32)
      expect(isScramVerifier(v)).toBe(true)
    }
  })

  it('refuses what clients would hash differently, and iteration counts the pooler cannot use', () => {
    const password = 'Pässwörd-that-must-not-appear'
    let message = ''
    try {
      scramSha256Verifier(password)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/printable ASCII without spaces/)
    expect(message).not.toContain(password)

    for (const bad of ['', 'has a space', 'tab\there', 'line\nbreak', 'nul\u0000byte']) {
      expect(() => scramSha256Verifier(bad)).toThrow(/printable ASCII without spaces/)
    }
    expect(() => scramSha256Verifier(42 as unknown as string)).toThrow(/printable ASCII/)
    expect(() => scramSha256Verifier('x'.repeat(32), { iterations: 4095 })).toThrow(/4096 to 1000000/)
    expect(() => scramSha256Verifier('x'.repeat(32), { iterations: SCRAM_MAX_ITERATIONS + 1 })).toThrow(/4096 to 1000000/)
    expect(() => scramSha256Verifier('x'.repeat(32), { iterations: 4096.5 })).toThrow(/4096 to 1000000/)
    expect(() => scramSha256Verifier('x'.repeat(32), { salt: Buffer.alloc(0) })).toThrow(/non-empty Buffer/)
  })
})

describe('isScramVerifier', () => {
  it('accepts what PostgreSQL stores as a verifier', () => {
    for (const v of [POSTGRES_16_STORED, REGRESS_EMPTY_PASSWORD, REGRESS_SHA_LEN0, REGRESS_PASSWD3]) {
      expect(isScramVerifier(v)).toBe(true)
    }
    expect(isScramVerifier(REGRESS_SHA_LEN0.replace('$4096:', `$${SCRAM_MAX_ITERATIONS}:`))).toBe(true)
    expect(isScramVerifier(REGRESS_SHA_LEN0.replace('$4096:', '$1:'))).toBe(true)
  })

  it('rejects what PostgreSQL would rehash as a plaintext password', () => {
    for (const v of [REGRESS_SHA_LEN1, REGRESS_SHA_LEN2, 'SCRAM-SHA-256$1234']) expect(isScramVerifier(v)).toBe(false)
  })

  it('rejects anything that is not exactly the layout', () => {
    const [, salt, keys] = /^SCRAM-SHA-256\$4096:([^$]+)\$(.+)$/.exec(REGRESS_SHA_LEN0)!
    const [storedKey, serverKey] = keys.split(':')
    const bad = [
      undefined,
      null,
      42,
      '',
      'a-plain-password',
      'md5cd3578025fe2c3d7ed1b9a9b26238b70',
      REGRESS_SHA_LEN0.replace('SCRAM-SHA-256', 'scram-sha-256'),
      ` ${REGRESS_SHA_LEN0}`,
      `${REGRESS_SHA_LEN0} `,
      `${REGRESS_SHA_LEN0}\n`,
      `${REGRESS_SHA_LEN0}:extra`,
      `SCRAM-SHA-256$0:${salt}$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$04096:${salt}$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$+4096:${salt}$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$-4096:${salt}$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$ 4096:${salt}$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$${SCRAM_MAX_ITERATIONS + 1}:${salt}$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$4096:$${storedKey}:${serverKey}`,
      `SCRAM-SHA-256$4096:${salt}$${storedKey}`,
      `SCRAM-SHA-256$4096:${salt}$${storedKey.replace(/=$/, '')}:${serverKey}`,
      // Unused low bits set in the last character: decodes, but is not the encoding.
      `SCRAM-SHA-256$4096:${salt}$${storedKey.replace(/w=$/, 'x=')}:${serverKey}`,
      `SCRAM-SHA-256$4096:${salt}$${storedKey}:${serverKey.slice(4)}`,
      `SCRAM-SHA-256$4096:${salt}$${storedKey}:${serverKey.replace('/', '_')}`,
      `SCRAM-SHA-256$4096:${salt}$${storedKey}:${serverKey}'; DROP ROLE x; --`,
    ]
    for (const v of bad) expect(isScramVerifier(v)).toBe(false)
  })
})
