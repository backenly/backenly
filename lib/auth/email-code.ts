/**
 * SIX-DIGIT CODES THAT PROVE SOMEONE CONTROLS AN ADDRESS
 * ======================================================
 * Platform signup created the account, and a session, before anything proved
 * the address belonged to the person typing it. Password reset mailed a signed
 * link nobody ever observed arriving. Both now ask for a short code sent to the
 * address, through this module.
 *
 * What makes a code safe to be short
 * ----------------------------------
 * A six-digit code has a million values, which is nothing offline and plenty
 * online. So the two properties that matter are that it can only be guessed
 * online, and only a few times:
 *
 *   - Only an HMAC of the code is stored, keyed on JWT_SECRET. A leaked row
 *     cannot be turned back into a working code without the server's secret.
 *   - Every guess is counted BEFORE it is compared, in one conditional UPDATE,
 *     so parallel guesses cannot spend more than the budget. Five wrong
 *     guesses and the code is dead.
 *   - A code lives ten minutes and is deleted by the request that uses it.
 *     Two requests racing with the right code produce one success.
 *
 * Throttling who can be mailed, and how often, is the caller's job and keyed on
 * the address before any account lookup (`throttleEmailCodeSend`), so it
 * answers the same whether or not an account exists.
 */
import { createHmac, randomInt, timingSafeEqual } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { AUTH_LIMITS, consume, type RateLimitResult } from '@/lib/security/auth-rate-limit'

export type EmailCodePurpose = 'signup' | 'password_reset'

export const EMAIL_CODE_LENGTH = 6
export const EMAIL_CODE_TTL_MS = 10 * 60_000
export const EMAIL_CODE_MAX_ATTEMPTS = 5

/** Rows this long past expiry are dead weight, removed whenever a code is issued. */
const PURGE_AFTER_MS = 24 * 60 * 60_000

export type EmailCodeFailure = 'invalid' | 'expired' | 'too_many_attempts'

export type VerifyEmailCodeResult =
  | { ok: true; payload: Prisma.JsonValue | null }
  | { ok: false; reason: EmailCodeFailure }

/** One spelling of an address everywhere a code is issued, looked up or checked. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** A presented code with the spaces and dashes people paste, or null if it cannot be one. */
export function normalizeCode(code: string): string | null {
  const digits = String(code ?? '').replace(/[\s-]/g, '')
  return new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(digits) ? digits : null
}

export function generateEmailCode(): string {
  return randomInt(0, 10 ** EMAIL_CODE_LENGTH).toString().padStart(EMAIL_CODE_LENGTH, '0')
}

function codeKey(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not configured')
  return secret
}

/**
 * Bound to the purpose and the address, so a code issued to reset one account
 * cannot be replayed to verify a signup, or against another address.
 */
export function hashEmailCode(purpose: EmailCodePurpose, email: string, code: string): string {
  return createHmac('sha256', codeKey()).update(`${purpose}:${email}:${code}`).digest('hex')
}

function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/**
 * May a code be mailed to this address right now?
 *
 * One per minute, five an hour, per purpose. Keyed on the address alone and
 * asked before the caller looks anything up, so an address with no account is
 * throttled exactly like one with an account and the answer reveals nothing.
 */
export async function throttleEmailCodeSend(purpose: EmailCodePurpose, email: string): Promise<RateLimitResult> {
  const { cooldown, email: hourly } = AUTH_LIMITS.emailCode.send
  const soon = await consume(`email-code:${purpose}:cooldown:${email}`, cooldown.limit, cooldown.windowMs)
  if (!soon.allowed) return soon
  return consume(`email-code:${purpose}:hour:${email}`, hourly.limit, hourly.windowMs)
}

/**
 * Issue a fresh code, replacing any earlier one for this purpose and address.
 *
 * `payload` replaces the stored payload when given. A resend passes none, so a
 * pending signup keeps what it was started with; nothing a resend carries can
 * change the account that is eventually created.
 */
export async function issueEmailCode(
  purpose: EmailCodePurpose,
  email: string,
  payload?: Prisma.InputJsonValue,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateEmailCode()
  const codeHash = hashEmailCode(purpose, email, code)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS)

  await prisma.authEmailCode.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - PURGE_AFTER_MS) } },
  })

  await prisma.authEmailCode.upsert({
    where: { purpose_email: { purpose, email } },
    create: { purpose, email, codeHash, expiresAt, lastSentAt: now, ...(payload !== undefined ? { payload } : {}) },
    update: {
      codeHash,
      expiresAt,
      attempts: 0,
      lastSentAt: now,
      sendCount: { increment: 1 },
      ...(payload !== undefined ? { payload } : {}),
    },
  })

  return { code, expiresAt }
}

/**
 * Re-issue the code for a pending entry, keeping its payload.
 *
 * Returns null when there is nothing pending, and the caller answers exactly
 * as it would have otherwise: whether a pending entry exists is itself
 * something the response must not reveal.
 */
export async function reissueEmailCode(
  purpose: EmailCodePurpose,
  email: string,
): Promise<{ code: string; expiresAt: Date } | null> {
  const pending = await prisma.authEmailCode.findUnique({
    where: { purpose_email: { purpose, email } },
    select: { id: true },
  })
  if (!pending) return null
  return issueEmailCode(purpose, email)
}

/**
 * Check a presented code and, if it is right, consume it.
 *
 * The reason is for logs and tests. Routes answer every failure with one
 * message, because "expired" and "too many attempts" can only happen where a
 * code was issued, and which addresses have one is not public.
 */
export async function verifyEmailCode(
  purpose: EmailCodePurpose,
  email: string,
  presented: string,
): Promise<VerifyEmailCodeResult> {
  const code = normalizeCode(presented)
  if (!code) return { ok: false, reason: 'invalid' }

  const row = await prisma.authEmailCode.findUnique({
    where: { purpose_email: { purpose, email } },
  })
  if (!row) return { ok: false, reason: 'invalid' }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  // Spend the attempt before comparing. Conditional on the budget AND on the
  // code still being the one read above, so parallel guesses cannot exceed
  // five, and a guess cannot land against a code that was replaced meanwhile.
  const counted = await prisma.authEmailCode.updateMany({
    where: { id: row.id, codeHash: row.codeHash, attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  })
  if (counted.count === 0) return { ok: false, reason: 'too_many_attempts' }

  if (!hexEquals(hashEmailCode(purpose, email, code), row.codeHash)) {
    return { ok: false, reason: row.attempts + 1 >= EMAIL_CODE_MAX_ATTEMPTS ? 'too_many_attempts' : 'invalid' }
  }

  // Single use. Of two requests racing with the right code, one deletes the
  // row and the other deletes nothing.
  const consumed = await prisma.authEmailCode.deleteMany({
    where: { id: row.id, codeHash: row.codeHash },
  })
  if (consumed.count !== 1) return { ok: false, reason: 'invalid' }

  return { ok: true, payload: row.payload }
}

/** What every route answers for any failed code, whatever the reason. */
export const EMAIL_CODE_REJECTED_MESSAGE =
  'That code is incorrect or has expired. Check the latest email, or request a new code.'
