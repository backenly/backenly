/**
 * Per-project env-var encryption.
 *
 * AES-256-GCM. Key derived from the master secret in `ENV_VAR_ENCRYPTION_KEY`
 * (preferred) or `JWT_SECRET` (fallback) via HKDF, so the same key file can't
 * be used to decrypt env vars from a different role. IV is random per-write.
 *
 * Ciphertext, IV, and auth tag are stored separately on the row so we can
 * rotate the master key by re-encrypting in place without changing the schema.
 */

import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits
const IV_LENGTH = 12 // GCM standard
const TAG_LENGTH = 16

let cachedKey: Buffer | null = null

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!raw) {
    throw new Error(
      'projectEnvCrypto: neither ENV_VAR_ENCRYPTION_KEY nor JWT_SECRET is set. Cannot encrypt project env vars.',
    )
  }
  // HKDF-SHA256 → derive an AES-256 key from whatever secret the env provides.
  // hkdfSync returns an ArrayBuffer in modern Node — wrap into a Buffer for the
  // cipher APIs.
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(raw, 'utf8'),
    Buffer.alloc(0),
    'backenly/project-env-var/v1',
    KEY_LENGTH,
  )
  cachedKey = Buffer.from(derived as ArrayBuffer)
  return cachedKey
}

export interface EncryptedValue {
  valueCipher: string // base64
  valueIv: string // base64
  valueTag: string // base64
}

export function encryptValue(plaintext: string): EncryptedValue {
  if (typeof plaintext !== 'string') {
    throw new Error('projectEnvCrypto.encryptValue: plaintext must be a string')
  }
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, getMasterKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    valueCipher: encrypted.toString('base64'),
    valueIv: iv.toString('base64'),
    valueTag: tag.toString('base64'),
  }
}

export function decryptValue(row: EncryptedValue): string {
  const cipher = Buffer.from(row.valueCipher, 'base64')
  const iv = Buffer.from(row.valueIv, 'base64')
  const tag = Buffer.from(row.valueTag, 'base64')
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('projectEnvCrypto.decryptValue: malformed IV or auth tag')
  }
  const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(cipher), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Surface-safe preview of a value — first 4 chars + ellipsis. Used by REST/UI
 * to confirm something is set without sending the secret back over the wire.
 */
export function previewValue(plaintext: string): string {
  if (plaintext.length <= 4) return '••••'
  return `${plaintext.slice(0, 4)}••••••••`
}
