/**
 * Express-native v1 API authentication + rate-limiting middleware.
 * Mirrors the logic of lib/api/v1/middleware.ts without any next/server dependency.
 *
 * Rate limiting strategy:
 *   Hard limit  — returns HTTP 429 when requestCount >= rateLimit.
 *                 Uses an atomic conditional UPDATE so concurrent requests
 *                 cannot race past the limit.
 *   Soft signal — adds X-RateLimit-* headers on every successful response so
 *                 clients can back off gracefully before hitting the hard wall.
 */

import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/auth/password'
import { sendError, ErrorCodes } from './response'
import { classifyKeyFailure, type ApiKeyFailureDiagnostic } from '@/lib/middleware/apiKeyFailureDiagnostic'
import { recordSecurityEvent } from '@/lib/platform/controls'
import { isInternalOrigin } from '@/lib/security/internal-origin'
import {
  detectBrowserOrigin,
  recordServiceRoleBrowserBlock,
  serviceRoleRefusalMessage,
} from '@/lib/security/service-role-exposure'

export interface V1ApiContext {
  projectId: string
  apiKey: {
    id: string
    userId: string
    permissions: string[]
    role: string
    keyType: string
    capabilities: string[]
    serviceRole: boolean
  }
}

declare global {
  namespace Express {
    interface Request {
      v1Context?: V1ApiContext
    }
  }
}

// ── API Key Resolution ────────────────────────────────────────────────────────

/**
 * Authenticate an x-api-key or Authorization: Bearer API key against the DB.
 * Returns the full apiKey record (used for rate limiting) on success.
 */
async function resolveApiKey(req: Request) {
  let providedKey: string | null = null

  const xApiKey = req.headers['x-api-key']
  if (xApiKey) {
    providedKey = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey
  } else {
    const authHeader = req.headers['authorization']
    const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (auth?.startsWith('Bearer ')) {
      providedKey = auth.substring(7)
    }
  }

  // ?apiKey= fallback — browser EventSource cannot send headers, so the SSE
  // route (and the SDK/dashboard clients) pass the key as a query parameter.
  // Mirrors lib/api/v1/middleware.ts, which has accepted this all along;
  // without it every browser realtime connection 401s in production.
  if (!providedKey) {
    const qp = req.query?.apiKey ?? req.query?.api_key
    if (typeof qp === 'string' && qp) providedKey = qp
  }

  if (!providedKey) {
    return {
      error: 'API key required. Use x-api-key header or Authorization: Bearer',
      diagnostic: classifyKeyFailure(null, 'missing'),
    }
  }

  // Strategy 1: SHA-256 hash lookup (newer keys — lib/auth/apiKeyAuth.ts)
  const keyHash = crypto.createHash('sha256').update(providedKey).digest('hex')
  let apiKeyRecord = await prisma.apiKey.findFirst({ where: { keyHash } })

  // Strategy 2: prefix + bcrypt lookup (older keys — lib/middleware/apiKeyAuth.ts)
  if (!apiKeyRecord) {
    const keyPrefix = providedKey.substring(0, 8)
    const candidates = await prisma.apiKey.findMany({
      where: {
        keyPrefix,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    })
    for (const candidate of candidates) {
      if (await verifyPassword(providedKey, candidate.key)) {
        apiKeyRecord = candidate
        break
      }
    }
  }

  if (!apiKeyRecord) {
    // Distinguish expired-but-known from genuinely-unknown so the hint fits.
    const expired = await prisma.apiKey.findFirst({
      where: { keyHash, expiresAt: { not: null, lte: new Date() } },
      select: { id: true },
    })
    return {
      error: 'Invalid API key',
      diagnostic: classifyKeyFailure(providedKey, expired ? 'expired' : 'unknown_key'),
    }
  }
  if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
    return {
      error: 'API key has expired',
      diagnostic: classifyKeyFailure(providedKey, 'expired'),
    }
  }

  return { apiKeyRecord }
}

// ── Hard Rate Limiting ────────────────────────────────────────────────────────

interface RateLimitDecision {
  allowed: boolean
  remaining: number
  resetAt: Date
  retryAfter?: number
}

/**
 * Atomic rate limit check and increment for an API key.
 *
 * Uses ApiKey.requestCount + ApiKey.resetAt (window expiry).
 *
 * Algorithm:
 *   1. If window has expired (resetAt <= now): reset counter, allow request.
 *   2. Otherwise: attempt an atomic UPDATE WHERE requestCount < limit.
 *      - If 1 row updated → allowed.
 *      - If 0 rows updated → limit reached → 429.
 *
 * This is race-condition-free: two concurrent requests cannot both "win" the
 * conditional update when only one slot remains.
 */
async function enforceHardRateLimit(apiKeyRecord: any): Promise<RateLimitDecision> {
  const now = new Date()
  const limit: number = apiKeyRecord.rateLimit ?? 1000
  const windowMs: number = (apiKeyRecord.rateLimitWindow ?? 3600) * 1000
  const windowEnd = new Date(now.getTime() + windowMs)

  // Window expired → reset and allow
  if (!apiKeyRecord.resetAt || apiKeyRecord.resetAt <= now) {
    await prisma.apiKey.update({
      where: { id: apiKeyRecord.id },
      data: { requestCount: 1, resetAt: windowEnd, lastUsed: now },
    })
    return { allowed: true, remaining: limit - 1, resetAt: windowEnd }
  }

  // Within window: atomic increment (only succeeds if count is still under limit)
  const updated = await prisma.apiKey.updateMany({
    where: { id: apiKeyRecord.id, requestCount: { lt: limit } },
    data: { requestCount: { increment: 1 }, lastUsed: now },
  })

  if (updated.count === 0) {
    const retryAfter = Math.max(
      1,
      Math.ceil((apiKeyRecord.resetAt.getTime() - now.getTime()) / 1000)
    )
    return {
      allowed: false,
      remaining: 0,
      resetAt: apiKeyRecord.resetAt,
      retryAfter,
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - apiKeyRecord.requestCount - 1),
    resetAt: apiKeyRecord.resetAt,
  }
}

/**
 * Enforce rate limiting by API key ID.
 * Exported so dynamic.ts (which has its own auth flow) can reuse it.
 */
export async function enforceRateLimitByKeyId(keyId: string): Promise<RateLimitDecision> {
  const record = await prisma.apiKey.findUnique({
    where: { id: keyId },
    select: {
      id: true,
      rateLimit: true,
      rateLimitWindow: true,
      requestCount: true,
      resetAt: true,
    },
  })
  if (!record) {
    // Key not found — let the auth middleware handle it; just allow here
    return { allowed: true, remaining: 0, resetAt: new Date() }
  }
  return enforceHardRateLimit(record)
}

// ── v1 Auth Middleware ────────────────────────────────────────────────────────

/**
 * Express middleware: validates API key + project ownership + rate limit.
 * Attaches V1ApiContext to req.v1Context on success.
 * Sets standard X-RateLimit-* headers on every response.
 */
export async function v1AuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const projectId = req.params.projectId

  if (!projectId) {
    sendError(res, ErrorCodes.BAD_REQUEST, 'Invalid project ID', 400)
    return
  }

  const resolved = await resolveApiKey(req)
  if ('error' in resolved) {
    // Self-diagnosing 401: thread the structured diagnostic and a deep-link
    // to the dashboard into the response so the developer (or the SDK's
    // DevTools banner) can see WHY their request was rejected and how to
    // fix it — without opening Network tab or grepping the codebase.
    const d: ApiKeyFailureDiagnostic | undefined = (resolved as any).diagnostic
    const origin = (req.headers['origin'] as string | undefined)
      ?? (req.headers['referer'] as string | undefined)
      ?? null
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? (req.headers['x-real-ip'] as string | undefined)
      ?? req.socket?.remoteAddress
      ?? null

    // Feed the Connection Health dashboard surface — non-blocking.
    // SKIP internal origins (backenly.com, localhost): the dashboard
    // dogfooding the v1 runtime is not a customer frontend. Mirrors the
    // Next-side writer in lib/api/v1/middleware.ts — this Express path is
    // the one that actually serves /api/v1/* in production.
    if (!isInternalOrigin(origin)) {
      recordSecurityEvent({
        kind: 'auth_failure',
        severity: 'info',
        projectId,
        ip,
        summary: `Auth failed (${d?.kind ?? 'unknown'}) from ${origin ?? 'unknown origin'}`,
        detail: {
          kind: d?.kind ?? 'unknown',
          sentKeyShape: d?.sentKeyShape ?? null,
          origin,
          path: req.originalUrl ?? req.url,
          method: req.method,
          userAgent: req.headers['user-agent'] ?? null,
        },
      }).catch(() => {})
    }

    sendError(
      res,
      ErrorCodes.UNAUTHORIZED,
      resolved.error,
      401,
      d
        ? {
            kind: d.kind,
            sentKeyShape: d.sentKeyShape,
            hint: d.hint,
            fixUrl: `https://backenly.com/app/projects/${projectId}/connect`,
          }
        : undefined,
    )
    return
  }

  const { apiKeyRecord } = resolved

  if (apiKeyRecord.keyType !== 'public') {
    sendError(
      res,
      ErrorCodes.FORBIDDEN,
      'Dashboard keys cannot access public API endpoints. Use a public API key instead.',
      403
    )
    return
  }

  if (!apiKeyRecord.projectId) {
    sendError(res, ErrorCodes.FORBIDDEN, 'Public API key must be scoped to a project', 403)
    return
  }

  if (apiKeyRecord.projectId !== projectId) {
    sendError(res, ErrorCodes.FORBIDDEN, 'API key does not have access to this project', 403)
    return
  }

  // ── A service-role key must never answer a browser ──────────────────────────
  //
  // This key bypasses every RLS policy in the project by design. That is correct
  // on a server and a total breach in a browser: every row of every table,
  // readable by anyone who opens developer tools, with no policy in the way.
  //
  // Refused rather than logged, because logging it reports a leak the owner
  // cannot un-ship, while refusing it turns the mistake into a 403 on their own
  // machine the first time they run the code. Placed BEFORE the rate-limit
  // accounting on purpose — a refused request must not consume the caller's
  // budget, or a leaked key in a deployed bundle would exhaust the quota of the
  // server code legitimately sharing it.
  if (apiKeyRecord.serviceRole) {
    const verdict = detectBrowserOrigin(req.headers as Record<string, string | string[] | undefined>)
    if (verdict.isBrowser) {
      recordServiceRoleBrowserBlock({
        projectId,
        apiKeyId: apiKeyRecord.id,
        keyName: apiKeyRecord.name ?? null,
        keyPrefix: apiKeyRecord.keyPrefix ?? null,
        verdict,
        method: req.method,
        path: req.originalUrl ?? req.url ?? '',
      }).catch(() => {})

      sendError(
        res,
        ErrorCodes.FORBIDDEN,
        serviceRoleRefusalMessage(apiKeyRecord.name ?? null),
        403,
        {
          kind: 'service_role_in_browser',
          detectedVia: verdict.signal,
          origin: verdict.origin,
          fixUrl: `https://backenly.com/app/projects/${projectId}/connect`,
        },
      )
      return
    }
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Project not found', 404)
    return
  }

  // ── Hard rate limiting ──────────────────────────────────────────────────────
  const limit: number = apiKeyRecord.rateLimit ?? 1000
  const rl = await enforceHardRateLimit(apiKeyRecord)

  // Always send rate limit headers so clients can self-throttle
  res.setHeader('X-RateLimit-Limit', String(limit))
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
  res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt.getTime() / 1000)))

  if (!rl.allowed) {
    if (rl.retryAfter) res.setHeader('Retry-After', String(rl.retryAfter))
    sendError(
      res,
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded. You may make ${limit} requests per ${Math.round((apiKeyRecord.rateLimitWindow ?? 3600) / 60)} minute(s). ` +
      `Try again in ${rl.retryAfter ?? 'a moment'} second(s).`,
      429,
      { retryAfter: rl.retryAfter, limit, resetAt: rl.resetAt.toISOString() }
    )
    return
  }

  req.v1Context = {
    projectId,
    apiKey: {
      id: apiKeyRecord.id,
      userId: apiKeyRecord.userId,
      permissions: apiKeyRecord.permissions,
      role: apiKeyRecord.role,
      keyType: apiKeyRecord.keyType,
      capabilities: apiKeyRecord.capabilities,
      serviceRole: apiKeyRecord.serviceRole,
    },
  }

  next()
}

// ── Permission helpers ─────────────────────────────────────────────────────────

/**
 * `required` is a set of ALTERNATIVES — holding ANY one grants access (e.g.
 * ['read','admin'] means "a read key OR an admin key"). This MUST be OR
 * (`some`), not AND (`every`): every route's list ends in 'admin', so
 * AND-semantics collapsed every endpoint to admin-only and 403'd valid keys.
 */
export function hasPermission(permissions: string[], required: string | string[]): boolean {
  const perms = Array.isArray(required) ? required : [required]
  if (permissions.includes('admin')) return true
  return perms.some(p => permissions.includes(p))
}

export function checkPermission(
  res: Response,
  context: V1ApiContext,
  required: string | string[]
): boolean {
  // Service-role keys (backend-only) and admin-role keys are full-access by
  // definition — they bypass granular permission gates.
  if (context.apiKey.serviceRole || context.apiKey.role === 'admin') {
    return true
  }
  if (!hasPermission(context.apiKey.permissions, required)) {
    sendError(res, ErrorCodes.FORBIDDEN, 'Insufficient permissions', 403, {
      required: Array.isArray(required) ? required : [required],
    })
    return false
  }
  return true
}

export function hasCapability(capabilities: string[], required: string): boolean {
  if (capabilities.length === 0) return true
  return capabilities.includes(required)
}

const endpointCapabilityMap: Record<string, string> = {
  '/database': 'database',
  '/auth': 'auth',
  '/storage': 'storage',
  '/functions': 'functions',
  '/ai': 'ai',
  '/logs': 'database',
}

export function checkCapability(
  res: Response,
  context: V1ApiContext,
  path: string
): boolean {
  for (const [segment, capability] of Object.entries(endpointCapabilityMap)) {
    if (path.includes(segment)) {
      if (!hasCapability(context.apiKey.capabilities, capability)) {
        sendError(
          res,
          ErrorCodes.FORBIDDEN,
          `API key does not have '${capability}' capability`,
          403,
          {
            required: capability,
            available:
              context.apiKey.capabilities.length === 0 ? 'all' : context.apiKey.capabilities,
          }
        )
        return false
      }
      break
    }
  }
  return true
}
