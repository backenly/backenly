import { NextRequest, NextResponse } from 'next/server'
import { authenticateApiKey } from '@/lib/middleware/apiKeyAuth'
import { prisma } from '@/lib/db'
import { createErrorResponse, ErrorCodes } from './errors'
import { checkUsage, getUsageMessage } from '@/lib/scaling/usage-monitor'
import { applySoftRateLimit } from '@/lib/scaling/usage-monitor'
import { scanRequest } from '@/lib/services/waf'
import crypto from 'crypto'
import { markFrontendConnected, markExternalUsage, trackUsage } from '@/lib/analytics/logger'
import { enforceAndTrackApiRequest } from '@/lib/quota/kernel'
import { getPlatformControls, recordSecurityEvent } from '@/lib/platform/controls'
import jwt from 'jsonwebtoken'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'

import { INTERNAL_DOMAINS, isInternalOrigin } from '@/lib/security/internal-origin'

// Re-exported for existing importers; canonical home is lib/security/internal-origin.ts
// (framework-free so the Express runtime can share it).
export { INTERNAL_DOMAINS, isInternalOrigin }

function isExternalOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin') || request.headers.get('referer') || ''
  if (!origin) return false
  try {
    const host = new URL(origin).hostname
    return !INTERNAL_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}

export interface V1ApiContext {
  projectId: string
  correlationId: string
  /**
   * End-user ID extracted from the project-scoped JWT in `X-User-Token`.
   * Used by database routes to set `app.current_user_id` before executing
   * workspace queries so PostgreSQL RLS policies are enforced.
   * null when the request is a service-role / server-to-server call.
   */
  endUserId: string | null
  /**
   * End-user role from the project-scoped JWT (e.g. 'admin', 'user').
   * null when no X-User-Token is present or the token has no role claim.
   */
  endUserRole: string | null
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

/**
 * Middleware for v1 public API routes
 * Validates API key, project ID, and ensures project ownership
 */
export async function v1ApiMiddleware(
  request: NextRequest,
  params: { projectId: string }
): Promise<{ context: V1ApiContext; response?: NextResponse }> {
  // 0. Generate correlation ID for request tracing
  const correlationId = request.headers.get('x-correlation-id') || crypto.randomUUID()

  // 0b. WAF scan (query params, headers, path — not body, consumed by route)
  const wafResult = scanRequest({
    query: Object.fromEntries(request.nextUrl.searchParams),
    headers: {
      'user-agent': request.headers.get('user-agent') || '',
      'referer': request.headers.get('referer') || '',
    },
    path: request.nextUrl.pathname,
  })
  if (wafResult.detected) {
    console.warn(`[WAF] Blocked ${wafResult.attackType} attack on ${request.nextUrl.pathname} (correlationId: ${correlationId})`)
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'Request blocked by security policy',
        400,
        { code: 'WAF_BLOCKED', attackType: wafResult.attackType }
      ),
    }
  }

  // 1. Authenticate API key
  const auth = await authenticateApiKey(request)

  if (!auth.authenticated || !auth.apiKey) {
    // Self-diagnosing 401: return the SHAPE of what we received plus a
    // hint and a deep-link to the dashboard's Connect Frontend page.
    // Goal: turn "Invalid API key" + 2 hours of mystery into "you sent
    // 'undefined' — set the env var or paste the literal" + 10 seconds.
    const fr = auth.failureReason
    const origin = request.headers.get('origin') || request.headers.get('referer') || null

    // Fire a non-blocking telemetry event so the dashboard can surface
    // "X requests from origin Y failed in the last 5 minutes" without
    // any extra logging plumbing on this hot path.
    //
    // SKIP internal origins (backenly.com, localhost): those are dashboard
    // pages dogfooding the v1 runtime — surfacing them on Connection Health
    // would falsely tell the project owner "your frontend backenly.com is
    // failing" when in reality it's our own UI hitting the runtime without
    // an anon key. Real customer frontends (lovable.app, vercel.app, the
    // user's own domain) are never filtered.
    if (!isInternalOrigin(origin)) {
      recordSecurityEvent({
        kind: 'auth_failure',
        severity: 'info',
        projectId: params.projectId,
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        summary: `Auth failed (${fr?.kind ?? 'unknown'}) from ${origin ?? 'unknown origin'}`,
        detail: {
          kind: fr?.kind ?? 'unknown',
          sentKeyShape: fr?.sentKeyShape ?? null,
          origin,
          path: request.nextUrl.pathname,
          method: request.method,
          userAgent: request.headers.get('user-agent') ?? null,
        },
      }).catch(() => {})
    }

    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.UNAUTHORIZED,
        auth.error || 'API key authentication required',
        401,
        fr
          ? {
              kind: fr.kind,
              sentKeyShape: fr.sentKeyShape,
              hint: fr.hint,
              fixUrl: `https://backenly.com/app/projects/${params.projectId}/connect`,
            }
          : undefined,
        correlationId,
      ),
    }
  }

  // 2. Get full API key record to check keyType and capabilities
  const apiKeyRecord = await prisma.apiKey.findUnique({
    where: { id: auth.apiKey.id },
  })

  if (!apiKeyRecord) {
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.UNAUTHORIZED,
        'API key not found',
        401
      ),
    }
  }

  if (auth.rateLimited) {
    // Hard 429 — rate limit is enforced at the HTTP layer, not just logged.
    // Also surface a low-severity api_abuse signal so the founder sees keys
    // that are being hammered (noisy-neighbor / scraping / runaway loop).
    recordSecurityEvent({
      kind: 'api_abuse',
      severity: 'warn',
      userId: apiKeyRecord.userId,
      projectId: params.projectId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      summary: `Rate limit hit on project ${params.projectId} (key ${apiKeyRecord.keyPrefix})`,
      detail: { apiKeyId: apiKeyRecord.id, path: request.nextUrl.pathname, limit: apiKeyRecord.rateLimit },
    }).catch(() => {})
    const rateLimit = apiKeyRecord.rateLimit || 100
    return {
      context: {} as V1ApiContext,
      response: NextResponse.json(
        { error: 'Rate limit exceeded. Please slow down and retry after the window resets.' },
        {
          status: 429,
          headers: {
            'Retry-After': '60',
            'X-RateLimit-Limit': String(rateLimit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
          },
        }
      ),
    }
  }

  // 3. Validate project ID format
  const projectId = params.projectId
  if (!projectId || typeof projectId !== 'string') {
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'Invalid project ID',
        400
      ),
    }
  }

  // 3. Verify project exists
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  })

  if (!project) {
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.NOT_FOUND,
        'Project not found',
        404
      ),
    }
  }

  // ── Platform kill switches (founder /admin Control tab) ──────────────────
  // - Per-project lockdown:           any method → 503
  // - Platform maintenanceMode:       any method → 503
  // - Platform readOnly:              write methods (POST/PUT/PATCH/DELETE) → 503
  //
  // GETs are still allowed under readOnly so apps can keep serving traffic
  // while we hold the line on writes. Lockdown is total — reads + writes —
  // because a compromised project should be sealed completely.
  if (project.lockedDownAt) {
    await recordSecurityEvent({
      kind: 'lockdown',
      severity: 'high',
      projectId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      summary: `Public request blocked — project "${project.name}" is locked down`,
      detail: { path: request.nextUrl.pathname, method: request.method },
    }).catch(() => {})
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.FORBIDDEN,
        'This project is currently locked by the platform operator. Contact support.',
        503,
      ),
    }
  }

  const path = request.nextUrl.pathname
  const isStatusEndpoint =
    path === `/api/v1/${projectId}` ||
    path === `/api/v1/${projectId}/healthz`

  // ── The publish gate is NOT enforced here, deliberately ────────────────────
  //
  // This used to refuse every request unless
  // `publicEnabled && isDeployed && projectStatus === 'LIVE'`.
  //
  // The problem is not the rule. It is that this middleware guards only the
  // Next-owned v1 surfaces — storage, orgs, stats, cart, checkout, webhooks
  // (see server/routes/next-proxy.ts). `/db/*`, `/auth/*`, `/fn/*` and
  // `/realtime/*` are served by the Express runtime, which has no equivalent
  // check. So on an unpublished project:
  //
  //   /db/*       works      — full CRUD over every table
  //   /auth/*     works      — end-users can sign up and sign in
  //   /fn/*       works      — every deployed function is callable
  //   /storage/*  403        — "This project is not published"
  //
  // Verified against a live PRIVATE project on 2026-07-22, and reported by the
  // developer who hit it: their entire backend worked and buckets alone were
  // unusable, with an error implying they had skipped a step that nothing else
  // required.
  //
  // A gate covering one of four public surfaces is not a security boundary —
  // anything it would protect is reachable through the other three. It only
  // produces the inconsistency above. So it is removed here rather than
  // extended: removing it grants no access that `/db/*` was not already
  // granting to the same key.
  //
  // ── If a real publish gate is wanted ───────────────────────────────────────
  //
  // It has to live where BOTH runtimes pass through — the API-key authentication
  // step in server/lib/auth.ts, which Express and Next both reach — and it is a
  // product decision (does a developer's own backend work before they press
  // Publish?) rather than a bug fix. Reinstating it here alone would restore the
  // inconsistency, not the protection.
  //
  // What still blocks a request, and is genuinely enforced: `lockedDownAt`
  // (above), platform maintenance / read-only (below), API-key scope, quota,
  // and RLS. Those are real gates on every surface.
  void isStatusEndpoint

  const platformControls = await getPlatformControls()
  const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())
  if (platformControls.maintenanceMode || (platformControls.readOnly && isWriteMethod)) {
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.FORBIDDEN,
        platformControls.maintenanceMode
          ? 'Platform is in maintenance mode. Try again shortly.'
          : 'Platform is in read-only mode right now.',
        503,
      ),
    }
  }

  // Check if user has access to this project
  // API key user must own the project or the API key must be scoped to this project
  if (project.userId !== auth.apiKey.userId) {
    // We'll verify project access via API key's projectId in step 6
  }

  // 4. Only public keys can access /v1 routes
  if (apiKeyRecord.keyType !== 'public') {
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.FORBIDDEN,
        'Dashboard keys cannot access public API endpoints. Use a public API key instead.',
        403
      ),
    }
  }

  // 5. Public keys MUST have a projectId
  if (!apiKeyRecord.projectId) {
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.FORBIDDEN,
        'Public API key must be scoped to a project',
        403
      ),
    }
  }

  // 6. Verify API key belongs to this project
  if (apiKeyRecord.projectId !== projectId) {
    // A valid API key being pointed at a DIFFERENT project's runtime is a
    // textbook cross-tenant probe — high severity, surfaced on Security tab.
    recordSecurityEvent({
      kind: 'cross_tenant',
      severity: 'high',
      userId: apiKeyRecord.userId,
      projectId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      summary: `API key scoped to ${apiKeyRecord.projectId} used against project ${projectId}`,
      detail: { apiKeyId: apiKeyRecord.id, keyProjectId: apiKeyRecord.projectId, requestedProjectId: projectId, path: request.nextUrl.pathname },
    }).catch(() => {})
    return {
      context: {} as V1ApiContext,
      response: createErrorResponse(
        ErrorCodes.FORBIDDEN,
        'API key does not have access to this project',
        403
      ),
    }
  }

  // 7. Plan-driven API request quota — the Plan table is the source of truth.
  //    Free = lifetime total, paid = per-month, null = unlimited. The 80%
  //    warning is fired inside the kernel (soft); here we hard-block at 100%.
  //    Fail-open: a billing hiccup never refuses a paying customer's request.
  const apiQuota = await enforceAndTrackApiRequest(apiKeyRecord.userId)
  if (!apiQuota.allowed) {
    return {
      context: {} as V1ApiContext,
      response: NextResponse.json(
        {
          error: apiQuota.message,
          code: apiQuota.code,
          plan: apiQuota.plan,
          used: apiQuota.used,
          limit: apiQuota.max,
          upgradeUrl: '/pricing',
        },
        { status: 429, headers: { 'Retry-After': '3600' } },
      ),
    }
  }

  // ── End-user identity for RLS context ─────────────────────────────────────
  // End-users receive a project-scoped JWT from /v1/{projectId}/auth/signin.
  // They must pass it as `X-User-Token: <jwt>` on every database request so
  // the server can set app.current_user_id before executing workspace queries.
  // Service-role keys (serviceRole = true) bypass this — they see all rows.
  let endUserId: string | null = null
  let endUserRole: string | null = null
  if (!apiKeyRecord.serviceRole) {
    const userTokenHeader = request.headers.get('x-user-token')
    if (userTokenHeader) {
      const rawToken = userTokenHeader.startsWith('Bearer ')
        ? userTokenHeader.substring(7)
        : userTokenHeader
      // Verify with the project's own jwtSecret — end-user tokens are signed
      // with project.jwtSecret (not the platform JWT_SECRET) to prevent cross-project replay.
      let payload: any = null
      if (project.jwtSecret) {
        try {
          payload = jwt.verify(rawToken, resolveJwtSecret(project.jwtSecret), { algorithms: ['HS256'] }) as any
        } catch {
          // Token invalid or signed with wrong key — payload stays null
        }
      }
      // Accept only project-scoped tokens issued for THIS project
      if (payload?.projectId === projectId && payload.userId) {
        // Reject tokens that have been explicitly revoked via /auth/logout.
        // The blacklist table is created lazily — skip the check gracefully if
        // it does not yet exist (i.e. no user has ever logged out from this project).
        let blacklisted = false
        if (payload.jti) {
          try {
            const schemaName = `workspace_${projectId}`
            const rows = await prisma.$queryRawUnsafe<{ jti: string }[]>(
              `SELECT jti FROM "${schemaName}"."_token_blacklist" WHERE jti = $1 LIMIT 1`,
              payload.jti
            )
            blacklisted = rows.length > 0
          } catch {
            // Table doesn't exist yet — treat as not blacklisted
          }
        }

        if (!blacklisted) {
          endUserId = String(payload.userId)
          endUserRole = (payload as any).role ?? 'user'
        } else {
          return {
            context: {} as V1ApiContext,
            response: createErrorResponse(
              ErrorCodes.UNAUTHORIZED,
              'Token has been revoked. Please sign in again.',
              401
            ),
          }
        }
      }
    }
  }

  // ── Founder Analytics: detect external usage (non-blocking) ───────────────
  const userId = apiKeyRecord.userId
  if (userId) {
    // Any API key usage = frontend connected
    if (!project.isFrontendConnected) {
      markFrontendConnected(projectId, userId)
    }
    // Requests from an external domain = real external users
    if (!project.hasExternalUsers && isExternalOrigin(request)) {
      markExternalUsage(projectId, userId)
    }
    // Track API call
    trackUsage(userId, projectId, { apiCalls: 1 })
  }

  return {
    context: {
      projectId,
      correlationId,
      endUserId,
      endUserRole,
      apiKey: {
        id: apiKeyRecord.id,
        userId: apiKeyRecord.userId,
        permissions: apiKeyRecord.permissions,
        role: apiKeyRecord.role,
        keyType: apiKeyRecord.keyType,
        capabilities: apiKeyRecord.capabilities,
        serviceRole: apiKeyRecord.serviceRole,
      },
    },
  }
}

/**
 * Check whether an API key holds a required permission.
 *
 * `required` is a set of ALTERNATIVES — holding ANY one of them grants
 * access. Routes pass lists like ['read','admin'] meaning "a read key OR an
 * admin key may call this endpoint". (A single-string `required` behaves
 * identically under either reading.)
 *
 * This MUST be OR (`some`), not AND (`every`): every route's list ends in
 * 'admin', so AND-semantics silently collapsed every endpoint to admin-only
 * and returned a blanket 403 to perfectly valid read/write keys.
 */
export function hasPermission(
  permissions: string[],
  required: string | string[]
): boolean {
  const requiredPerms = Array.isArray(required) ? required : [required]

  // Admin has all permissions
  if (permissions.includes('admin')) {
    return true
  }

  return requiredPerms.some(perm => permissions.includes(perm))
}

/**
 * Require specific permission for endpoint
 */
export function requirePermission(
  context: V1ApiContext,
  permission: string | string[]
): NextResponse | null {
  // Service-role keys (backend-only) and admin-role keys are full-access by
  // definition — they bypass granular permission gates.
  if (context.apiKey.serviceRole || context.apiKey.role === 'admin') {
    return null
  }
  if (!hasPermission(context.apiKey.permissions, permission)) {
    return createErrorResponse(
      ErrorCodes.FORBIDDEN,
      'Insufficient permissions',
      403,
      { required: Array.isArray(permission) ? permission : [permission] }
    )
  }
  return null
}

/**
 * Map endpoint paths to capabilities
 */
const endpointCapabilityMap: Record<string, string> = {
  '/database': 'database',
  '/auth': 'auth',
  '/storage': 'storage',
  '/functions': 'functions',
  '/ai': 'ai',
  '/logs': 'database', // Logs are part of database capability
}

/**
 * Get required capability for an endpoint
 */
function getRequiredCapability(pathname: string): string | null {
  for (const [path, capability] of Object.entries(endpointCapabilityMap)) {
    if (pathname.includes(path)) {
      return capability
    }
  }
  return null
}

/**
 * Check if API key has required capability
 */
export function hasCapability(
  capabilities: string[],
  required: string
): boolean {
  // Empty capabilities array means all capabilities are allowed
  if (capabilities.length === 0) {
    return true
  }
  return capabilities.includes(required)
}

/**
 * Require specific capability for endpoint
 */
export function requireCapability(
  context: V1ApiContext,
  endpoint: string
): NextResponse | null {
  const requiredCapability = getRequiredCapability(endpoint)

  if (requiredCapability && !hasCapability(context.apiKey.capabilities, requiredCapability)) {
    return createErrorResponse(
      ErrorCodes.FORBIDDEN,
      `API key does not have '${requiredCapability}' capability`,
      403,
      {
        required: requiredCapability,
        available: context.apiKey.capabilities.length === 0 ? 'all' : context.apiKey.capabilities,
      }
    )
  }

  return null
}

/**
 * Require the end-user to have the 'admin' role in their project-scoped JWT.
 *
 * Use this in GENERATE_FUNCTION handlers for admin-only business endpoints
 * (e.g. GET /admin/users, GET /admin/stats, DELETE /admin/users/:id).
 *
 * Service-role API keys bypass this check because they are already restricted
 * to server-to-server calls and never exposed to untrusted clients.
 *
 * Returns a 403 NextResponse when the caller is not an admin, null otherwise.
 */
export function requireEndUserAdmin(context: V1ApiContext): NextResponse | null {
  // Service-role keys have full access — they're backend-only
  if (context.apiKey.serviceRole) return null

  if (context.endUserRole !== 'admin') {
    return createErrorResponse(
      ErrorCodes.FORBIDDEN,
      'Admin role required. This endpoint is restricted to users with role=admin.',
      403
    )
  }
  return null
}
