export const dynamic = 'force-dynamic'

/** POST /api/mcp/db/delete — delete rows. Filter REQUIRED + non-empty. */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { dbDelete } from '@/lib/mcp/runtime-db'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMcpBody } from '@/lib/mcp/request-body'

const ENDPOINT = '/api/mcp/db/delete'

const RequestSchema = z.object({
  table: z.string().trim().min(1).max(63),
  filter: z.record(z.unknown()).refine((r) => Object.keys(r).length > 0, 'filter must be non-empty (refusing table-wide DELETE)'),
})

export function OPTIONS() { return optionsResponse() }

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  const body = parseMcpBody(RequestSchema, await request.json().catch(() => null), 'db_delete')
  if (!body.ok) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_delete', error: body.error.code })
    return withCors(NextResponse.json(body.error, { status: 400 }))
  }
  const parsed = body.data

  try {
    const result = await dbDelete(auth.projectId, parsed as Parameters<typeof dbDelete>[1])
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 200, tool: 'db_delete', mutation: true, summary: `Deleted ${result.deleted} row(s) from ${parsed.table}` })
    return withCors(NextResponse.json({ ok: true, ...result }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed'
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_delete', error: msg })
    return withCors(NextResponse.json(dbErrorBody(err, 'DELETE_FAILED'), { status: 400 }))
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
