export const dynamic = 'force-dynamic'

/**
 * GET /api/internal/project-origins?projectId=xxx
 *
 * Internal-only endpoint called by the Edge middleware to fetch a project's
 * allowed CORS origins without giving the middleware direct DB access.
 *
 * Protected by `x-internal-secret: <INTERNAL_API_TOKEN>` (legacy fallback:
 * AI_EXECUTION_TOKEN for one deployment cycle). Compares via timing-safe
 * equality. Never expose this endpoint outside the middleware.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { getInternalToken, safeEqual } from '@/lib/security/internal-token'

export async function GET(request: NextRequest) {
  const provided = request.headers.get('x-internal-secret') ?? ''
  const expected = getInternalToken()
  if (!expected || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const projectId = request.nextUrl.searchParams.get('projectId')
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }

  // Strict UUID format — reject anything else immediately so this endpoint
  // can't be used as an arbitrary projectId enumeration oracle.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    return NextResponse.json({ origins: [] })
  }

  try {
    // Read the canonical surface — `connected_apps` rows where the connection
    // is still active. This is the single source of truth for CORS preflight.
    const rows = await prisma.connectedApp.findMany({
      where: { projectId, isActive: true },
      select: { origin: true },
    })
    return NextResponse.json({ origins: rows.map((r) => r.origin) })
  } catch {
    return NextResponse.json({ origins: [] })
  }
}
