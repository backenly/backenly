export const dynamic = 'force-dynamic'

/**
 * GET  /api/mcp/manifest   — tool catalog discovery.
 * OPTIONS                  — CORS preflight (some hosts make this call).
 *
 * Auth: x-api-key with scope='mcp'. Manifest is project-scoped because
 * future tier-gated tools (enterprise integrations) will vary per project.
 *
 * Stable response shape — additive changes only. Removing a tool bumps
 * MANIFEST_VERSION (major) so the npm package can warn on incompatibility.
 */

import { NextRequest, NextResponse } from 'next/server'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { buildCatalog } from '@/lib/mcp/catalog'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'

const MANIFEST_VERSION = '1.0.0'
const ENDPOINT = '/api/mcp/manifest'

export function OPTIONS() {
  return optionsResponse()
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  const tools = buildCatalog()

  const body = {
    ok: true as const,
    server: {
      name: '@backenly/mcp-server',
      version: MANIFEST_VERSION,
      vendor: 'Backenly',
      projectId: auth.projectId,
    },
    counts: {
      total: tools.length,
      byTier: tools.reduce<Record<string, number>>((acc, t) => {
        acc[t.tier] = (acc[t.tier] ?? 0) + 1
        return acc
      }, {}),
    },
    tools,
  }

  recordMcpCall(
    { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
    { statusCode: 200, mutation: false },
  )

  return withCors(NextResponse.json(body))
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
