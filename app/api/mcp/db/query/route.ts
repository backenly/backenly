export const dynamic = 'force-dynamic'

/**
 * POST /api/mcp/db/query — read rows from a workspace table.
 *
 * Body: { table, filter?, limit?, offset?, orderBy? }
 * Returns: { ok, rows, count }
 *
 * Auth: x-api-key, scope='mcp'. MCP keys are service-role for runtime data,
 * matching how the dashboard's data browser operates on behalf of the owner.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { dbQuery } from '@/lib/mcp/runtime-db'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMcpBody } from '@/lib/mcp/request-body'

const ENDPOINT = '/api/mcp/db/query'

const RequestSchema = z.object({
  table: z.string().trim().min(1).max(63),
  filter: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  orderBy: z.record(z.unknown()).optional(),
})

export function OPTIONS() { return optionsResponse() }

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  const body = parseMcpBody(RequestSchema, await request.json().catch(() => null), 'db_query')
  if (!body.ok) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_query', error: body.error.code })
    return withCors(NextResponse.json(body.error, { status: 400 }))
  }
  const parsed = body.data

  try {
    const result = await dbQuery(auth.projectId, parsed as any)
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 200, tool: 'db_query', mutation: false })
    return withCors(NextResponse.json({ ok: true, ...result }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Query failed'
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_query', error: msg })
    return withCors(NextResponse.json(dbErrorBody(err, 'QUERY_FAILED'), { status: 400 }))
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
