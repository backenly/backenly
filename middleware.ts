import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { domainRoutingMiddleware, shouldUseDomainRouting } from '@/lib/middleware/domainRouting'
import { extractTokenFromHeader } from '@/lib/auth/jwt'

// ── Per-project CORS cache ────────────────────────────────────────────────────
const _corsCache = new Map<string, { origins: string[]; expiresAt: number }>()
const CORS_CACHE_TTL_MS = 60_000

async function getProjectAllowedOrigins(projectId: string): Promise<string[]> {
  const now = Date.now()
  const cached = _corsCache.get(projectId)
  if (cached && cached.expiresAt > now) return cached.origins

  try {
    // Edge Runtime supports fetch but not direct DB access — call a lightweight
    // internal endpoint protected by INTERNAL_API_TOKEN (or legacy AI_EXECUTION_TOKEN).
    const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/internal/project-origins?projectId=${encodeURIComponent(projectId)}`
    const internalSecret = process.env.INTERNAL_API_TOKEN ?? process.env.AI_EXECUTION_TOKEN ?? ''
    const res = await fetch(url, {
      headers: { 'x-internal-secret': internalSecret },
      signal: AbortSignal.timeout(2_000),
    })
    if (res.ok) {
      const json = await res.json() as { origins: string[] }
      const origins = Array.isArray(json.origins) ? json.origins : []
      _corsCache.set(projectId, { origins, expiresAt: now + CORS_CACHE_TTL_MS })
      return origins
    }
  } catch {
    // DB unavailable or slow — default to open (SDK routes are API-key authed)
  }

  return []
}

/**
 * 🔒 CTO-GRADE SECURITY + DOMAIN ROUTING + CORS
 *
 * 1. Handle CORS (OPTIONS + headers) FIRST
 * 2. Domain routing for project subdomains
 * 3. Apply normal auth middleware
 */

// ✅ PUBLIC ROUTES — landing + pricing + legal + auth aliases (exact match)
const publicRoutes = [
  '/',
  '/pricing',
  '/contact',
  '/login',
  '/signup',
  // Legal — must be reachable by anonymous visitors / regulators.
  '/privacy',
  '/terms',
  '/refund-policy',
]

// ✅ PUBLIC PATH PREFIXES — marketing/SEO pages with dynamic slugs.
// Anonymous visitors (and search-engine crawlers) need to reach these without
// hitting the auth wall. Each entry matches any path under the prefix.
const publicPathPrefixes = [
  '/alternatives',
  '/comparisons',
  '/features',
  '/use-cases',
  '/resources',
  '/docs',
  '/mcp',           // merged into /quickstart; next.config redirects it, but the
                    // prefix stays public so an auth wall can never win the race
  '/quickstart',    // the "how do I start" page — the one route that must never
                    // require a session, since its whole job is to convert people
                    // who do not have one yet
  '/report/',       // shared change reports — access IS the revocable token, no session
  '/.well-known/',  // security.txt etc.
]

// ✅ PUBLIC API ROUTES (Auth endpoints + webhook receivers)
const publicApiRoutes = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/refresh-token',
  '/api/auth/verify-email',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/2fa/verify',
  '/api/auth/sso',
  '/api/auth/platform-google',
  '/api/auth/platform-github',
  '/api/auth/platform-providers',
  '/api/health',
  '/api/github-stars',              // Public read-only GitHub star count for the landing navbar
  '/api/internal/',                 // Internal middleware-to-server endpoints
  '/api/v1/',                       // Project runtime API — API key auth
  '/api/mcp',                       // MCP server — scope='mcp' API key auth at route level.
                                    // No trailing slash: also covers the bare /api/mcp remote
                                    // (Streamable-HTTP) endpoint, which authenticates itself.
  '/api/cli/',                      // @backenly/cli — same scoped x-api-key auth (mcpGuard) at route level
  '/api/cron/',                     // Cron jobs — CRON_SECRET at route level
  '/api/billing/webhook',           // Paddle webhook — signature-verified
  '/api/feedback/feature-request',  // Public form (rate limited at route)
  '/api/feedback/support',          // Public form (rate limited at route)
  '/api/connect/',                  // Legacy provider handshake flow (routes self-authenticate; flagged for removal)
]

// Production: strict allowlist. Development: also accept localhost via a
// separate check below in handleCORS. We never want localhost in prod allow-list.
const ALLOWED_ORIGINS_PROD = [
  'https://backenly.com',
  'https://www.backenly.com',
]
const ALLOWED_ORIGINS_DEV = [
  ...ALLOWED_ORIGINS_PROD,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]

const SDK_ROUTE_PREFIX = '/api/v1/'

async function handleCORS(request: NextRequest): Promise<NextResponse | null> {
  const originHeader = request.headers.get('origin')
  const { pathname } = request.nextUrl

  if (!pathname.startsWith('/api') || !originHeader) {
    return null
  }

  // MCP surface owns its CORS end-to-end (route-level optionsResponse/withCors
  // in lib/mcp/cors.ts). It is permissive by design — auth is via x-api-key,
  // not cookies, so there is no CSRF surface to lock down per-origin. Returning
  // null here keeps this middleware from short-circuiting the OPTIONS preflight
  // with a headerless 204; instead the request reaches the route's own OPTIONS
  // handler, which emits `access-control-allow-origin: *`. Without this, a
  // browser-based MCP client from any third-party origin fails preflight on the
  // JSON POST endpoints (/tool, /chat, /db/*).
  if (pathname.startsWith('/api/mcp')) {
    return null
  }

  let origin: string | null = originHeader

  if (origin === 'null') return null
  if (origin.includes(',') || origin.includes(' ')) return null

  try {
    const originUrl = new URL(origin)
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return null
  } catch {
    return null
  }

  const isSdkRoute = pathname.startsWith(SDK_ROUTE_PREFIX)
  let allowedOrigin: string | null = null

  if (isSdkRoute) {
    // SDK routes: API-key authenticated. Per-project allowedOrigins, fall back
    // to allow-any if no restrictions configured.
    const projectIdMatch = pathname.match(/^\/api\/v1\/([^/]+)/)
    const projectId = projectIdMatch?.[1]

    if (projectId) {
      const projectOrigins = await getProjectAllowedOrigins(projectId)
      if (projectOrigins.length === 0) {
        allowedOrigin = origin
      } else {
        allowedOrigin = projectOrigins.includes(origin) ? origin : null
        if (!allowedOrigin && process.env.NODE_ENV === 'development' &&
            (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
          allowedOrigin = origin
        }
      }
    } else {
      allowedOrigin = origin
    }
  } else {
    // Platform routes: strict allow-list. Dev includes localhost; prod does not.
    const list = process.env.NODE_ENV === 'production' ? ALLOWED_ORIGINS_PROD : ALLOWED_ORIGINS_DEV
    allowedOrigin = list.includes(origin) ? origin : null
  }

  const allowedHeaders = isSdkRoute
    ? 'Content-Type, Authorization, X-Requested-With, X-User-Id, X-Project-Id, X-User-Token, x-api-key'
    : 'Content-Type, Authorization, X-Requested-With'

  // SDK (/api/v1/*) auth is via x-api-key in headers, NOT cookies. Don't
  // advertise credentials — that prevents browsers from sending cookies and
  // resolves the "wildcard + credentials" inconsistency that was here before.
  const allowCredentials = isSdkRoute ? 'false' : 'true'

  if (request.method === 'OPTIONS') {
    const headers = new Headers()
    if (allowedOrigin) {
      headers.set('Access-Control-Allow-Origin', allowedOrigin)
      headers.set('Vary', 'Origin')
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      headers.set('Access-Control-Allow-Headers', allowedHeaders)
      headers.set('Access-Control-Allow-Credentials', allowCredentials)
      headers.set('Access-Control-Max-Age', '86400')
    }
    return new NextResponse(null, { status: 204, headers })
  }

  if (allowedOrigin) {
    const response = NextResponse.next()
    response.headers.set('Access-Control-Allow-Origin', allowedOrigin)
    response.headers.set('Vary', 'Origin')
    response.headers.set('Access-Control-Allow-Credentials', allowCredentials)
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', allowedHeaders)
    return response
  }

  return null
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // STEP 0: CORS
  const corsResponse = await handleCORS(request)
  if (corsResponse) {
    if (request.method === 'OPTIONS') return corsResponse
  }

  // STEP 1: Domain routing for independent project URLs
  if (shouldUseDomainRouting(request)) {
    const domainResponse = await domainRoutingMiddleware(request)
    if (domainResponse) return domainResponse
  }

  // STEP 2: Static files and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    pathname.includes('.')
  ) {
    return NextResponse.next()
  }

  const applyCorsHeaders = (response: NextResponse) => {
    if (corsResponse && corsResponse.headers.get('Access-Control-Allow-Origin')) {
      response.headers.set('Access-Control-Allow-Origin', corsResponse.headers.get('Access-Control-Allow-Origin')!)
      response.headers.set('Vary', 'Origin')
      const credentials = corsResponse.headers.get('Access-Control-Allow-Credentials')
      if (credentials) response.headers.set('Access-Control-Allow-Credentials', credentials)
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      const allowedHeaders = corsResponse.headers.get('Access-Control-Allow-Headers')
      if (allowedHeaders) response.headers.set('Access-Control-Allow-Headers', allowedHeaders)
    }
    return response
  }

  // ✅ Public API routes
  if (publicApiRoutes.some(route => pathname.startsWith(route))) {
    return applyCorsHeaders(NextResponse.next())
  }

  // ✅ Storage file download — the route does its OWN access control:
  //   • public file        → anyone, no auth
  //   • private + ?token=  → HMAC signed URL
  //   • private, no token  → authenticated project owner (via authenticateRequest)
  // It must be reachable anonymously so public files (avatars, images embedded
  // in apps built on Backenly) actually load. Scoped to the `…/download`
  // sub-path only, so the list / metadata / delete routes stay behind auth.
  if (/^\/api\/storage\/files\/[^/]+\/download$/.test(pathname)) {
    return applyCorsHeaders(NextResponse.next())
  }

  // ✅ Auth pages
  if (pathname.startsWith('/auth')) {
    return applyCorsHeaders(NextResponse.next())
  }

  // ✅ Exact public routes
  const isPublicRoute = publicRoutes.some(route => pathname === route)
  if (isPublicRoute) {
    return applyCorsHeaders(NextResponse.next())
  }

  // ✅ Public path prefixes — marketing/SEO + .well-known
  const isPublicPrefix = publicPathPrefixes.some(prefix => pathname.startsWith(prefix))
  if (isPublicPrefix) {
    return applyCorsHeaders(NextResponse.next())
  }

  // 🔒 Everything else requires auth
  const token = request.cookies.get('auth-token')?.value || extractTokenFromHeader(request.headers.get('authorization'))

  if (!token) {
    if (pathname.startsWith('/api')) {
      const response = NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      )
      return applyCorsHeaders(response)
    }
    const loginUrl = new URL('/auth/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  try {
    const jwtSecretValue = process.env.JWT_SECRET
    if (!jwtSecretValue) {
      console.error('[Middleware] JWT_SECRET not set')
      const response = NextResponse.json(
        { error: 'Server misconfiguration' },
        { status: 503 }
      )
      return applyCorsHeaders(response)
    }
    const secret = new TextEncoder().encode(jwtSecretValue)
    // Pin algorithm — defense against alg=none regressions.
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })

    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('x-user-id', payload.userId as string)
    requestHeaders.set('x-user-email', payload.email as string)
    if (payload.role) {
      requestHeaders.set('x-user-role', payload.role as string)
    }

    // 🔒 ADMIN PROTECTION
    const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL
    const isAdminRoute = pathname.startsWith('/admin') || pathname.startsWith('/api/admin/')
    if (isAdminRoute) {
      const userEmail = payload.email as string
      const userRole = payload.role as string | undefined
      const isFounder = FOUNDER_EMAIL && userEmail?.toLowerCase() === FOUNDER_EMAIL.toLowerCase()
      const isAdminRole = userRole === 'admin' || userRole === 'super_admin'
      if (!isFounder && !isAdminRole) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        return NextResponse.redirect(new URL('/app', request.url))
      }
    }

    // 🔒 Enforce project-specific URLs for workspace routes
    const workspaceRoutes = [
      '/app/monitoring',
      '/app/workflows',
      '/app/connect',
      '/app/users',
      '/app/projects/[projectId]/database',
      '/app/projects/[projectId]/api-builder',
      '/app/projects/[projectId]/auth',
      '/app/projects/[projectId]/inspector',
    ]

    const isWorkspaceRoute = workspaceRoutes.some(route => {
      const normalizedRoute = route.replace('[projectId]', '[a-f0-9-]+')
      const regex = new RegExp(`^${normalizedRoute}`)
      return regex.test(pathname)
    })

    const projectMatch = pathname.match(/\/app\/projects\/([a-f0-9-]+)/)
    const hasProjectInUrl = !!projectMatch

    if (isWorkspaceRoute && !hasProjectInUrl) {
      const dashboardUrl = new URL('/app', request.url)
      return NextResponse.redirect(dashboardUrl)
    }

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    return applyCorsHeaders(response)
  } catch {
    // Invalid token — clear and redirect. Never log the token itself.
    if (pathname.startsWith('/api')) {
      const response = NextResponse.json(
        { error: 'Invalid session', message: 'Please login again' },
        { status: 401 }
      )
      return applyCorsHeaders(response)
    }

    const loginUrl = new URL('/auth/login', request.url)
    loginUrl.searchParams.set('error', 'invalid_session')
    const response = NextResponse.redirect(loginUrl)
    response.cookies.delete('auth-token')
    return response
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
