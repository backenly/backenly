export const dynamic = 'force-dynamic'

/**
 * POST /api/mcp/query — run read-only SQL against the project's workspace schema.
 *
 * Body: { sql, limit? }
 * Returns: { ok, rows, rowCount, truncated, fields, redactedColumns, ms }
 *
 * Auth: x-api-key, scope='mcp'. The statement executes as the project's
 * `bkn_ro_` role, so cross-tenant reads are refused by Postgres grants rather
 * than by inspecting the SQL. See lib/mcp/read-query.ts for the full rationale.
 *
 * Unlike `get_database_credentials`, which hands out a connection string and
 * then sees nothing, every call here is recorded — this is the surface that
 * makes agent reads observable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { corsHeaders, optionsResponse } from '@/lib/mcp/cors'
import { dbErrorBody } from '@/lib/db/query-errors'
import { parseMcpBody } from '@/lib/mcp/request-body'
import { runReadQuery, ReadQueryError, MAX_ROWS, DEFAULT_ROWS } from '@/lib/mcp/read-query'

const ENDPOINT = '/api/mcp/query'

const RequestSchema = z.object({
  sql: z.string().trim().min(1).max(20_000),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
})

export function OPTIONS() { return optionsResponse() }

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return withCors(guard.response)
  const auth = guard.auth!

  const body = parseMcpBody(RequestSchema, await request.json().catch(() => null), 'run_query')
  if (!body.ok) {
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'run_query', error: body.error.code })
    return withCors(NextResponse.json(body.error, { status: 400 }))
  }

  try {
    const result = await runReadQuery(auth.projectId, body.data.sql, body.data.limit ?? DEFAULT_ROWS)
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool: 'run_query', mutation: false, summary: `Read ${result.rowCount} row(s)` },
    )
    return withCors(NextResponse.json({ ok: true, ...result }))
  } catch (err) {
    // A refused statement is a contract error the agent can act on, not a
    // database failure — keep the two distinguishable.
    if (err instanceof ReadQueryError) {
      recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'run_query', error: err.code })
      return withCors(NextResponse.json(
        { ok: false, error: err.message, code: err.code, ...(err.hint ? { hint: err.hint } : {}) },
        { status: 400 },
      ))
    }
    const msg = err instanceof Error ? err.message : 'Query failed'
    recordMcpCall({ ...auth, endpoint: ENDPOINT, startedAt }, { statusCode: 400, tool: 'run_query', error: msg })
    return withCors(NextResponse.json(dbErrorBody(err, 'QUERY_FAILED'), { status: 400 }))
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v)
  return res
}
