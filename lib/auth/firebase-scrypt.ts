/**
 * Firebase Authentication password hashes, verified by Backenly.
 *
 * A Firebase project moved into Backenly (lib/import/drivers/firebase.ts)
 * brings its users' password hashes, because the passwords themselves were
 * never known to anyone. Firebase hashes with its own variant of scrypt
 * (github.com/firebase/scrypt):
 *
 *   key  = scrypt(password, salt ‖ saltSeparator, N = 2^memoryCost, r = rounds, p = 1, 32 bytes)
 *   hash = AES-256-CTR(key, iv = 16 zero bytes, plaintext = signerKey)
 *
 * `signerKey`, `saltSeparator`, `rounds` and `memoryCost` belong to the Firebase
 * project; `salt` and `hash` to each user. All of it is stored in the user's
 * own password column, behind an explicit scheme marker, so a stored value
 * says how it is checked and nothing else is consulted:
 *
 *   $firebase-scrypt$v=1$mem=14,rounds=8$<saltSeparator>$<signerKey>$<salt>$<hash>
 *
 * (standard base64, padded; `$` never occurs in base64). Sign-in checks such a
 * value once, then replaces it with Backenly's own bcrypt
 * (lib/auth/end-user-password.ts). Nothing writes one except the importer.
 *
 * Only Firebase's own parameter ranges are accepted (rounds 1–8, memoryCost
 * 1–14: at most 16 MiB of scrypt memory per check), so a stored value cannot
 * ask a sign-in for more work than Firebase itself does. Checks run a few at a
 * time, like bcrypt in lib/auth/password.ts.
 */

import { createCipheriv, scrypt, timingSafeEqual } from 'crypto'

export const FIREBASE_SCRYPT_PREFIX = '$firebase-scrypt$'
const VERSION = 'v=1'

/** A Firebase project's password hash parameters (Authentication → Users → Password hash parameters). */
export interface FirebaseHashParams {
  /** base64 */
  signerKey: string
  /** base64; may be empty */
  saltSeparator: string
  rounds: number
  memoryCost: number
}

/** One user's half: Firebase's `salt` and `passwordHash`, base64 (standard or URL-safe). */
export interface FirebaseUserPassword {
  salt: string
  passwordHash: string
}

interface ParsedHash {
  rounds: number
  memoryCost: number
  saltSeparator: Buffer
  signerKey: Buffer
  salt: Buffer
  hash: Buffer
}

const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/

/** base64 or base64url → bytes, or null when it is not base64 at all. */
function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!B64.test(s)) return null
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function validParams(rounds: unknown, memoryCost: unknown): boolean {
  return (
    Number.isInteger(rounds) && (rounds as number) >= 1 && (rounds as number) <= 8 &&
    Number.isInteger(memoryCost) && (memoryCost as number) >= 1 && (memoryCost as number) <= 14
  )
}

/** Why a project's parameters cannot be used, in plain words, or null when they can. */
export function firebaseParamsProblem(params: Partial<FirebaseHashParams> | null | undefined): string | null {
  if (!params) return 'Firebase did not return the password hash parameters.'
  const signer = decodeBase64(params.signerKey)
  if (!signer || signer.length === 0) return 'The password hash parameters have no signer key.'
  if (params.saltSeparator !== undefined && params.saltSeparator !== '' && !decodeBase64(params.saltSeparator)) {
    return 'The salt separator in the password hash parameters is not base64.'
  }
  if (!validParams(params.rounds, params.memoryCost)) {
    return `The password hash parameters (rounds ${params.rounds}, memory cost ${params.memoryCost}) are outside Firebase's own range.`
  }
  return null
}

/**
 * The stored form of one Firebase user's password, or null when the user's
 * half is missing or not base64 (no password is stored then; the user resets it).
 */
export function encodeFirebaseHash(params: FirebaseHashParams, user: FirebaseUserPassword): string | null {
  if (firebaseParamsProblem(params)) return null
  const signer = decodeBase64(params.signerKey)!
  const separator = decodeBase64(params.saltSeparator ?? '') ?? Buffer.alloc(0)
  const salt = decodeBase64(user.salt)
  const hash = decodeBase64(user.passwordHash)
  if (!salt || !hash || hash.length === 0) return null
  // AES-CTR output is exactly as long as its plaintext, the signer key.
  if (hash.length !== signer.length) return null
  return [
    '',
    'firebase-scrypt',
    VERSION,
    `mem=${params.memoryCost},rounds=${params.rounds}`,
    separator.toString('base64'),
    signer.toString('base64'),
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$')
}

/** True when a stored password value is a Firebase hash this module checks. */
export function isFirebaseHash(stored: unknown): stored is string {
  return typeof stored === 'string' && stored.startsWith(FIREBASE_SCRYPT_PREFIX)
}

/** The parts of a stored Firebase hash, or null when it is not one this version reads. */
export function parseFirebaseHash(stored: string): ParsedHash | null {
  if (!isFirebaseHash(stored)) return null
  const parts = stored.split('$')
  if (parts.length !== 8 || parts[2] !== VERSION) return null
  const m = /^mem=(\d{1,2}),rounds=(\d{1,2})$/.exec(parts[3])
  if (!m) return null
  const memoryCost = Number(m[1])
  const rounds = Number(m[2])
  if (!validParams(rounds, memoryCost)) return null
  const saltSeparator = decodeBase64(parts[4])
  const signerKey = decodeBase64(parts[5])
  const salt = decodeBase64(parts[6])
  const hash = decodeBase64(parts[7])
  if (!saltSeparator || !signerKey || !salt || !hash) return null
  if (signerKey.length === 0 || hash.length !== signerKey.length) return null
  return { rounds, memoryCost, saltSeparator, signerKey, salt, hash }
}

// ── The work, a few at a time ──────────────────────────────────────────────────

/** Each check holds up to 16 MiB; the same small number at once as bcrypt (lib/auth/password.ts). */
const SLOTS = Math.max(1, Math.floor(Number(process.env.PASSWORD_HASH_CONCURRENCY)) || 2)
let running = 0
const waiting: Array<() => void> = []

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= SLOTS) await new Promise<void>((resolve) => waiting.push(resolve))
  else running++
  try {
    return await work()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

function deriveKey(password: string, salt: Buffer, separator: Buffer, rounds: number, memoryCost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      Buffer.concat([salt, separator]),
      32,
      { N: 2 ** memoryCost, r: rounds, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

/** Firebase's hash of `password` under a project's parameters and one user's salt (base64). */
export async function firebaseScryptHash(password: string, params: FirebaseHashParams, salt: string): Promise<Buffer> {
  const problem = firebaseParamsProblem(params)
  if (problem) throw new Error(problem)
  const saltBytes = decodeBase64(salt)
  if (!saltBytes) throw new Error('The salt is not base64.')
  const separator = decodeBase64(params.saltSeparator ?? '') ?? Buffer.alloc(0)
  return inSlot(async () => {
    const key = await deriveKey(password, saltBytes, separator, params.rounds, params.memoryCost)
    return encryptSigner(key, decodeBase64(params.signerKey)!)
  })
}

function encryptSigner(key: Buffer, signerKey: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16, 0))
  return Buffer.concat([cipher.update(signerKey), cipher.final()])
}

/**
 * Whether `password` is the one a stored Firebase hash was made from. False for
 * a value this module cannot read; never throws for a wrong password.
 */
export async function verifyFirebaseHash(password: string, stored: string): Promise<boolean> {
  const parsed = parseFirebaseHash(stored)
  if (!parsed) return false
  const computed = await inSlot(async () => {
    const key = await deriveKey(password, parsed.salt, parsed.saltSeparator, parsed.rounds, parsed.memoryCost)
    return encryptSigner(key, parsed.signerKey)
  })
  return computed.length === parsed.hash.length && timingSafeEqual(computed, parsed.hash)
}
