export const dynamic = 'force-dynamic'

/** POST /api/mcp/db/insert — insert one row. */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { dbInsert } from '@/lib/mcp/runtime-db'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMcpBody } from '@/lib/mcp/request-body'

const ENDPOINT = '/api/mcp/db/insert'

const RequestSchema = z.object({
  table: z.string().trim().min(1).max(63),
  row: z.record(z.unknown()).refine((r) => Object.keys(r).length > 0, 'row must include at least one column'),
})

export function OPTIONS() { return optionsResponse() }

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  const body = parseMcpBody(RequestSchema, await request.json().catch(() => null), 'db_insert')
  if (!body.ok) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_insert', error: body.error.code })
    return withCors(NextResponse.json(body.error, { status: 400 }))
  }
  const parsed = body.data

  try {
    const result = await dbInsert(auth.projectId, parsed as Parameters<typeof dbInsert>[1])
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 200, tool: 'db_insert', mutation: true, summary: `Inserted into ${parsed.table}` })
    return withCors(NextResponse.json({ ok: true, ...result }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Insert failed'
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'db_insert', error: msg })
    return withCors(NextResponse.json(dbErrorBody(err, 'INSERT_FAILED'), { status: 400 }))
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
