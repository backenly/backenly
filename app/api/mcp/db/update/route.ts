export const dynamic = 'force-dynamic'

/** POST /api/mcp/db/update — patch rows. Filter REQUIRED + non-empty. */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall, refuseIfReadOnly } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { dbUpdate } from '@/lib/mcp/runtime-db'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMcpBody } from '@/lib/mcp/request-body'

const ENDPOINT = '/api/mcp/db/update'

const RequestSchema = z.object({
  table: z.string().trim().min(1).max(63),
  filter: z.record(z.unknown()).refine((r) => Object.keys(r).length > 0, 'filter must be non-empty (refusing table-wide UPDATE)'),
  patch: z.record(z.unknown()).refine((r) => Object.keys(r).length > 0, 'patch must include at least one column'),
})

export function OPTIONS() { return optionsResponse() }

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  // A read-only key never reaches a write. stdio calls this route directly,
  // so the check cannot live only in /api/mcp/tool.
  const ro = refuseIfReadOnly(auth, 'db_update')
  if (ro) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 403, tool: 'db_update', error: 'READ_ONLY_KEY' })
    return withCors(ro)
  }

  const body = parseMcpBody(RequestSchema, await request.json().catch(() => null), 'db_update')
  if (!body.ok) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_update', error: body.error.code })
    return withCors(NextResponse.json(body.error, { status: 400 }))
  }
  const parsed = body.data

  try {
    const result = await dbUpdate(auth.projectId, parsed as Parameters<typeof dbUpdate>[1])
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 200, tool: 'db_update', mutation: true, summary: `Updated ${result.updated} row(s) in ${parsed.table}` })
    return withCors(NextResponse.json({ ok: true, ...result }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed'
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_update', error: msg })
    return withCors(NextResponse.json(dbErrorBody(err, 'UPDATE_FAILED'), { status: 400 }))
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
