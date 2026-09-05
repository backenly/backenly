/**
 * ADMIN STEP-UP AUTH ("sudo mode")
 * ================================
 * The second factor on every destructive admin endpoint (#116). The rule is
 * unchanged from the original design — *a stolen founder JWT must not be
 * enough to flip a kill switch* — but the mechanism is one a browser can
 * actually satisfy.
 *
 * Why this replaces the HMAC-only gate:
 *   `requireAdminSignature` asks the caller to sign with ADMIN_SIGNING_SECRET.
 *   That works for a script run by a human who holds the secret. It cannot
 *   work for the admin dashboard, because shipping the secret to the browser
 *   would publish it — so the entire admin write surface (kill switches,
 *   blocklist, lockdown, force-logout, suspend, credits) was unreachable from
 *   the UI it was built for. Every mutation 401'd.
 *
 * How step-up works instead:
 *   1. The founder proves possession of something the JWT thief does not have
 *      — their password or their TOTP code — at POST /api/admin/reauth.
 *   2. The server mints a short-lived, httpOnly, userId-bound sudo token and
 *      sets it as a cookie. TTL is 15 minutes.
 *   3. Mutating admin routes accept that cookie as the second factor.
 *
 * The threat model holds: an attacker with only the session cookie/JWT can
 * read the admin dashboard, but cannot mint a sudo token without the password
 * or TOTP, and therefore cannot write.
 *
 * The HMAC path is deliberately KEPT for non-browser callers (scripts, ops
 * runbooks) — see `requireAdminStepUp`, which accepts either factor.
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireAdminSignature } from './adminSigning'

export const ADMIN_SUDO_COOKIE = 'admin-sudo'
export const ADMIN_SUDO_TTL_SEC = 15 * 60
const TOKEN_VERSION = 'v1'

/**
 * Signing key for the sudo token. Prefers ADMIN_SIGNING_SECRET so the admin
 * surface keeps its own key; falls back to JWT_SECRET so a deployment that
 * never set the admin secret still gets a working (and still bound) token
 * rather than silently losing the second factor.
 */
function stepUpSecret(): string | null {
  return process.env.ADMIN_SIGNING_SECRET || process.env.JWT_SECRET || null
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/**
 * Mint a sudo token bound to one user id and one expiry.
 * Format: v1.<userId>.<expUnixSeconds>.<hmac>
 */
export function mintAdminSudoToken(
  userId: string,
  ttlSec: number = ADMIN_SUDO_TTL_SEC,
): { token: string; expiresAt: Date } | null {
  const secret = stepUpSecret()
  if (!secret) return null

  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = `${TOKEN_VERSION}.${userId}.${exp}`
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt: new Date(exp * 1000) }
}

/**
 * Verify a sudo token is well-formed, unexpired, and issued for THIS user.
 * The userId binding is what stops a sudo token minted for one admin from
 * authorising a different admin's session.
 */
export function verifyAdminSudoToken(token: string | null | undefined, userId: string): boolean {
  if (!token) return false
  const secret = stepUpSecret()
  if (!secret) return false

  const parts = token.split('.')
  if (parts.length !== 4) return false
  const [version, tokenUserId, expRaw, signature] = parts
  if (version !== TOKEN_VERSION) return false
  if (tokenUserId !== userId) return false

  const exp = Number.parseInt(expRaw, 10)
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false

  return timingSafeEqualHex(signature, sign(`${version}.${tokenUserId}.${expRaw}`, secret))
}

/** Attach a freshly minted sudo token to a response. */
export function setAdminSudoCookie(response: NextResponse, token: string, ttlSec: number = ADMIN_SUDO_TTL_SEC): void {
  response.cookies.set(ADMIN_SUDO_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    // Strict, not lax: no cross-site navigation should ever carry the factor
    // that authorises a destructive write.
    sameSite: 'strict',
    maxAge: ttlSec,
    path: '/',
  })
}

/** Drop sudo — used by the explicit "lock again" action and on re-auth failure. */
export function clearAdminSudoCookie(response: NextResponse): void {
  response.cookies.set(ADMIN_SUDO_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  })
}

/** Is this request already in sudo mode? */
export function hasAdminSudo(request: NextRequest, userId: string): boolean {
  return verifyAdminSudoToken(request.cookies.get(ADMIN_SUDO_COOKIE)?.value, userId)
}

/**
 * The gate itself. Returns null when the request carries a valid second
 * factor, otherwise the response the route should return.
 *
 * Two accepted factors, checked cheapest-first:
 *   1. sudo cookie  — the browser path (founder re-authed in the last 15 min)
 *   2. HMAC headers — the script path (caller holds ADMIN_SIGNING_SECRET)
 *
 * The HMAC branch only runs when the caller actually sent the headers, so a
 * browser request never pays for it and never gets the HMAC's error message
 * (which would be a dead end for a user who has no secret to sign with).
 */
export async function requireAdminStepUp(
  request: NextRequest,
  userId: string,
): Promise<NextResponse | null> {
  if (hasAdminSudo(request, userId)) return null

  const signed = request.headers.get('x-admin-signature') && request.headers.get('x-admin-timestamp')
  if (signed) return await requireAdminSignature(request)

  return NextResponse.json(
    {
      error: 'Confirm your identity to make admin changes.',
      code: 'SUDO_REQUIRED',
      reauthPath: '/api/admin/reauth',
    },
    { status: 401 },
  )
}
