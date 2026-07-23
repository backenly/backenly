export const dynamic = 'force-dynamic'

/**
 * POST /api/cli/query — the read-only SQL console (`backenly query`).
 *
 * Auth: x-api-key scoped key (same guard as /api/mcp/* and /api/cli/*).
 *
 * Body: { sql: string }
 *
 * Governed reads were never the danger — this endpoint admits exactly one
 * SELECT / WITH / EXPLAIN, validated by lib/sql-console/guard.ts, then executes
 * it through the SAME engine as the MCP `run_query` tool.
 *
 * Write attempts return a structured refusal that routes the statement into
 * the governed change path instead — the escape hatch funnels back into
 * governance rather than around it.
 *
 * ── Why execution moved (2026-07-20) ────────────────────────────────────────
 *
 * This route used to run statements on the APP's own pool — i.e. as
 * `backenly_user`, which can reach every schema in the cluster including the
 * platform's `public` tables. Its only tenant boundary was the deny-list regex
 * in the guard. Write protection was solid (BEGIN READ ONLY is enforced by
 * Postgres), but "cannot read another tenant" rested entirely on out-parsing
 * SQL, and a parser can always be out-argued.
 *
 * Execution now goes through lib/mcp/read-query.ts, which runs as the project's
 * own SELECT-only `bkn_ro_` role. Cross-tenant reads are refused by Postgres
 * grants instead of by pattern matching. The guard is kept in front because its
 * refusals are genuinely useful — it turns a write attempt into a suggestion —
 * but it is now defence in depth rather than the wall.
 *
 * Keeping one engine also means the CLI console and the MCP tool cannot drift
 * apart: two implementations of "read-only SQL" is two things that can disagree
 * about what read-only means.
 */

import { NextRequest, NextResponse } from 'next/server'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { validateConsoleSql, type SqlVerdict } from '@/lib/sql-console/guard'
import { runReadQuery, ReadQueryError } from '@/lib/mcp/read-query'

const ENDPOINT = '/api/cli/query'
/** Preserves the console's original 500-row ceiling. */
const CONSOLE_ROW_CAP = 500

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return guard.response
  const auth = guard.auth!

  let body: { sql?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be { sql }', code: 'BAD_BODY' }, { status: 400 })
  }

  const verdict = validateConsoleSql(body.sql ?? '', auth.projectId)
  if (!verdict.ok) {
    // Explicit extract: this tsconfig doesn't narrow boolean-literal
    // discriminants, so `verdict.reason` fails to typecheck without it.
    const fail = verdict as Extract<SqlVerdict, { ok: false }>
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 422, tool: 'query', mutation: false, error: fail.kind },
    )
    return NextResponse.json(
      {
        ok: false,
        refused: true,
        code: fail.kind.toUpperCase(),
        error: fail.reason,
        suggestion: fail.suggestion ?? null,
      },
      { status: 422 },
    )
  }

  const admitted = verdict as Extract<SqlVerdict, { ok: true }>
  try {
    const result = await runReadQuery(auth.projectId, admitted.sql, CONSOLE_ROW_CAP)

    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, tool: 'query', mutation: false, summary: `${result.rowCount} rows` },
    )
    return NextResponse.json({
      ok: true,
      rows: result.rows,
      fields: result.fields.map((f) => f.name),
      rowCount: result.rowCount,
      // `truncated` is authoritative now: it is derived from asking Postgres for
      // one row beyond the cap, rather than inferred from `rows.length >= cap`,
      // which reported "capped" for a result that happened to land exactly on it.
      capped: result.truncated,
      ...(result.redactedColumns.length ? { redactedColumns: result.redactedColumns } : {}),
      ms: Date.now() - startedAt,
    })
  } catch (e: any) {
    const code = e instanceof ReadQueryError ? e.code : 'QUERY_ERROR'
    recordMcpCall(
      { ...auth, endpoint: ENDPOINT, startedAt },
      { statusCode: 400, tool: 'query', mutation: false, error: String(e?.message ?? '').slice(0, 120) },
    )
    return NextResponse.json(
      {
        ok: false,
        error: e?.message ?? 'Query failed',
        code,
        ...(e instanceof ReadQueryError && e.hint ? { hint: e.hint } : {}),
      },
      { status: 400 },
    )
  }
}
