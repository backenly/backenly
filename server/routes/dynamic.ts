/**
 * Dynamic catch-all route — Express version.
 *
 * Handles generic CRUD for generated tables:
 *   GET    /api/v1/:resource
 *   GET    /api/v1/:resource/:id
 *   POST   /api/v1/:resource
 *   PUT    /api/v1/:resource/:id
 *   PATCH  /api/v1/:resource/:id
 *   DELETE /api/v1/:resource/:id
 *
 * projectId is DERIVED from the API key — never from the URL or query params.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { prisma } from '@/lib/db'
import { verify } from 'jsonwebtoken'
import { enforceRateLimitByKeyId } from '../lib/auth'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { hashApiKey, resolveEndUserFromToken } from '../lib/end-user-identity'
import { handleViaPostgrest } from './postgrest-handler'
import { v1NotFoundBody } from '@/lib/api/v1/route-not-found'
import {
  detectBrowserOrigin,
  recordServiceRoleBrowserBlock,
  serviceRoleRefusalMessage,
} from '@/lib/security/service-role-exposure'

const router = Router()

// ── Auth helpers (no NextRequest dependency) ──────────────────────────────────

interface AuthResolution {
  success: boolean
  projectId?: string
  keyId?: string
  userId?: string
  // RLS identity for the workspace DB session.
  endUserId?: string
  isServiceRole?: boolean
  userRole?: string
  /**
   * Branch schema this credential is bound to, or undefined for main.
   * Resolved from ApiKey.branchId during authentication and never from the
   * request, because a client-settable value here selects a PostgreSQL schema.
   */
  branchSchema?: string
  error?: string
  code?: string
}

/**
 * Exported so /api/v2 authenticates through the EXACT same path. Two auth
 * implementations for two surfaces over one data plane is how a fix lands on
 * one and not the other.
 */
export async function getProjectIdFromAuth(req: Request): Promise<AuthResolution> {
  const xApiKey = req.headers['x-api-key'] as string | undefined
  if (xApiKey) {
    const keyHash = hashApiKey(xApiKey)
    const key = await prisma.apiKey.findFirst({
      where: { keyHash },
      select: {
        id: true, name: true, keyPrefix: true, projectId: true, userId: true,
        permissions: true, rateLimit: true, expiresAt: true, serviceRole: true,
        branch: { select: { schemaName: true, status: true } },
      },
    })
    if (!key) return { success: false, error: 'Invalid API key', code: 'INVALID_API_KEY' }
    if (key.expiresAt && key.expiresAt < new Date()) return { success: false, error: 'API key has expired', code: 'API_KEY_EXPIRED' }
    if (!key.projectId) return { success: false, error: 'API key is not associated with a project', code: 'NO_PROJECT_ID' }

    // ── A service-role key must never answer a browser ────────────────────────
    //
    // This is the path /api/v2 and the PostgREST handler authenticate through,
    // so it is the one that actually serves tenant data — the guard belongs here
    // as much as in v1AuthMiddleware, and putting it in only one of them is how a
    // fix lands on one surface and not the other (see this function's own
    // docstring). A service-role key short-circuits every RLS policy; from a
    // browser that is every row of every table, exposed to anyone with devtools.
    if (key.serviceRole) {
      const verdict = detectBrowserOrigin(req.headers as Record<string, string | string[] | undefined>)
      if (verdict.isBrowser) {
        recordServiceRoleBrowserBlock({
          projectId: key.projectId,
          apiKeyId: key.id,
          keyName: key.name ?? null,
          keyPrefix: key.keyPrefix ?? null,
          verdict,
          method: req.method,
          path: req.originalUrl ?? req.url ?? '',
        }).catch(() => {})
        return {
          success: false,
          error: serviceRoleRefusalMessage(key.name ?? null),
          code: 'SERVICE_ROLE_IN_BROWSER',
        }
      }
    }
    prisma.apiKey.update({ where: { id: key.id }, data: { lastUsed: new Date() } }).catch(console.error)

    // RLS identity:
    //   - service-role key → bypass RLS (backends, cron, internal tools)
    //   - non-service key + X-User-Token → act as that end-user (own_rows)
    //   - non-service key, no user token → no user context (own_rows → empty)
    let endUserId: string | undefined
    let userRole: string | undefined
    if (!key.serviceRole) {
      const endUser = await resolveEndUserFromToken(
        key.projectId,
        (req.headers['x-user-token'] as string | undefined),
      )
      if (endUser) {
        endUserId = endUser.userId
        userRole = endUser.role
      }
    }

    // A key bound to a branch that was merged or discarded must NOT silently
    // fall back to main. That is the one failure mode branch routing can have
    // that is worse than an error: a staging credential quietly starts reading
    // and writing production, and every request succeeds while it does it.
    if (key.branch && key.branch.status !== 'active') {
      return {
        success: false,
        error:
          'This key is bound to a branch that is no longer active. Issue a key for another ' +
          'branch, or a main key, rather than letting it fall back to production data.',
        code: 'BRANCH_INACTIVE',
      }
    }

    return {
      success: true,
      projectId: key.projectId,
      keyId: key.id,
      userId: key.userId,
      endUserId,
      isServiceRole: !!key.serviceRole,
      userRole,
      branchSchema: key.branch?.schemaName,
    }
  }

  const authHeader = req.headers['authorization'] as string | undefined
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    try {
      // Decode without verification first to extract projectId, then re-verify
      // with the correct secret. End-user tokens are signed with project.jwtSecret;
      // platform tokens are signed with JWT_SECRET. We try both.
      const unverified: any = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

      if (unverified?.projectId) {
        // End-user token — verify with project.jwtSecret
        const project = await prisma.project.findUnique({
          where: { id: unverified.projectId },
          select: { id: true, jwtSecret: true },
        })
        if (!project?.jwtSecret) return { success: false, error: 'Invalid token', code: 'INVALID_TOKEN' }
        const decoded: any = verify(token, resolveJwtSecret(project.jwtSecret), { algorithms: ['HS256'] })
        if (!decoded?.userId) return { success: false, error: 'Invalid token', code: 'INVALID_TOKEN' }
        // Reject tokens revoked via /auth/logout.
        if (decoded.jti) {
          try {
            const schemaName = `workspace_${decoded.projectId}`
            const rows = await prisma.$queryRawUnsafe<{ jti: string }[]>(
              `SELECT jti FROM "${schemaName}"."_token_blacklist" WHERE jti = $1 LIMIT 1`,
              decoded.jti,
            )
            if (rows.length > 0) {
              return { success: false, error: 'Token has been revoked. Please sign in again.', code: 'TOKEN_REVOKED' }
            }
          } catch {
            // Blacklist table doesn't exist yet — not revoked.
          }
        }
        // End-user JWT → RLS scopes to their own rows.
        return {
          success: true,
          projectId: decoded.projectId,
          userId: decoded.userId,
          endUserId: String(decoded.userId),
          isServiceRole: false,
          userRole: decoded.role ?? 'user',
        }
      }

      // Platform token — verify with JWT_SECRET (no fallback string; fail
      // closed if env not set). Platform owners operate as service-role over
      // their own project's data (dashboard-style full access).
      const jwtSecret = process.env.JWT_SECRET
      if (!jwtSecret) return { success: false, error: 'Server misconfiguration', code: 'CONFIG_ERROR' }
      const decoded: any = verify(token, jwtSecret, { algorithms: ['HS256'] })
      if (!decoded?.userId) return { success: false, error: 'Invalid token', code: 'INVALID_TOKEN' }
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, projects: { take: 1, select: { id: true } } },
      })
      if (!user || user.projects.length === 0) return { success: false, error: 'No project found for user', code: 'NO_PROJECT' }
      return { success: true, projectId: user.projects[0].id, userId: user.id, isServiceRole: true }
    } catch {
      return { success: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' }
    }
  }

  return { success: false, error: 'Authentication required', code: 'NO_AUTH_PROVIDED' }
}

// ── Request handler ────────────────────────────────────────────────────────────

// Auth sub-paths that must never be intercepted by the dynamic catch-all.
// Requests to these paths without an explicit route handler should return a
// clear 404 rather than a confusing "Invalid or expired token" 401.
const AUTH_PATH_SEGMENTS = new Set([
  'login', 'signin', 'signup', 'register', 'logout', 'refresh-token',
  'forgot-password', 'reset-password', 'me', 'session', 'token',
])

// UUID matcher used to detect the leading project-id segment in SDK URLs
// like /api/v1/{projectId}/db/{tableName}.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function handleDynamicRequest(req: Request, res: Response) {
  const rawPath = (req.params as any)[0]?.split('/').filter(Boolean) || []

  // ── Public discovery: GET /api/v1/{projectId} ────────────────────────────────
  // No auth, no API key. Returns a friendly catalogue so the user clicking the
  // "open production endpoint" link from the dashboard sees their backend is
  // alive — instead of a raw auth error JSON. Every data route under this URL
  // still requires the API key.
  if (
    req.method === 'GET' &&
    rawPath.length === 1 &&
    UUID_RE.test(rawPath[0])
  ) {
    return serveProjectDiscovery(rawPath[0], req, res)
  }

  // Block auth-looking paths from reaching the API-key auth layer.
  // This catches e.g. /auth/login when the explicit route wasn't matched,
  // preventing the JWT-verification error from returning a misleading 401.
  const hasAuthSegment = rawPath.includes('auth')
  const lastSegment = rawPath[rawPath.length - 1] ?? ''
  if (hasAuthSegment || AUTH_PATH_SEGMENTS.has(lastSegment)) {
    res.status(404).json({
      error: 'Auth endpoint not found. Use /auth/signin (or /auth/login), /auth/signup (or /auth/register).',
      code: 'NOT_FOUND',
    })
    return
  }

  const authResult = await getProjectIdFromAuth(req)
  if (!authResult.success) {
    res.status(401).json({
      error: authResult.error || 'Authentication required',
      code: authResult.code || 'AUTHENTICATION_REQUIRED',
      hint: 'Include x-api-key header or Authorization: Bearer token',
    })
    return
  }

  const { projectId, keyId, userId, endUserId, isServiceRole, userRole, branchSchema } = authResult

  // Strip the URL prefix that the SDK and verifier always include:
  //   /api/v1/{projectId}/db/{tableName}[/{id}]   →  pathSegments = [tableName, …]
  // The executeServerlessApi() executor expects pathSegments[0] to be the API
  // name (table). Previously we passed [projectId, 'db', tableName] verbatim,
  // so the executor looked up an API named after the projectId and returned
  // 404 ("availableApis": [...table names])  on every single CRUD call.
  //
  // Tolerant: only strip segments we recognise. Calls without the projectId
  // (Next.js style: /api/v1/{tableName}) still work because the leading
  // segment is not a UUID and not skipped.
  let path = [...rawPath]
  if (path.length > 0 && UUID_RE.test(path[0]) && path[0] === projectId) {
    path = path.slice(1)
  }
  // Strip a leading `/db/` collection prefix that the SDK uses for CRUD.
  // We only strip when there is a following segment (the table name), so
  // a hypothetical /api/v1/db endpoint still routes correctly.
  if (path.length >= 2 && path[0].toLowerCase() === 'db') {
    path = path.slice(1)
  }

  // ── /fn/{name} — invoke a callable AI function by name ──────────────────
  // This is what the API Builder exposes as "Business Logic" endpoints.
  // We dispatch here (instead of falling through to the generic API
  // executor) because functions are addressed by name, not by table.
  // Only `manual` triggerType functions are directly callable; auto-fired
  // triggers (on_db_*, on_signup, cron) reject with 405 to make the reason
  // obvious instead of silently 404'ing in the executor lookup.
  if (path.length >= 2 && path[0].toLowerCase() === 'fn') {
    const fnName = path[1]
    try {
      const fn = await prisma.aiFunction.findFirst({
        where: { projectId: projectId!, name: fnName },
        select: { id: true, status: true, triggerType: true },
      })
      if (!fn) {
        res.status(404).json({
          error: `Function "${fnName}" not found`,
          code: 'FUNCTION_NOT_FOUND',
        })
        return
      }
      // ── `status` records the last RUN. It does not gate invocation. ─────────
      //
      // This used to refuse anything that was not exactly 'active', which put
      // functions into a state they could not leave. The sequence:
      //
      //   1. a call throws — a bad row, a downstream timeout, anything
      //   2. the executor writes status='error' (executor.ts, on every throw)
      //   3. every subsequent call 409s with FUNCTION_INACTIVE
      //   4. status only clears on a SUCCESSFUL run, which step 3 prevents
      //
      // So one transient failure permanently removed a deployed endpoint, and
      // regenerating it left a window where callers got FUNCTION_INACTIVE for a
      // function that plainly existed. Reported from a real build.
      //
      // The field conflates two things: whether the function is DEPLOYED, and
      // how it LAST behaved. Only the first is a reason to refuse a request. A
      // function whose previous run errored is still deployed, and the next call
      // may well be the one that works — which is also the only way it can
      // recover on its own.
      //
      // 'disabled' remains a real refusal: that one is a deliberate act, not a
      // side effect of a runtime error.
      if (fn.status === 'disabled' || fn.status === 'deleted') {
        res.status(409).json({
          error: `Function "${fnName}" is disabled`,
          code: 'FUNCTION_DISABLED',
          hint: 'Re-enable it from the project\'s Functions page, or regenerate it with generate_function.',
        })
        return
      }
      const CALLABLE_TRIGGER_TYPES = new Set(['manual', 'http'])
      if (!CALLABLE_TRIGGER_TYPES.has(fn.triggerType)) {
        res.status(405).json({
          error: `Function "${fnName}" is an auto-fired trigger (${fn.triggerType}) and cannot be invoked directly via REST. It runs automatically when the trigger event occurs.`,
          code: 'FUNCTION_NOT_CALLABLE',
          triggerType: fn.triggerType,
        })
        return
      }

      // GET → no body; POST/PUT/PATCH → body becomes the event data.
      // Query params are always merged in so `?key=value` works for GET too.
      const queryData: Record<string, any> = {}
      Object.entries(req.query || {}).forEach(([k, v]) => {
        queryData[k] = Array.isArray(v) ? v[0] : v
      })
      const bodyData = req.body && typeof req.body === 'object' ? req.body : {}
      const eventData = { ...queryData, ...bodyData }

      // Forward the caller's auth/signature headers to the function handler —
      // generated route modules read x-user-token / x-admin-key directly.
      const { pickFnHeaders } = await import('@/lib/services/ai-functions/forward-headers')
      const fwdHeaders = pickFnHeaders(h => req.headers[h])

      const { executeAiFunction } = await import('@/lib/services/ai-functions/executor')
      const result = await executeAiFunction(fn.id, projectId!, {
        type: 'manual',
        data: eventData,
      }, {
        // Match the Next.js path: pass the resolved RLS identity so functions
        // that touch workspace tables honour own_rows for end-users while
        // service-role callers retain full access.
        endUserId,
        endUserRole: userRole,
        serviceRole: isServiceRole,
        headers: fwdHeaders,
      })

      if (!result.success) {
        res.status(500).json({
          error: result.error || 'Function execution failed',
          code: 'FUNCTION_EXECUTION_ERROR',
          logs: result.logs,
          durationMs: result.durationMs,
        })
        return
      }

      // ── Answer with the status the function actually chose ──────────────────
      //
      // This used to be an unconditional 200, with the handler's real status
      // buried at `result.status` in the body. So a function answering 404, 401
      // or 422 came back over the wire as a success:
      //
      //   HTTP/1.1 200 OK
      //   {"success":true,"result":{"status":404,"body":{"error":"Not found"}}}
      //
      // Which breaks every standard consumer at once. `fetch(...).ok` is true.
      // `res.raise_for_status()` passes. Retry middleware never retries the 503.
      // Uptime monitors report the endpoint healthy while it 500s internally.
      // Error-rate dashboards read zero. Every client has to learn a
      // Backenly-specific convention to find out whether its own request
      // worked, and any client that does not know the convention silently
      // treats failures as successes.
      //
      // The envelope is kept alongside it for callers that already read
      // `result`/`logs`, so this narrows nothing — it only makes the status line
      // tell the truth.
      const httpStatus =
        typeof result.httpStatus === 'number' && result.httpStatus >= 100 && result.httpStatus <= 599
          ? result.httpStatus
          : 200

      res.status(httpStatus).json({
        success: httpStatus < 400,
        name: fnName,
        result: result.returnValue ?? null,
        logs: result.logs,
        durationMs: result.durationMs,
      })
      return
    } catch (err: any) {
      console.error(`[fn/${fnName}] Invocation error:`, err)
      res.status(500).json({
        error: err.message || 'Failed to invoke function',
        code: 'INTERNAL_ERROR',
      })
      return
    }
  }

  // Enforce hard rate limit on API key routes (JWT-authed dynamic routes skip this)
  if (keyId) {
    const rl = await enforceRateLimitByKeyId(keyId)
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
    res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt.getTime() / 1000)))

    if (!rl.allowed) {
      if (rl.retryAfter) res.setHeader('Retry-After', String(rl.retryAfter))
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Try again in ${rl.retryAfter ?? 'a moment'} second(s).`,
          details: { retryAfter: rl.retryAfter, resetAt: rl.resetAt.toISOString() },
        },
      })
      return
    }
  }

  // ── PostgREST data plane ────────────────────────────────────────────────
  //
  // The ONLY data plane. serverlessApiExecutor and runtimeApiExecutor were
  // deleted on 2026-07-21 once every project was migrated; this used to fall
  // back to them when PostgREST errored.
  //
  // That fallback is gone deliberately. While two engines existed it was the
  // right call — the old one was still correct for un-migrated projects, so
  // degrading to it beat erroring. With one engine it would do the opposite:
  // silently paper over a PostgREST failure by serving from a plane whose RLS
  // contract no longer matches the policies, which is precisely the
  // half-migrated state that returned empty tables for two months without
  // anyone noticing. A data plane that fails loudly is worth more than one that
  // quietly answers differently.
  const handled = await handleViaPostgrest(req, res, path, {
    projectId: projectId!,
    endUserId,
    isServiceRole,
    branchSchema,
  })
  if (handled) return

  // handleViaPostgrest returns false for shapes it does not model: sub-resources
  // like /search and /bulk, and paths deeper than /table/:id. Under the old
  // engine those reached the legacy executor. They have no PostgREST equivalent
  // in this shape, so they are refused explicitly rather than 500ing somewhere
  // further down.
  // The route vocabulary comes from lib/api/v1/route-not-found, shared with the
  // Next catch-all, because this exact message is where drift does the most
  // damage: it is what a developer reads at the moment they are already lost.
  // It once said "CRUD is /{table} and /{table}/{id}" — dropping the `/db`
  // prefix — while the agent instructions said `/db/<table>` and generate_api
  // reported "live at /products". Three surfaces, three answers, and a caller
  // who followed this one got another 404 with no way to tell which document
  // was wrong. One source now, so there is nothing to keep in sync.
  const notFound = v1NotFoundBody(projectId!, path)
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_SUPPORTED',
      message:
        `No data-plane route for ${req.method} /${path.join('/')}. ` +
        (notFound.hint ? `${notFound.hint} ` : '') +
        `For richer queries — joins, aggregates, embedded resources — use ` +
        `/api/v2/{projectId}/{table}, which speaks PostgREST grammar directly.`,
    },
    // Same field name and shape the Next catch-all returns, so a client that
    // learned the vocabulary from one 404 can read the other.
    availableRoutes: notFound.availableRoutes,
    docs: notFound.docs,
  })
}

// ── Public discovery doc ─────────────────────────────────────────────────────
//
// UNREACHABLE. Kept only because deleting it during unrelated work is how a
// reviewer loses the record of why it is unreachable.
//
// `nextProxy` is mounted on /api/v1 BEFORE this router and treats a bare
// /:projectId as Next-owned, so GET /api/v1/{projectId} never arrives here —
// it is answered by app/api/v1/[projectId]/route.ts. Verified against
// production: the live response lacks fields this function returns.
//
// Two divergent implementations of one endpoint existed for a while, and the
// dead one was the better of the two: it derived resources from the live
// ApiDefinition catalogue, while the served one hardcoded cart/checkout/stats
// for every project regardless of whether those tables existed. That has been
// corrected in the Next route. Change that file, not this one.
//
// Shape is intentionally inspired by Stripe/Twilio "API root" responses: the
// caller learns what they can do *with* this backend without leaking a single
// row of customer data.
async function serveProjectDiscovery(projectId: string, req: Request, res: Response) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        isDeployed: true,
        publicEnabled: true,
        projectStatus: true,
        environment: true,
        publicUrl: true,
      },
    })

    if (!project) {
      res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' })
      return
    }

    const isLive =
      !!project.isDeployed &&
      !!project.publicEnabled &&
      project.projectStatus === 'LIVE'

    // Derive the canonical base URL from the request itself so the document
    // works whether the caller hits backenly.com, an alias, or a private host.
    const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    const proto = forwardedProto || (req.secure ? 'https' : 'http')
    const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
              || req.headers.host
              || 'backenly.com'
    const baseUrl = project.publicUrl || `${proto}://${host}/api/v1/${projectId}`

    // Read the CATALOG — the twin of the Next-side document in
    // app/api/v1/[projectId]/route.ts, and it had the same defect.
    //
    // This pulled from ApiDefinition, which has had no create path since the
    // PostgREST cutover, so on every project built after it the resource list
    // was EMPTY. The comment claimed the response "reflects what was actually
    // generated"; it reflected a projection nothing writes. This router itself
    // registers GET/POST/PUT/PATCH/DELETE on /* a few lines below, so the verb
    // set is a property of the runtime, not of a stored row.
    const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
    const exposed = await listExposedTables(projectId).catch(() => [] as Array<{ name: string }>)

    const resources = exposed
      .map(t => t.name)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({
        resource: name,
        url: `${baseUrl}/db/${name}`,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        authRequired: true,
      }))

    res.status(200).json({
      project: project.name,
      projectId: project.id,
      status: isLive ? 'live' : 'inactive',
      environment: project.environment ?? 'production',
      baseUrl,
      authentication: {
        scheme: 'apiKey',
        header: 'x-api-key',
        alternativeScheme: 'bearer',
        alternativeHeader: 'Authorization: Bearer <token>',
        note: 'All data routes below require authentication. Get a key from the dashboard → Connect Frontend.',
      },
      sdk: {
        javascript: 'https://backenly.com/backenly-sdk.js',
        usage: `const backend = new BackenlyClient({ projectId: "${project.id}", apiKey: "<your-api-key>" })`,
      },
      endpoints: {
        auth: {
          signUp: `POST ${baseUrl}/auth/signup`,
          signIn: `POST ${baseUrl}/auth/signin`,
        },
        database: resources.length > 0 ? resources : `POST ${baseUrl}/db/{table}`,
        storage: {
          upload: `POST ${baseUrl}/storage/upload`,
          list:   `GET  ${baseUrl}/storage/files`,
        },
        realtime: `GET ${baseUrl}/realtime`,
        health:   `GET ${baseUrl}/healthz`,
      },
      docs: 'https://backenly.com/docs',
    })
  } catch (err: any) {
    console.error('[/api/v1/:projectId discovery] error:', err?.message ?? err)
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
}

router.get('/*', handleDynamicRequest)
router.post('/*', handleDynamicRequest)
router.put('/*', handleDynamicRequest)
router.patch('/*', handleDynamicRequest)
router.delete('/*', handleDynamicRequest)

export default router
