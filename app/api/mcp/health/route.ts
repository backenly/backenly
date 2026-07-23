export const dynamic = 'force-dynamic'

/**
 * GET /api/mcp/health
 *
 * Lightweight liveness + auth check. Returns:
 *   - 200 + { ok, projectId, project, toolCount, brainReachable } when the key
 *     is valid and the platform is up.
 *   - 401/403 when the key is wrong / wrong-scope.
 *
 * Two use cases:
 *
 *   1. The npm package calls this on startup as a sanity check before the
 *      heavier `/api/mcp/manifest` call. A fast 401 here surfaces auth
 *      problems before the user has to wait for a tool catalog payload.
 *
 *   2. The dashboard's "Test connection" button calls this with the user's
 *      session cookie + key id (key validated server-side). Lets the user
 *      verify a freshly-minted key without leaving the page.
 *
 * Deliberately does NOT consume plan quota — health checks should never
 * push someone over their cap.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateMcp, mcpAuthFailureResponse } from '@/lib/mcp/auth'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { buildCatalog } from '@/lib/mcp/catalog'
import { prisma } from '@/lib/db/prisma'

export function OPTIONS() { return optionsResponse() }

export async function GET(request: NextRequest) {
  const auth = await authenticateMcp(request)
  const failure = mcpAuthFailureResponse(auth)
  if (failure) return withCors(failure)

  const project = await prisma.project.findUnique({
    where: { id: auth.projectId! },
    select: { id: true, name: true },
  }).catch(() => null)

  const body = {
    ok: true as const,
    projectId: auth.projectId,
    project: project ? { id: project.id, name: project.name } : null,
    toolCount: buildCatalog().length,
    serverTime: new Date().toISOString(),
  }
  return withCors(NextResponse.json(body))
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
