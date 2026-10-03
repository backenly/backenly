export const dynamic = 'force-dynamic'

/** POST /api/mcp/db/delete — delete rows. Filter REQUIRED + non-empty. */

import { NextRequest, NextResponse } from 'next/server'
import { mcpGuard, recordMcpCall, refuseIfReadOnly } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { dbDelete } from '@/lib/mcp/runtime-db'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMcpBody } from '@/lib/mcp/request-body'
import { DB_TOOL_FAILURE_CODE, DB_TOOL_REQUESTS } from '@/lib/mcp/db-tool-requests'

const ENDPOINT = '/api/mcp/db/delete'

export function OPTIONS() { return optionsResponse() }

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  // A read-only key never reaches a write. stdio packages before 0.4.0 and the
  // reliability harness call this route directly, so the check cannot live
  // only in /api/mcp/tool.
  const ro = refuseIfReadOnly(auth, 'db_delete')
  if (ro) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 403, tool: 'db_delete', error: 'READ_ONLY_KEY' })
    return withCors(ro)
  }

  const body = parseMcpBody(DB_TOOL_REQUESTS.db_delete, await request.json().catch(() => null), 'db_delete')
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
    return withCors(NextResponse.json(dbErrorBody(err, DB_TOOL_FAILURE_CODE.db_delete), { status: 400 }))
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
