/**
 * TOTP (Time-based One-Time Password) — RFC 6238
 *
 * Pure Node.js implementation using built-in `crypto` — no external TOTP library required.
 * Compatible with Google Authenticator, Authy, 1Password, and any RFC 6238 app.
 */

import crypto from 'crypto'

const TOTP_DIGITS = 6
const TOTP_STEP = 30      // seconds per window
const TOTP_WINDOW = 1     // accept 1 window before/after current (±30s clock drift)
const ISSUER = 'Backenly'

/**
 * Generate a new TOTP secret (base32-encoded, 20 bytes = 160 bits).
 */
export function generateTOTPSecret(): string {
  const bytes = crypto.randomBytes(20)
  return base32Encode(bytes)
}

/**
 * Build an otpauth:// URI for QR code generation.
 */
export function buildTOTPUri(secret: string, email: string): string {
  const encodedIssuer = encodeURIComponent(ISSUER)
  const encodedAccount = encodeURIComponent(`${ISSUER}:${email}`)
  return `otpauth://totp/${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`
}

/**
 * Verify a TOTP code against a secret.
 * Accepts codes from ±TOTP_WINDOW windows to handle clock drift.
 */
export function verifyTOTP(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false

  const secretBytes = base32Decode(secret)
  const now = Math.floor(Date.now() / 1000)
  const counter = Math.floor(now / TOTP_STEP)

  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const expected = computeHOTP(secretBytes, counter + delta)
    if (expected === code) return true
  }

  return false
}

/**
 * Generate a TOTP code for the current window (useful for testing).
 */
export function generateTOTP(secret: string): string {
  const secretBytes = base32Decode(secret)
  const counter = Math.floor(Date.now() / (TOTP_STEP * 1000))
  return computeHOTP(secretBytes, counter)
}

// ── HOTP computation (RFC 4226) ───────────────────────────────────────────────

function computeHOTP(secretBytes: Buffer, counter: number): string {
  // Pack counter as big-endian 8-byte buffer
  const counterBuf = Buffer.alloc(8)
  const hi = Math.floor(counter / 0x100000000)
  const lo = counter >>> 0
  counterBuf.writeUInt32BE(hi, 0)
  counterBuf.writeUInt32BE(lo, 4)

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', secretBytes)
  hmac.update(counterBuf)
  const digest = hmac.digest()

  // Dynamic truncation
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)

  const otp = binary % Math.pow(10, TOTP_DIGITS)
  return otp.toString().padStart(TOTP_DIGITS, '0')
}

// ── Base32 encoding / decoding ────────────────────────────────────────────────

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(buf: Buffer): string {
  let result = ''
  let bits = 0
  let value = 0

  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += BASE32_CHARS[(value >>> bits) & 0x1f]
    }
  }

  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 0x1f]
  }

  // Pad to multiple of 8 (RFC 4648 §6 — can be omitted for URI use but we include it)
  while (result.length % 8 !== 0) result += '='

  return result
}

function base32Decode(encoded: string): Buffer {
  // Strip padding and uppercase
  const input = encoded.toUpperCase().replace(/=+$/, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0

  for (const char of input) {
    const idx = BASE32_CHARS.indexOf(char)
    if (idx === -1) continue // skip invalid characters (spaces, lowercase, etc.)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }

  return Buffer.from(bytes)
}
