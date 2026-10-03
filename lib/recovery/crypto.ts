/**
 * THE RECOVERY CREDENTIAL, AND WHY IT IS NOT DERIVED FROM THE SERVER'S KEYS
 * ========================================================================
 *
 * Everything else in this repository that encrypts at rest derives its key from
 * server-side environment (`lib/security/projectEnvCrypto.ts` uses
 * `ENV_VAR_ENCRYPTION_KEY` or `JWT_SECRET` through HKDF). That is right for
 * data the running server reads back.
 *
 * It is exactly wrong here. A deployment recovery bundle exists to be restored
 * onto a CLEAN MACHINE, on the day the original machine is gone. If the
 * bundle's encryption keyed off that machine's env, the bundle would be
 * readable only by the deployment that no longer exists.
 *
 * So the wrapping key comes from an operator-held recovery credential instead:
 * a high-entropy string generated at export time, shown once, and stored by the
 * operator somewhere other than beside the bundle. That gives a boundary an
 * operator can actually reason about:
 *
 *   bundle alone                    → discloses nothing sensitive
 *   bundle + recovery credential    → full restore
 *   recovery credential alone       → useless
 *
 * TWO LAYERS, ON PURPOSE
 * ----------------------
 * Components are encrypted under a random per-bundle DATA KEY, and only that
 * data key is wrapped by the credential. One indirection buys two things: large
 * components never pass through the slow KDF, and the credential can be changed
 * later by re-wrapping 32 bytes instead of re-encrypting the archive.
 *
 * THE KDF PARAMETERS ARE RECORDED, NOT ASSUMED
 * --------------------------------------------
 * scrypt cost is written into the manifest by the writer and read back by the
 * reader. Raising it later stays backward compatible, because an old bundle
 * still says what it was written with. A reader that assumed today's constants
 * would silently fail to open last year's bundle, and it would look
 * indistinguishable from a wrong credential.
 */

import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const TAG_LENGTH = 16
const SALT_LENGTH = 16

/**
 * scrypt cost for turning the recovery credential into a wrapping key.
 *
 * N=65536, r=8 is roughly 64 MB and well under a second: this runs once per
 * export and once per restore, so the cost lands on an attacker doing it
 * offline a great many times rather than on the operator.
 *
 * Node's default maxmem is 32 MB, which these parameters exceed, so it is
 * raised explicitly. Without that, scrypt throws and the failure reads like a
 * corrupt bundle.
 */
export const KDF_PARAMS = { N: 65536, r: 8, p: 1 } as const
const MAXMEM = 128 * 1024 * 1024

export interface KdfParams {
  N: number
  r: number
  p: number
}

export interface WrappedDataKey {
  algorithm: 'aes-256-gcm'
  kdf: 'scrypt'
  kdfParams: KdfParams
  salt: string
  iv: string
  authTag: string
  ciphertext: string
}

export interface EncryptedBlob {
  iv: string
  authTag: string
  ciphertext: string
}

/**
 * Wrong credential and corrupt archive are DIFFERENT failures.
 *
 * They are indistinguishable at the cipher level - both surface as a failed GCM
 * auth tag - but they need opposite responses from the operator: find the other
 * passphrase, versus go and get another copy of the bundle. Conflating them
 * sends people looking in the wrong place on the worst day they have had.
 */
export class RecoveryKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryKeyError'
  }
}

export class RecoveryIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryIntegrityError'
  }
}

/**
 * The credential handed to the operator at export time.
 *
 * Generated rather than chosen. A passphrase an operator invents under pressure
 * is the weakest part of this design, and it is the one part that no amount of
 * KDF cost can repair. 32 bytes of base32 is ~160 bits and survives being read
 * aloud, retyped, or written on paper - which is what actually happens to a
 * recovery credential.
 */
export function generateRecoveryCredential(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1
  const bytes = crypto.randomBytes(32)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 8 === 0) out += '-'
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

/** A fresh random key for one bundle. Never reused across bundles. */
export function generateDataKey(): Buffer {
  return crypto.randomBytes(KEY_LENGTH)
}

function deriveWrappingKey(credential: string, salt: Buffer, params: KdfParams): Buffer {
  if (!credential || credential.trim().length === 0) {
    throw new RecoveryKeyError('A recovery credential is required; refusing to encrypt with an empty one.')
  }
  return crypto.scryptSync(credential.normalize('NFKC'), salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM,
  })
}

/** Wrap the per-bundle data key under the operator's recovery credential. */
export function wrapDataKey(dataKey: Buffer, credential: string): WrappedDataKey {
  if (dataKey.length !== KEY_LENGTH) {
    throw new RecoveryKeyError(`Data key must be ${KEY_LENGTH} bytes; got ${dataKey.length}.`)
  }
  const salt = crypto.randomBytes(SALT_LENGTH)
  const iv = crypto.randomBytes(IV_LENGTH)
  const wrappingKey = deriveWrappingKey(credential, salt, KDF_PARAMS)

  const cipher = crypto.createCipheriv(ALGO, wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])

  return {
    algorithm: ALGO,
    kdf: 'scrypt',
    kdfParams: { ...KDF_PARAMS },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/**
 * Recover the data key. Throws RecoveryKeyError when the credential is wrong.
 *
 * The parameters come from the bundle, not from KDF_PARAMS, so a bundle written
 * before the cost was raised still opens.
 */
export function unwrapDataKey(wrapped: WrappedDataKey, credential: string): Buffer {
  const salt = Buffer.from(wrapped.salt, 'base64')
  const iv = Buffer.from(wrapped.iv, 'base64')
  const authTag = Buffer.from(wrapped.authTag, 'base64')

  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new RecoveryIntegrityError(
      'The wrapped data key in this manifest is malformed. The bundle is damaged, not the credential.',
    )
  }

  const params = wrapped.kdfParams ?? KDF_PARAMS
  const wrappingKey = deriveWrappingKey(credential, salt, params)
  const decipher = crypto.createDecipheriv(ALGO, wrappingKey, iv)
  decipher.setAuthTag(authTag)

  try {
    const dataKey = Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final(),
    ])
    if (dataKey.length !== KEY_LENGTH) {
      throw new RecoveryIntegrityError('Unwrapped data key has the wrong length.')
    }
    return dataKey
  } catch (err) {
    if (err instanceof RecoveryIntegrityError) throw err
    // GCM cannot tell us which of the two it was, so the message says so rather
    // than guessing and sending the operator down one path.
    throw new RecoveryKeyError(
      'Could not unwrap the bundle key. Either the recovery credential is wrong, ' +
      'or the manifest has been altered since the bundle was written.',
    )
  }
}

/** Encrypt one component under the per-bundle data key. */
export function encryptBlob(plaintext: Buffer, dataKey: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, dataKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/** Decrypt one component. A tampered blob throws rather than returning garbage. */
export function decryptBlob(blob: EncryptedBlob, dataKey: Buffer): Buffer {
  const iv = Buffer.from(blob.iv, 'base64')
  const authTag = Buffer.from(blob.authTag, 'base64')
  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new RecoveryIntegrityError('Encrypted component has a malformed IV or auth tag.')
  }
  const decipher = crypto.createDecipheriv(ALGO, dataKey, iv)
  decipher.setAuthTag(authTag)
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, 'base64')),
      decipher.final(),
    ])
  } catch {
    throw new RecoveryIntegrityError(
      'An encrypted component failed its integrity check. The bundle has been altered or truncated.',
    )
  }
}

/** Checksum used for every component entry in the manifest. */
export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * COMPONENT FILES ARE SEALED AS BINARY, NOT AS JSON
 * =================================================
 * `encryptBlob` above returns base64 in a small object, which is right for a
 * handful of fields. A platform dump is not a handful of fields: base64 would
 * add a third to every byte and force the whole archive through a JSON string.
 *
 * So a sealed component file is laid out as
 *
 *   [ 12-byte IV ][ 16-byte GCM tag ][ ciphertext ]
 *
 * TWO INTEGRITY CHECKS, DOING DIFFERENT JOBS
 * ------------------------------------------
 * The manifest records a SHA-256 of the file exactly as written - that is, of
 * the sealed bytes. It can therefore be verified BEFORE anyone fetches the
 * recovery credential, which is what lets `validate-checksums` run as a
 * validation step rather than a decryption step.
 *
 * The GCM tag is the second check and answers a different question: not "did
 * this file arrive intact" but "was this file produced by someone holding the
 * key". Corruption is caught by the first; substitution is caught by the
 * second. A design with only the checksum would accept a re-encrypted file.
 */

const SEAL_HEADER = IV_LENGTH + TAG_LENGTH

/** Seal a component for writing to disk. */
export function sealBuffer(plaintext: Buffer, dataKey: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, dataKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

/** Open a sealed component. Throws rather than returning partial plaintext. */
export function openBuffer(sealed: Buffer, dataKey: Buffer): Buffer {
  if (sealed.length < SEAL_HEADER) {
    throw new RecoveryIntegrityError(
      `Sealed component is ${sealed.length} bytes, shorter than its own header. It is truncated.`,
    )
  }
  const iv = sealed.subarray(0, IV_LENGTH)
  const tag = sealed.subarray(IV_LENGTH, SEAL_HEADER)
  const decipher = crypto.createDecipheriv(ALGO, dataKey, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(sealed.subarray(SEAL_HEADER)), decipher.final()])
  } catch {
    throw new RecoveryIntegrityError(
      'A sealed component failed its authentication check. It was altered, truncated, ' +
      'or produced by a different bundle key.',
    )
  }
}
