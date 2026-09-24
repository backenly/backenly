import { prisma } from '@/lib/db/postgres'
import type { NextResponse } from 'next/server'
import { generateToken, verifyToken, JWTPayload } from './jwt'
import crypto from 'crypto'

const SESSION_EXPIRY_DAYS = 7
const REFRESH_TOKEN_EXPIRY_DAYS = 30

// Session cache to reduce DB hits (60 second TTL)
interface CachedSession {
  valid: boolean
  userId?: string
  email?: string
  role?: string
  expiresAt: number
}

const sessionCache = new Map<string, CachedSession>()

// Clean expired cache entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [token, data] of Array.from(sessionCache.entries())) {
      if (data.expiresAt < now) {
        sessionCache.delete(token)
      }
    }
  }, 5 * 60 * 1000)
}

/**
 * Create a new session for a user, returning both an access token and a refresh token (#67).
 */
export async function createSession(
  userId: string,
  email: string,
  role?: string,
  name?: string,
  provider?: string
): Promise<{ token: string; sessionId: string; refreshToken: string }> {
  const payload: JWTPayload = { userId, email, role, name, provider }
  const token = generateToken(payload)

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRY_DAYS)

  // Generate a cryptographically secure refresh token
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshTokenExpiresAt = new Date()
  refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

  const session = await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    },
  })

  return { token, sessionId: session.id, refreshToken }
}

/**
 * Verify a session token
 */
export async function verifySession(token: string): Promise<{ valid: boolean; userId?: string; email?: string; role?: string }> {
  // Check cache first (60s TTL)
  const now = Date.now()
  const cached = sessionCache.get(token)
  if (cached && cached.expiresAt > now) {
    return {
      valid: cached.valid,
      userId: cached.userId,
      email: cached.email,
      role: cached.role,
    }
  }

  const payload = verifyToken(token)
  if (!payload) {
    sessionCache.set(token, { valid: false, expiresAt: now + 10000 })
    return { valid: false }
  }

  const session = await prisma.session.findUnique({ where: { token } })

  if (!session || session.expiresAt < new Date()) {
    sessionCache.set(token, { valid: false, expiresAt: now + 10000 })
    return { valid: false }
  }

  const result = {
    valid: true,
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
  }

  // Cache valid session for 15 seconds (short TTL so revoked sessions expire quickly)
  sessionCache.set(token, { ...result, expiresAt: now + 15000 })

  return result
}

/**
 * Exchange a refresh token for a new access token (#67).
 * Returns the new access token and a rotated refresh token.
 * Throws if the refresh token is invalid or expired.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  token: string
  refreshToken: string
  expiresAt: Date
}> {
  const session = await prisma.session.findUnique({ where: { refreshToken } })

  if (!session) {
    throw new Error('INVALID_REFRESH_TOKEN')
  }

  if (!session.refreshTokenExpiresAt || session.refreshTokenExpiresAt < new Date()) {
    // Clean up expired session
    await prisma.session.delete({ where: { id: session.id } })
    throw new Error('REFRESH_TOKEN_EXPIRED')
  }

  // Load user to build a fresh JWT payload
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { role: true },
    // Ensure user isn't deleted or suspended
  })

  if (!user || user.deletedAt || user.suspendedAt) {
    await prisma.session.delete({ where: { id: session.id } })
    throw new Error('USER_UNAVAILABLE')
  }

  // Issue new access token
  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    role: user.role?.name,
    name: user.name || undefined,
  }
  const newToken = generateToken(payload)
  const newExpiresAt = new Date()
  newExpiresAt.setDate(newExpiresAt.getDate() + SESSION_EXPIRY_DAYS)

  // Rotate refresh token (each refresh token is single-use)
  const newRefreshToken = crypto.randomBytes(48).toString('hex')
  const newRefreshTokenExpiresAt = new Date()
  newRefreshTokenExpiresAt.setDate(newRefreshTokenExpiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

  // Evict old access token from cache
  sessionCache.delete(session.token)

  await prisma.session.update({
    where: { id: session.id },
    data: {
      token: newToken,
      expiresAt: newExpiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: newRefreshTokenExpiresAt,
    },
  })

  return { token: newToken, refreshToken: newRefreshToken, expiresAt: newExpiresAt }
}

/**
 * End the sessions a browser presents: its access tokens (cookie and Bearer)
 * and its refresh token. Returns how many sessions ended.
 *
 * Needs no live session. The refresh token outlives the access token by weeks,
 * so a browser whose access session has expired still holds a credential that
 * signs it back in, and refusing to act until it proves a live session left
 * exactly that credential working. Possession is the authority instead: every
 * value is a secret matched exactly, so a caller can only end sessions whose
 * credentials it already holds.
 */
export async function revokePresentedSessions(presented: {
  accessTokens: string[]
  refreshToken?: string | null
}): Promise<number> {
  const match = [
    ...(presented.accessTokens.length > 0 ? [{ token: { in: presented.accessTokens } }] : []),
    ...(presented.refreshToken ? [{ refreshToken: presented.refreshToken }] : []),
  ]
  for (const token of presented.accessTokens) sessionCache.delete(token)
  if (match.length === 0) return 0

  const sessions = await prisma.session.findMany({ where: { OR: match }, select: { id: true, token: true } })
  // A session found by its refresh token may carry an access token this
  // browser no longer holds; it must stop verifying too.
  for (const session of sessions) sessionCache.delete(session.token)
  if (sessions.length === 0) return 0

  const { count } = await prisma.session.deleteMany({ where: { id: { in: sessions.map((s) => s.id) } } })
  return count
}

/**
 * Delete all sessions for a user
 */
export async function deleteAllUserSessions(userId: string): Promise<void> {
  // Evict first, so this process stops honouring them now rather than when
  // the 15-second verification cache expires.
  const sessions = await prisma.session.findMany({ where: { userId }, select: { token: true } })
  for (const session of sessions) sessionCache.delete(session.token)
  await prisma.session.deleteMany({ where: { userId } })
}

/**
 * Clear the two cookies that carry a platform session in the browser. The
 * server-side session must be ended separately; this is the browser's copy.
 */
export function clearSessionCookies<T extends NextResponse>(response: T): T {
  response.cookies.delete('auth-token')
  response.cookies.delete('refresh-token')
  return response
}

/**
 * Clean up expired sessions
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return result.count
}
