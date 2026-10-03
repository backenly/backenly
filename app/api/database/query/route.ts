export const dynamic = 'force-dynamic'

/**
 * POST /api/database/query — the dashboard's read-only SQL workspace.
 *
 * Auth: the session cookie, through `withProjectAccess`. That is the only thing
 * this adds over `/api/cli/query`, which does the same job for an API key.
 *
 * ── Why a third route and not a third implementation ────────────────────────
 *
 * The MCP tool, the CLI console and this page all mean the same thing by
 * "read-only SQL", and the only honest way to keep that true is for them to be
 * the same code. Two implementations of read-only is two things that can
 * disagree about what read-only means, and the one that disagrees quietly is
 * the one that matters. So this validates with `lib/sql-console/guard.ts` and
 * executes with `lib/mcp/read-query.ts`, exactly as the CLI route does.
 *
 * ── Where read-only is actually enforced ────────────────────────────────────
 *
 * Not here, and not in the browser. The statement runs as the project's own
 * `bkn_ro_<hex>` role, whose grants are `USAGE` on one schema plus `SELECT`,
 * inside `BEGIN READ ONLY`, with `default_transaction_read_only` set on the
 * role itself. Three independent refusals, all of them PostgreSQL's.
 *
 * The guard in front is defence in depth and better error messages — it turns
 * an attempted UPDATE into a pointer at the governed change path instead of a
 * permission error. It is NOT the boundary, and must never be relied on as
 * one: a parser can always be out-argued, and cross-tenant reads are refused
 * by a missing grant rather than by recognising a schema name.
 *
 * This is the governed answer to Studio's SQL editor. Reads move onto standard
 * SQL because the restriction bought nothing — `get_database_credentials`
 * already hands out a SELECT-only role — while writes stay typed, planned and
 * reversible. AGENTS.md's ban on dashboard SQL writes and DDL is unaffected and
 * is enforced by the role, not by this file.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { validateConsoleSql, type SqlVerdict } from '@/lib/sql-console/guard'
import { runReadQuery, ReadQueryError, MAX_ROWS, DEFAULT_ROWS } from '@/lib/mcp/read-query'

/** Matches the CLI console's ceiling, so the two surfaces agree on "a page". */
const CONSOLE_ROW_CAP = 500

export const POST = withProjectAccess(async (request: NextRequest, { projectId }) => {
  let body: { sql?: string; limit?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be { sql }', code: 'BAD_BODY' }, { status: 400 })
  }

  const verdict = validateConsoleSql(body.sql ?? '', projectId)
  if (!verdict.ok) {
    // `strict` is off in this tsconfig, so TypeScript does not narrow a
    // discriminated union on a boolean literal and `verdict.reason` fails to
    // typecheck without the cast. The sibling CLI route does the same.
    const fail = verdict as Extract<SqlVerdict, { ok: false }>
    // 400, not 403. The statement was understood and refused on its content,
    // and the reason carries a suggestion — a rejected UPDATE names the
    // governed path that would perform it.
    return NextResponse.json(
      { error: fail.reason, code: fail.kind.toUpperCase(), suggestion: fail.suggestion },
      { status: 400 },
    )
  }

  const admitted = verdict as Extract<SqlVerdict, { ok: true }>

  const limit = Math.min(
    Math.max(1, Math.floor(Number(body.limit) || DEFAULT_ROWS)),
    Math.min(CONSOLE_ROW_CAP, MAX_ROWS),
  )

  try {
    const result = await runReadQuery(projectId, admitted.sql, limit)
    return NextResponse.json({
      rows: result.rows,
      rowCount: result.rowCount,
      // Reported rather than inferred from rowCount === limit, which cannot
      // distinguish "exactly this many rows" from "there are more".
      truncated: result.truncated,
      fields: result.fields,
      // Columns whose values were withheld. Saying which ones is the difference
      // between a value that is null and a value nobody may see.
      redactedColumns: result.redactedColumns,
      ms: result.ms,
      limit,
    })
  } catch (error: any) {
    if (error instanceof ReadQueryError) {
      return NextResponse.json({ error: error.message, code: 'QUERY_FAILED' }, { status: 400 })
    }
    // A privilege error that survived the retry is a genuine refusal by
    // PostgreSQL — most often a cross-tenant reference — and is reported as
    // what it is rather than as a server fault.
    if (error?.code === '42501') {
      return NextResponse.json(
        { error: 'Permission denied for that object.', code: 'FORBIDDEN_OBJECT' },
        { status: 403 },
      )
    }
    // Postgres errors carry a code and a usable message; surface them so an
    // operator can fix their own typo rather than reading "Internal error".
    if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
      return NextResponse.json(
        { error: error.message ?? 'Query failed', code: error.code },
        { status: 400 },
      )
    }
    console.error('[database/query POST] failed:', error)
    return NextResponse.json({ error: 'Query failed', code: 'INTERNAL' }, { status: 500 })
  }
})
