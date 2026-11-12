/**
 * A unique rule nobody asked for that keeps refusing writes.
 *
 * Production QA (2026-11-09): `orders` was created with a rule that kept
 * `email` unique, which nobody had asked for, so every customer's second order
 * was refused with a conflict. The loop reported nothing.
 *
 * A rule nobody requested is only a problem when it refuses real writes, so
 * this starts from that evidence: a table whose writes were answered with a
 * conflict (409) in the last day. It then names the table's single-column
 * unique rules that the intent ledger does not record as requested. A conflict
 * can also be a reference to a row that does not exist, so the finding says
 * what refused the writes and what the likely rule is, never that it knows.
 *
 * The auth `users` table is left out: its unique email is what sign-up needs.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { nonTableSegmentsParam, tableOfRequestPathSql } from '@/lib/traffic/table-path'

export const REFUSED_WINDOW_MS = 24 * 60 * 60_000
export const REFUSED_MIN = 5

interface TableWrites {
  t: string
  writes: number
  refused: number
}

export interface UniqueRule {
  name: string
  columns: string[]
  isConstraint: boolean
}

/** A name as it must be written in SQL. */
function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/** The statement that removes a rule: its constraint, or the index that is the rule. */
export function dropStatement(table: string, rule: UniqueRule): string {
  return rule.isConstraint
    ? `ALTER TABLE ${ident(table)} DROP CONSTRAINT ${ident(rule.name)};`
    : `DROP INDEX ${ident(rule.name)};`
}

export async function readUniqueRules(projectId: string, table: string): Promise<UniqueRule[]> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ name: string; cols: string[]; is_constraint: boolean }>>(
    `SELECT i.relname AS name,
            array_agg(a.attname::text ORDER BY k.ord) AS cols,
            bool_or(con.oid IS NOT NULL) AS is_constraint
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class i ON i.oid = ix.indexrelid
       LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid AND con.contype = 'u'
       CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND t.relname = $2 AND ix.indisunique AND NOT ix.indisprimary
      GROUP BY i.relname`,
    `workspace_${projectId}`,
    table,
  )
  return rows.map((r) => ({ name: r.name, columns: r.cols, isConstraint: r.is_constraint }))
}

export async function detectRefusedWrites(projectId: string): Promise<RawFinding[]> {
  const since = new Date(Date.now() - REFUSED_WINDOW_MS)
  // Table traffic is recorded as /db/<table> (v1) and /<table> (v2); the
  // bound is given in UTC, as "timestamp" holds UTC without a zone.
  const tables = await prisma.$queryRawUnsafe<TableWrites[]>(
    `SELECT ${tableOfRequestPathSql('path', 3)} AS t,
            count(*)::int AS writes,
            (count(*) FILTER (WHERE "statusCode" = 409))::int AS refused
       FROM api_request_logs
      WHERE "projectId" = $1 AND "branchId" IS NULL
        AND "timestamp" >= ($2::timestamptz AT TIME ZONE 'UTC')
        AND method IN ('POST', 'PUT', 'PATCH')
        AND path NOT LIKE '/api/%'
      GROUP BY 1`,
    projectId,
    since,
    nonTableSegmentsParam(),
  )

  const findings: RawFinding[] = []
  for (const w of tables) {
    if (!w.t || w.t === 'users' || w.refused < REFUSED_MIN) continue
    const rules = await readUniqueRules(projectId, w.t)
    if (rules.length === 0) continue
    const intents = await prisma.schemaIntent.findMany({
      where: { projectId, tableName: w.t },
      select: { columnName: true, requestedUnique: true },
    })
    const asked = new Set(intents.filter((i) => i.requestedUnique === true).map((i) => i.columnName))
    const unasked = rules.filter((r) => r.columns.length === 1 && !asked.has(r.columns[0]))
    for (const rule of unasked) {
      const column = rule.columns[0]
      findings.push({
        type: 'unrequested_unique_refusing_writes',
        severity: w.refused * 2 >= w.writes ? 'critical' : 'warning',
        autoFixable: false,
        details: {
          tableName: w.t,
          columnName: column,
          location: `${w.t}.${column}`,
          ruleName: rule.name,
          refused: w.refused,
          writes: w.writes,
          windowHours: REFUSED_WINDOW_MS / 3_600_000,
          // The table's other rules against duplicates: any of them may have
          // refused some of the writes.
          otherRules: rules.filter((r) => r !== rule).map((r) => r.columns.join(', ')),
          drop: dropStatement(w.t, rule),
        },
      })
    }
  }
  return findings
}
