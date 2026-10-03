/**
 * THE BUNDLE MUST BE USELESS WITHOUT THE OPERATOR'S CREDENTIAL
 * ===========================================================
 * The encryption in a recovery bundle is the part most likely to be
 * theatrical - present, plausible-looking, and not actually protecting
 * anything, because the key travelled with the ciphertext.
 *
 * These assert the properties that make it real, and they assert the failure
 * modes as carefully as the success one. On the day a bundle is opened, the
 * operator has already lost the original machine; "it did not work" is not an
 * acceptable answer, and neither is quietly returning the wrong bytes.
 */

import {
  decryptBlob,
  encryptBlob,
  generateDataKey,
  generateRecoveryCredential,
  KDF_PARAMS,
  RecoveryIntegrityError,
  RecoveryKeyError,
  sha256,
  unwrapDataKey,
  wrapDataKey,
} from '@/lib/recovery/crypto'

// scrypt at the real cost is deliberately slow. That is the point of it, but it
// means this suite needs more than the default budget.
jest.setTimeout(60_000)

const CREDENTIAL = 'ABCDEFGH-JKLMNPQR-STUVWXYZ-23456789'

describe('wrapping the bundle key', () => {
  it('round-trips the data key', () => {
    const dataKey = generateDataKey()
    const wrapped = wrapDataKey(dataKey, CREDENTIAL)
    expect(unwrapDataKey(wrapped, CREDENTIAL).equals(dataKey)).toBe(true)
  })

  it('refuses the wrong credential instead of returning garbage', () => {
    // AES-GCM authenticates, so a wrong key fails rather than decrypting to
    // noise. Asserted because the alternative - silently restoring 32 random
    // bytes as the data key - would fail much later and much less clearly.
    const wrapped = wrapDataKey(generateDataKey(), CREDENTIAL)
    expect(() => unwrapDataKey(wrapped, 'WRONG-CREDENTIAL')).toThrow(RecoveryKeyError)
  })

  it('tells the operator which of the two things went wrong', () => {
    // Wrong credential and altered manifest are indistinguishable to GCM, and
    // they need opposite responses: find the other passphrase, or go and fetch
    // another copy of the bundle. So the message names both rather than
    // guessing one.
    let message = ''
    try {
      unwrapDataKey(wrapDataKey(generateDataKey(), CREDENTIAL), 'WRONG')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/credential is wrong/i)
    expect(message).toMatch(/altered/i)
  })

  it('separates a DAMAGED manifest from a wrong credential', () => {
    // A truncated salt is not a credential problem, and saying so saves the
    // operator from hunting for a passphrase that would never have worked.
    const wrapped = wrapDataKey(generateDataKey(), CREDENTIAL)
    const damaged = { ...wrapped, salt: Buffer.from('short').toString('base64') }
    expect(() => unwrapDataKey(damaged, CREDENTIAL)).toThrow(RecoveryIntegrityError)
  })

  it('refuses an empty credential rather than encrypting with nothing', () => {
    expect(() => wrapDataKey(generateDataKey(), '')).toThrow(RecoveryKeyError)
    expect(() => wrapDataKey(generateDataKey(), '   ')).toThrow(RecoveryKeyError)
  })

  it('never reuses a salt or an IV', () => {
    // GCM catastrophically loses confidentiality if an IV repeats under the same
    // key, and a fixed salt would let one cracked credential open every bundle.
    const dataKey = generateDataKey()
    const a = wrapDataKey(dataKey, CREDENTIAL)
    const b = wrapDataKey(dataKey, CREDENTIAL)
    expect(a.salt).not.toEqual(b.salt)
    expect(a.iv).not.toEqual(b.iv)
    expect(a.ciphertext).not.toEqual(b.ciphertext)
  })

  it('does not put the data key anywhere in the wrapped structure', () => {
    // The whole claim of this design, asserted against the serialised form
    // rather than against the shape of the type.
    const dataKey = generateDataKey()
    const serialised = JSON.stringify(wrapDataKey(dataKey, CREDENTIAL))
    expect(serialised).not.toContain(dataKey.toString('base64'))
    expect(serialised).not.toContain(dataKey.toString('hex'))
    expect(serialised).not.toContain(CREDENTIAL)
  })
})

describe('the KDF cost travels with the bundle', () => {
  it('records the parameters it was written with', () => {
    const wrapped = wrapDataKey(generateDataKey(), CREDENTIAL)
    expect(wrapped.kdfParams).toEqual(KDF_PARAMS)
    expect(wrapped.kdf).toBe('scrypt')
  })

  it('opens a bundle written with DIFFERENT parameters', () => {
    // The forward-compatibility property. Raising the cost later must not make
    // last year's bundle unreadable - and the failure would look exactly like a
    // wrong credential, which is the worst possible way to discover it.
    const dataKey = generateDataKey()
    const wrapped = wrapDataKey(dataKey, CREDENTIAL)

    // Simulate a reader whose current constants differ from the bundle's by
    // reading a bundle whose recorded params are lower than today's.
    const older = {
      ...wrapDataKeyWithParams(dataKey, CREDENTIAL, { N: 16384, r: 8, p: 1 }),
    }
    expect(older.kdfParams.N).not.toEqual(wrapped.kdfParams.N)
    expect(unwrapDataKey(older, CREDENTIAL).equals(dataKey)).toBe(true)
  })

  it('uses a cost high enough to matter', () => {
    // A guard against someone lowering this to speed up a test suite. 64 MB of
    // scrypt is what stands between a leaked bundle and its OAuth secrets.
    expect(KDF_PARAMS.N).toBeGreaterThanOrEqual(32768)
  })
})

/**
 * Writes a wrapped key at explicitly chosen parameters.
 *
 * Mirrors wrapDataKey, because the production function deliberately offers no
 * way to write a weaker bundle - the only caller that needs one is this test,
 * proving the reader honours what it is given.
 */
function wrapDataKeyWithParams(
  dataKey: Buffer,
  credential: string,
  params: { N: number; r: number; p: number },
) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto')
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(credential.normalize('NFKC'), salt, 32, {
    ...params,
    maxmem: 128 * 1024 * 1024,
  })
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return {
    algorithm: 'aes-256-gcm' as const,
    kdf: 'scrypt' as const,
    kdfParams: params,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

describe('encrypting a component', () => {
  it('round-trips content', () => {
    const dataKey = generateDataKey()
    const plaintext = Buffer.from('CREATE TABLE users (id uuid primary key);')
    expect(decryptBlob(encryptBlob(plaintext, dataKey), dataKey).equals(plaintext)).toBe(true)
  })

  it('detects a single altered byte', () => {
    // Without this, a corrupted archive restores corrupted data and reports
    // success - the failure mode a checksum-and-authenticate design exists to
    // rule out.
    const dataKey = generateDataKey()
    const blob = encryptBlob(Buffer.from('secret configuration'), dataKey)
    const raw = Buffer.from(blob.ciphertext, 'base64')
    raw[0] = raw[0] ^ 0xff
    expect(() => decryptBlob({ ...blob, ciphertext: raw.toString('base64') }, dataKey))
      .toThrow(RecoveryIntegrityError)
  })

  it('refuses a blob encrypted under a different bundle key', () => {
    const blob = encryptBlob(Buffer.from('x'), generateDataKey())
    expect(() => decryptBlob(blob, generateDataKey())).toThrow(RecoveryIntegrityError)
  })

  it('never reuses an IV across components', () => {
    const dataKey = generateDataKey()
    const ivs = new Set(
      Array.from({ length: 50 }, () => encryptBlob(Buffer.from('same'), dataKey).iv),
    )
    expect(ivs.size).toBe(50)
  })
})

describe('the operator-held credential', () => {
  it('is generated, not chosen', () => {
    // A passphrase invented under pressure is the weakest part of this design
    // and the one part no amount of KDF cost repairs.
    const a = generateRecoveryCredential()
    const b = generateRecoveryCredential()
    expect(a).not.toEqual(b)
  })

  it('survives being read aloud and retyped', () => {
    // Which is what actually happens to a recovery credential. No characters
    // that are ambiguous in print, and grouped for transcription.
    const credential = generateRecoveryCredential()
    expect(credential).toMatch(/^[A-HJ-NP-Z2-9-]+$/)
    expect(credential).not.toMatch(/[IO01]/)
    expect(credential).toContain('-')
  })

  it('carries enough entropy to be worth the KDF', () => {
    // 32 symbols from a 32-character alphabet is 160 bits. Asserted on length
    // because a future edit that shortened it would otherwise be silent.
    const credential = generateRecoveryCredential().replace(/-/g, '')
    expect(credential.length).toBeGreaterThanOrEqual(32)
  })
})

describe('checksums', () => {
  it('is stable for the same content', () => {
    expect(sha256(Buffer.from('abc'))).toEqual(sha256('abc'))
  })

  it('changes for a single altered byte', () => {
    expect(sha256('abc')).not.toEqual(sha256('abd'))
  })
})
