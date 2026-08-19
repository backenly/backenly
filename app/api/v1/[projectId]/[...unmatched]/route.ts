export const dynamic = 'force-dynamic'

/**
 * JSON 404 for any /api/v1/{projectId}/… path with no Next handler.
 *
 * Static route segments win over a catch-all in the app router, so every real
 * handler under /api/v1/{projectId}/ still takes precedence; this only runs
 * when nothing matched. Without it the request fell through to the app router's
 * page tree and returned the marketing site's HTML to a JSON client.
 *
 * In PRODUCTION nginx sends all /api/v1/* to Express, so the Express terminal
 * handler (server/routes/not-found.ts) is what usually answers — this covers
 * local dev and the proxied sections. Both build the body from
 * lib/api/v1/route-not-found so the two runtimes cannot drift apart.
 */

import { NextRequest, NextResponse } from 'next/server'
import { v1NotFoundBody } from '@/lib/api/v1/route-not-found'

async function handler(
  _request: NextRequest,
  props: { params: Promise<{ projectId: string; unmatched?: string[] }> },
) {
  const params = await props.params
  return NextResponse.json(v1NotFoundBody(params.projectId, params.unmatched ?? []), { status: 404 })
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const HEAD = handler
export const OPTIONS = handler
