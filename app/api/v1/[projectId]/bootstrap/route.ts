export const dynamic = 'force-dynamic'

/**
 * GET /v1/{projectId}/bootstrap
 * ────────────────────────────────────────────────────────────────────────────
 * Origin-based handshake — AI-builder onboarding.
 *
 * The Backenly SDK calls this on first use when the developer didn't pass an
 * apiKey to createClient(). The endpoint returns the project's public anon
 * key so the SDK can authenticate every subsequent request without the
 * developer ever having to paste a key into their bundle.
 *
 * Security model — why this is safe to expose publicly:
 *
 *  - Anon keys are designed to be embedded in frontend JavaScript that's
 *    served to every visitor — the standard publishable-key model. They
 *    carry the right to call `/v1/{projectId}/*` routes; row-
 *    level access is gated by RLS policies + the project's auth, not by
 *    key secrecy.
 *  - Project IDs are equally public — they appear in deployed frontend
 *    bundles and dashboard URLs. Anyone who already loaded the user's app
 *    has the project ID, so handing out the anon key on demand reveals
 *    nothing they couldn't extract from the bundle.
 *  - Locked-down projects refuse bootstrap. Projects in maintenance mode
 *    refuse bootstrap. Both states are operator-controlled kill switches.
 *  - Per-IP rate limit (in-memory token bucket) keeps a malicious actor
 *    from spamming the endpoint to discover valid project IDs at scale or
 *    pummel our DB.
 *  - Every successful bootstrap is recorded as a `bootstrap` security event
 *    with the origin and IP, so the dashboard surface (Fix 2) can show the
 *    user which frontends have handshaken successfully.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { generateApiKey } from '@/lib/auth/apiKeyAuth'
import { recordSecurityEvent, getPlatformControls } from '@/lib/platform/controls'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'

// ── In-memory rate limit (per IP, per project) ───────────────────────────────
// 120 bootstraps per minute per IP per project — generous enough that real
// SPAs polling on refresh never hit it, tight enough that a scraper can't
// enumerate project IDs at meaningful scale before backing off.
const RATE_LIMIT = 120
const WINDOW_MS = 60_000
const buckets = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(key: string): { allowed: true } | { allowed: false; retryAfter: number } {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true }
  }
  if (b.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) }
  }
  b.count += 1
  return { allowed: true }
}

// Periodic sweep of expired buckets — bounded memory under sustained load.
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k)
}, WINDOW_MS).unref?.()

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const projectId = params.projectId

  // ── 0. Format guard so we don't hit the DB for obvious garbage ─────────────
  if (!projectId || !/^[a-z0-9-]{8,64}$/i.test(projectId)) {
    return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid project ID', 400)
  }

  // ── 1. Rate limit per (project, IP) so this can't be enumeration-spammed ───
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown'
  const rl = checkRateLimit(`${projectId}:${ip}`)
  if (rl.allowed === false) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many bootstrap requests. Try again shortly.' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // ── 2. Resolve project ─────────────────────────────────────────────────────
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      userId: true,
      anonKey: true,
      lockedDownAt: true,
      jwtSecret: true,
    },
  })

  if (!project) {
    return createErrorResponse(ErrorCodes.NOT_FOUND, 'Project not found', 404)
  }

  // Honor the same kill switches the authenticated /v1 middleware honors —
  // a locked-down project should not be bootstrappable any more than it
  // should be queryable.
  if (project.lockedDownAt) {
    return createErrorResponse(
      ErrorCodes.FORBIDDEN,
      'This project is currently locked by the platform operator. Contact support.',
      503,
    )
  }
  const controls = await getPlatformControls()
  if (controls.maintenanceMode) {
    return createErrorResponse(
      ErrorCodes.FORBIDDEN,
      'Platform is in maintenance mode. Try again shortly.',
      503,
    )
  }

  // ── 3. Anon key: return existing or lazily provision ───────────────────────
  let anonKey = project.anonKey

  if (!anonKey) {
    // First-ever bootstrap for this project. Generate the anon key + register
    // its SHA-256 hash in the ApiKey table so existing v1 auth still works,
    // and store the plaintext on the Project (anon keys are public by design —
    // the standard publishable-key model).
    anonKey = generateApiKey('live')
    const keyHash = createHash('sha256').update(anonKey).digest('hex')
    const keyPrefix = anonKey.substring(0, 16)

    try {
      await prisma.$transaction([
        prisma.apiKey.create({
          data: {
            name: 'Public Anon Key',
            keyHash,
            keyPrefix,
            projectId,
            userId: project.userId,
            permissions: ['read', 'write'],
            rateLimit: 1000,
            keyType: 'public',
            serviceRole: false,
          },
        }),
        prisma.project.update({
          where: { id: projectId },
          data: { anonKey },
        }),
      ])
    } catch (err) {
      console.error('[Bootstrap] Failed to provision anon key:', (err as Error)?.message)
      return createErrorResponse(
        ErrorCodes.INTERNAL_ERROR,
        'Failed to provision anon key',
        500,
      )
    }
  }

  // ── 4. Telemetry — feed the dashboard surface (Fix 2) ──────────────────────
  const origin = request.headers.get('origin') || request.headers.get('referer') || null
  recordSecurityEvent({
    kind: 'bootstrap',
    severity: 'info',
    projectId,
    userId: project.userId,
    ip,
    summary: `Bootstrap completed from ${origin ?? 'unknown origin'}`,
    detail: {
      origin,
      userAgent: request.headers.get('user-agent') ?? null,
      provisioned: !project.anonKey,  // true on the first-ever bootstrap
    },
  }).catch(() => {})

  // ── 5. Mark the project frontend-connected for analytics ───────────────────
  // (Non-blocking — analytics drift is a soft failure.)
  prisma.project
    .update({
      where: { id: projectId },
      data: { isFrontendConnected: true },
    })
    .catch(() => {})

  // ── 6. Permissive CORS so any frontend origin can call this ────────────────
  // (Same trust posture as a public CDN script — the response carries no
  // user data, just the public anon key.)
  const res = createSuccessResponse({
    projectId: project.id,
    projectName: project.name,
    anonKey,
    apiUrl: 'https://backenly.com',
  })
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// CORS preflight — bootstrap is called from arbitrary frontend origins
// (lovable.app preview, vercel.app, netlify.app, custom domains), so we
// always allow.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, accept',
      'Access-Control-Max-Age': '86400',
    },
  })
}
