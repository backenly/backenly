/**
 * Rules Backenly guessed from a name, which the request never asked for.
 *
 * Production QA (2026-11-09): `orders.email` had `orders_email_key`, which
 * nobody wrote, so each customer could place one order, ever; and
 * `chk_orders_status` allowed pending, processing, shipped, delivered,
 * cancelled and refunded next to the agent's own CHECK, so together they
 * refused "paid". Both came from Backenly's name rules (lib/db/name-rules.ts):
 * any column with "email", "username" or "slug" in its name got UNIQUE, and a
 * `status` or `payment_status` column on a table named like orders, posts or
 * tasks got a CHECK value list. Since #654 a table declared in SQL is made as
 * written, but the tables made before it still carry these rules, and nothing
 * told their owners.
 *
 * ── What is recognised ─────────────────────────────────────────────────────
 *
 *   unique_by_name       a UNIQUE constraint on one column whose name has
 *                        email, username or slug in it, named as PostgreSQL
 *                        names a UNIQUE written on the column
 *                        (`<table>_<column>_key`), defined `UNIQUE (<column>)`.
 *   check_by_table_name  a CHECK named `chk_<table>_<column>` whose value list
 *                        is exactly, in order, one the rules give or gave that
 *                        column on a table of that name.
 *
 * ── Who asked for it ───────────────────────────────────────────────────────
 *
 * A rule with that name and definition can still have been asked for: a
 * statement that declares `email text UNIQUE` gets the same name. So each one
 * is held to what the platform recorded about the request, best first:
 *
 *   - how the table was made: one declared in SQL since #654 has what its
 *     statement says, and one Backenly designed itself since this check was
 *     added has its rules by design (#654 kept them for a table designed from
 *     a description). Neither is judged (lib/db/declared-tables.ts), except a
 *     designed table's CHECK list that Backenly has since retired because it
 *     refused values Backenly writes there itself;
 *   - the SQL in History (backend_changes.steps, since 2026-10-19): the
 *     statement that made the table or added the column, parsed as
 *     apply_migration parses it, says whether it declared the rule;
 *   - the intent ledger (schema_intents, every column a create_table or, since
 *     2026-11-10, an add_column asked for): `requestedUnique` says whether the
 *     request asked for UNIQUE.
 *
 * With none of them, the exact name and definition are the evidence, and the
 * finding says only that Backenly's name rules added it and nothing recorded
 * shows it was asked for.
 *
 * Never removed automatically: an app may rely on it by now (a unique slug is
 * often wanted). A person removes it from the Autonomy page (DROP_CONSTRAINT,
 * a governed change History restores), or keeps it, and is not asked again.
 * The auth `users` table's email is left out: sign-up depends on it.
 *
 * Read-only: one catalog query per project, and the records only when the
 * catalog shows a candidate (History's, parsed once per new change).
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { checkNameFor, isPostgresConstraintName, statusValueListsFor, uniqueByName } from '@/lib/db/name-rules'
import { howTablesWereMade } from '@/lib/db/declared-tables'
import {
  dropStatementFor,
  guessedConstraintForAgent,
  type GuessEvidence,
  type GuessedRule,
} from '@/lib/core/guessed-constraint-words'

export const GUESSED_CONSTRAINT = 'guessed_constraint' as const

/** A unique or check constraint, as the catalog holds it. */
export interface CatalogConstraint {
  table: string
  name: string
  /** 'u' unique, 'c' check */
  kind: 'u' | 'c'
  columns: string[]
  definition: string
}

/** A constraint whose name and definition are exactly what a name rule made. */
export interface GuessedCandidate {
  table: string
  column: string
  constraintName: string
  rule: GuessedRule
  definition: string
  /** check_by_table_name: the values it allows, in order. */
  values?: string[]
  /**
   * check_by_table_name: a list the rule made before and no longer makes,
   * because it refused values Backenly itself writes there
   * (StatusRule.before in lib/db/name-rules.ts).
   */
  retired?: true
}

/** The quoted string literals of a definition, in order. */
function literalsOf(definition: string): string[] {
  return [...definition.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

/** A column as pg_get_constraintdef writes it. */
function asWrittenByPostgres(column: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(column) ? column : `"${column.replace(/"/g, '""')}"`
}

/**
 * The `IN (…)` list a single-column CHECK allows, as PostgreSQL renders one:
 * `CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))`, with casts and
 * parentheses that vary by the column's type. Null for any other shape.
 */
export function inListOf(definition: string): { column: string; values: string[] } | null {
  const body = definition
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/::\s*[a-z_][a-z0-9_ ]*(\[\])?/gi, '')
    .replace(/[()\s]+/g, ' ')
    .trim()
  const m = /^CHECK ("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*) = ANY ARRAY\[(?:'', )*''\]$/i.exec(body)
  if (!m) return null
  const column = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]
  return { column, values: literalsOf(definition) }
}

/** Which name rule made this constraint, if its name and definition are exactly that rule's. */
export function guessedCandidate(c: CatalogConstraint): GuessedCandidate | null {
  if (c.columns.length !== 1) return null
  const column = c.columns[0]
  if (c.kind === 'u') {
    if (!uniqueByName(column)) return null
    if (!isPostgresConstraintName(c.name, c.table, column, 'key')) return null
    if (c.definition !== `UNIQUE (${asWrittenByPostgres(column)})`) return null
    return { table: c.table, column, constraintName: c.name, rule: 'unique_by_name', definition: c.definition }
  }
  const lists = statusValueListsFor(c.table, column)
  if (lists.length === 0 || c.name !== checkNameFor(c.table, column)) return null
  const list = inListOf(c.definition)
  if (!list || list.column !== column) return null
  const made = lists.findIndex((l) => l.length === list.values.length && l.every((v, i) => v === list.values[i]))
  if (made < 0) return null
  return {
    table: c.table,
    column,
    constraintName: c.name,
    rule: 'check_by_table_name',
    definition: c.definition,
    values: [...lists[made]],
    ...(made > 0 ? { retired: true } : {}),
  }
}

/** Every unique and check constraint in the project's own schema. */
async function readConstraints(projectId: string): Promise<CatalogConstraint[]> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ table_name: string; name: string; kind: string; columns: string[]; definition: string }>>(
    `SELECT t.relname AS table_name,
            c.conname AS name,
            c.contype::text AS kind,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t     ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.contype IN ('u', 'c') AND t.relkind IN ('r', 'p')`,
    `workspace_${projectId}`,
  )
  return rows.map((r) => ({
    table: r.table_name,
    name: r.name,
    kind: r.kind === 'u' ? 'u' : 'c',
    columns: r.columns ?? [],
    definition: r.definition,
  }))
}

// ── What the platform recorded about each table's request ─────────────────────

/** What History's SQL says about one table, as of the statement that last made it. */
export interface RecordedSql {
  /**
   * What last made the table, as History has it: SQL, or Backenly's own typed
   * create. Null when History has only later statements on it.
   */
  madeBy: 'sql' | 'typed' | null
  /** Columns a recorded SQL statement made or added. */
  sqlColumns: Set<string>
  /** Columns a recorded SQL statement declared UNIQUE on their own. */
  declaredUnique: Set<string>
  /** Value lists recorded SQL declared in a CHECK on one column. */
  declaredChecks: Map<string, string[][]>
}

function emptyRecord(madeBy: RecordedSql['madeBy']): RecordedSql {
  return { madeBy, sqlColumns: new Set(), declaredUnique: new Set(), declaredChecks: new Map() }
}

/**
 * Read History's steps, oldest first, into what each table's SQL declared.
 * A table made again starts over. A statement today's parser cannot read
 * tells nothing, as if it were not kept.
 */
export async function recordedRequests(
  steps: Array<{ tool?: unknown; statement?: unknown; ok?: unknown }>,
): Promise<Map<string, RecordedSql>> {
  const { parseMigration } = await import('@/lib/mcp/migration-parser')
  const tables = new Map<string, RecordedSql>()
  const recordOf = (table: string) => {
    let r = tables.get(table)
    if (!r) {
      r = emptyRecord(null)
      tables.set(table, r)
    }
    return r
  }
  for (const step of steps) {
    const tool = typeof step.tool === 'string' ? step.tool : ''
    const statement = typeof step.statement === 'string' ? step.statement : ''
    // A step that failed made nothing. One statement's later steps
    // (`<statement> → CHECK (…)`) are read with the statement itself.
    if (!statement || step.ok === false || statement.includes(' → ')) continue
    // Backenly's own typed create: "CREATE_TABLE orders".
    if (tool === 'CREATE_TABLE') {
      const table = statement.split(/\s+/)[1]
      if (table) tables.set(table.toLowerCase(), emptyRecord('typed'))
      continue
    }
    if (tool !== 'create_table' && tool !== 'add_column' && tool !== 'add_constraint') continue
    let planned: Array<{ tool: string; args: Record<string, unknown> }>
    try {
      planned = parseMigration(statement)
    } catch {
      continue
    }
    for (const p of planned) {
      // The executor makes a table under its lowercased name.
      const table = typeof p.args.tableName === 'string' ? p.args.tableName.toLowerCase() : ''
      if (!table) continue
      if (p.tool === 'create_table') {
        const r = emptyRecord('sql')
        tables.set(table, r)
        for (const col of (p.args.columns as Array<Record<string, unknown>>) ?? []) {
          const name = typeof col?.name === 'string' ? col.name : ''
          if (!name) continue
          r.sqlColumns.add(name)
          if (col.unique === true) r.declaredUnique.add(name)
        }
      } else if (p.tool === 'add_column') {
        const col = (p.args.column ?? {}) as Record<string, unknown>
        const name = typeof col.name === 'string' ? col.name : ''
        if (!name) continue
        const r = recordOf(table)
        r.sqlColumns.add(name)
        if (col.unique === true) r.declaredUnique.add(name)
      } else if (p.tool === 'add_constraint') {
        const columns = Array.isArray(p.args.columns) ? (p.args.columns as unknown[]).filter((c): c is string => typeof c === 'string') : []
        if (columns.length !== 1) continue
        const r = recordOf(table)
        if (p.args.constraintType === 'unique') r.declaredUnique.add(columns[0])
        if (p.args.constraintType === 'check' && typeof p.args.expression === 'string') {
          const values = literalsOf(p.args.expression)
          if (values.length) r.declaredChecks.set(columns[0], [...(r.declaredChecks.get(columns[0]) ?? []), values])
        }
      }
    }
  }
  return tables
}

/**
 * What History says about each table's request, read again only when History
 * has a new change: the probe runs every minute, and a project whose owner has
 * not decided yet would otherwise be re-read and re-parsed each time.
 */
const recordedCache = new Map<string, { version: string; tables: Map<string, RecordedSql> }>()

async function recordedRequestsOf(projectId: string): Promise<Map<string, RecordedSql>> {
  // A change's steps are written when it completes, so the newest completion
  // counts as much as the newest change.
  const latest = await prisma.backendChange.aggregate({ where: { projectId }, _max: { seq: true, completedAt: true } })
  const version = `${latest._max.seq ?? 0}:${latest._max.completedAt?.getTime() ?? 0}`
  const hit = recordedCache.get(projectId)
  if (hit && hit.version === version) return hit.tables
  const tables = await recordedRequests(await historySteps(projectId))
  recordedCache.delete(projectId)
  recordedCache.set(projectId, { version, tables })
  if (recordedCache.size > 500) recordedCache.delete(recordedCache.keys().next().value as string)
  return tables
}

/** History's steps that can make a table or a column, oldest first: one query, matched in the database. */
async function historySteps(projectId: string): Promise<Array<{ tool?: unknown; statement?: unknown; ok?: unknown }>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ steps: unknown }>>(
    `SELECT steps FROM backend_changes
      WHERE "projectId" = $1 AND kind = 'change' AND steps IS NOT NULL
        AND steps::text ~* '(create|alter)[ _]table|create_table|add_column|add_constraint'
      ORDER BY seq ASC`,
    projectId,
  )
  return rows.flatMap((r) => (Array.isArray(r.steps) ? (r.steps as Array<{ tool?: unknown; statement?: unknown; ok?: unknown }>) : []))
}

/**
 * Rules a person already decided on, which are not raised again: one they
 * kept (dismissed, as against withdrawn by Backenly when it went away), one
 * they removed (auto_fixed: if it is back, someone restored it), and one whose
 * removal they undid.
 */
async function decidedRules(projectId: string): Promise<Set<string>> {
  const rows = await prisma.healthFinding.findMany({
    where: { projectId, type: GUESSED_CONSTRAINT, status: { in: ['dismissed', 'auto_fixed', 'open', 'pending_approval'] } },
    select: { status: true, details: true },
  })
  const decided = new Set<string>()
  for (const r of rows) {
    const d = (r.details ?? {}) as Record<string, unknown>
    const byPerson =
      (r.status === 'dismissed' && !d.withdrawnBy) || r.status === 'auto_fixed' || typeof d.rolledBackAt === 'string'
    if (byPerson && typeof d.tableName === 'string' && typeof d.constraintName === 'string') {
      decided.add(`${d.tableName}.${d.constraintName}`)
    }
  }
  return decided
}

/** Values `own` allows that `ours` refuses, in `own`'s order. */
function refusedOnly(own: string[], ours: string[]): string[] {
  const allowed = new Set(ours)
  return own.filter((v, i) => !allowed.has(v) && own.indexOf(v) === i)
}

export async function detectGuessedConstraints(projectId: string): Promise<RawFinding[]> {
  const constraints = await readConstraints(projectId)
  const candidates = constraints
    .map(guessedCandidate)
    .filter((c): c is GuessedCandidate => c !== null)
    // Backenly's own tables, and the auth table's email, which sign-up depends on.
    .filter((c) => !c.table.startsWith('_') && !(c.table === 'users' && c.column === 'email'))
  if (candidates.length === 0) return []

  const tables = [...new Set(candidates.map((c) => c.table))]
  const [made, intents, decided, sql] = await Promise.all([
    howTablesWereMade(projectId),
    prisma.schemaIntent.findMany({
      where: { projectId, tableName: { in: tables } },
      select: { tableName: true, columnName: true, requestedUnique: true, source: true },
    }),
    decidedRules(projectId),
    recordedRequestsOf(projectId),
  ])
  const intentOf = (t: string, c: string) => intents.find((i) => i.tableName === t && i.columnName === c)
  const tableHasIntents = (t: string) => intents.some((i) => i.tableName === t)

  const findings: RawFinding[] = []
  for (const c of candidates) {
    const how = made.get(c.table)
    const intent = intentOf(c.table, c.column)
    const recorded = sql.get(c.table)
    if (decided.has(`${c.table}.${c.constraintName}`)) continue

    // A table made since the marks were kept: declared in SQL (#654), so its
    // rules are what the statement said; or designed by Backenly, so they are
    // its design. The one exception is a column added later by an add_column
    // that inferred UNIQUE, which the ledger records as such. A design's CHECK
    // whose list Backenly has since retired is not its design any more: the
    // list refused values Backenly writes there itself.
    if (how === 'designed_by_backenly' && !c.retired) continue
    if (how === 'declared_in_sql' && !(c.rule === 'unique_by_name' && intent?.source === 'add_column' && intent.requestedUnique !== true)) continue

    let evidence: GuessEvidence
    if (c.rule === 'unique_by_name') {
      if (intent?.requestedUnique === true || recorded?.declaredUnique.has(c.column)) continue
      evidence = recorded?.sqlColumns.has(c.column) ? 'sql' : intent || recorded?.madeBy === 'typed' ? 'request' : 'unrecorded'
    } else {
      const declared = recorded?.declaredChecks.get(c.column) ?? []
      if (declared.some((list) => list.length === c.values!.length && list.every((v, i) => v === c.values![i]))) continue
      evidence = recorded?.madeBy === 'sql' ? 'sql' : recorded?.madeBy === 'typed' || tableHasIntents(c.table) ? 'request' : 'unrecorded'
    }

    // The table's other CHECKs on the same column: what they allow and this one refuses.
    const refuses =
      c.rule === 'check_by_table_name'
        ? constraints
            .filter((o) => o.kind === 'c' && o.table === c.table && o.name !== c.constraintName && o.columns.length === 1 && o.columns[0] === c.column)
            .flatMap((o) => {
              const list = inListOf(o.definition)
              return list ? refusedOnly(list.values, c.values!) : []
            })
        : []

    const details: Record<string, unknown> = {
      tableName: c.table,
      columnName: c.column,
      constraintName: c.constraintName,
      location: `${c.table}.${c.constraintName}`,
      rule: c.rule,
      evidence,
      definition: c.definition,
      ...(c.values ? { allowedValues: c.values } : {}),
      ...(refuses.length ? { refusesAllowedByOwnCheck: [...new Set(refuses)] } : {}),
      drop: dropStatementFor({ tableName: c.table, constraintName: c.constraintName }),
    }
    details.reason = guessedConstraintForAgent(details)
    findings.push({ type: GUESSED_CONSTRAINT, severity: 'warning', autoFixable: false, details })
  }
  return findings
}
