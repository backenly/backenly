/**
 * WOULD THIS MERGE FAIL ON PRODUCTION'S ROWS?
 * ===========================================
 * A branch is cut with the shape of production's tables and none of their
 * rows, and it records a foreign key without enforcing it. So a statement
 * that holds for the branch can fail on production: a NOT NULL over rows that
 * are empty there, a UNIQUE over duplicates, a CHECK some rows break, a
 * foreign key whose rows point nowhere, a NOT NULL column added with no
 * default to a table that has rows. On production (2026-11-09) a merge a
 * person approved failed part-way and was recovered; they had approved a
 * change that could not land.
 *
 * Before a merge is put to a person, each such statement is checked against
 * production's rows as they are now, column names followed through the
 * renames before it in the same merge. Every check reads one row at most
 * (LIMIT 1), so none of them scans a large table to the end. A merge that
 * would fail is refused with the reasons, and nothing is asked of anyone.
 * Rows written between the check and the approval can still stop it: the
 * merge is one governed change, recovered if a statement fails.
 */

import { parseMigration, type PlannedAction } from '@/lib/mcp/migration-parser'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { quoteIdent as q } from '@/lib/changes/names'
import { validateBooleanExpression } from '@/lib/db/sql-expression'

type Db = Awaited<ReturnType<typeof workspaceRawClient>>

async function any(db: Db, sql: string, ...params: unknown[]): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM (${sql}) probe LIMIT 1`, ...params)
  return rows.length > 0
}

/**
 * Why merging `statements` would fail on production now, one sentence per
 * statement that would: empty when none would.
 */
export async function mergeWouldFail(projectId: string, statements: string[]): Promise<string[]> {
  if (statements.length === 0) return []
  let planned: PlannedAction[]
  try {
    planned = parseMigration(statements.join(';\n'))
  } catch {
    return []
  }
  const schema = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)

  const tables = new Map<string, { exists: boolean; hasRows: boolean; softDelete: boolean; columns: Set<string> }>()
  const tableFacts = async (table: string) => {
    if (tables.has(table)) return tables.get(table)!
    const cols = await db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      schema, table,
    )
    const exists = cols.length > 0
    const facts = {
      exists,
      hasRows: exists ? await any(db, `SELECT 1 FROM ${q(schema)}.${q(table)}`) : false,
      softDelete: cols.some((c) => c.name === 'deleted_at'),
      columns: new Set(cols.map((c) => c.name)),
    }
    tables.set(table, facts)
    return facts
  }

  // Each table's columns as production names them, followed through the
  // renames before a statement: `null` for a column the merge adds.
  const renamed = new Map<string, Map<string, string | null>>()
  const productionName = (table: string, column: string): string | null | undefined => {
    const map = renamed.get(table)
    if (map?.has(column)) return map.get(column)!
    return column
  }
  const note = (table: string, column: string, was: string | null) => {
    if (!renamed.has(table)) renamed.set(table, new Map())
    renamed.get(table)!.set(column, was)
  }

  const reasons: string[] = []
  const created = new Set<string>()
  for (const step of planned) {
    const a = step.args as Record<string, any>
    const table = typeof a.tableName === 'string' ? a.tableName : null
    if (step.tool === 'create_table' && table) created.add(table)
    if (!table || created.has(table)) continue
    const facts = await tableFacts(table)
    if (!facts.exists) continue

    try {
      switch (step.tool) {
        case 'rename_column': {
          const was = productionName(table, a.oldName)
          note(table, a.newName, was ?? null)
          note(table, a.oldName, null)
          break
        }
        case 'add_column': {
          const col = a.column?.name ?? a.columnName
          if (col) note(table, col, null)
          if (a.column?.nullable === false && a.column?.default === undefined && facts.hasRows) {
            reasons.push(`${table} has rows, and ${col} is added NOT NULL with no default, so they would have no value for it`)
          }
          break
        }
        case 'add_constraint': {
          const type = String(a.constraintType ?? '')
          if (type === 'not_null') {
            const col = productionName(table, a.columnName)
            if (col && (await any(db, `SELECT 1 FROM ${q(schema)}.${q(table)} WHERE ${q(col)} IS NULL`))) {
              reasons.push(`${table} has rows with no value in ${a.columnName}, so it cannot be made NOT NULL`)
            }
          } else if (type === 'unique') {
            const col = productionName(table, a.columnName)
            if (col && (await duplicates(db, schema, table, [col], facts.softDelete))) {
              reasons.push(`${table} has rows that share a value of ${a.columnName}, so it cannot be made UNIQUE`)
            }
          } else if (type === 'check' && typeof a.expression === 'string') {
            // Only over columns production already has under these names.
            const checked = validateBooleanExpression(a.expression, { requireColumn: true })
            if (checked.kind === 'ok' && checked.columns.every((c) => productionName(table, c) === c && facts.columns.has(c))) {
              if (await any(db, `SELECT 1 FROM ${q(schema)}.${q(table)} WHERE NOT (${checked.expression})`)) {
                reasons.push(`${table} has rows that break CHECK (${a.expression})`)
              }
            }
          } else if (type === 'foreign_key' && a.references?.table) {
            const col = productionName(table, a.columnName)
            const parent = String(a.references.table)
            const parentColumn = String(a.references.column ?? 'id')
            const parentFacts = await tableFacts(parent)
            if (col && parentFacts.exists && parentFacts.columns.has(parentColumn) && (await any(
              db,
              `SELECT 1 FROM ${q(schema)}.${q(table)} c
                WHERE c.${q(col)} IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM ${q(schema)}.${q(parent)} p WHERE p.${q(parentColumn)} = c.${q(col)})`,
            ))) {
              reasons.push(`${table} has rows whose ${a.columnName} matches no ${parent}.${parentColumn}, so the foreign key cannot be added`)
            }
          }
          break
        }
        case 'create_index': {
          if (a.unique !== true || !Array.isArray(a.columns)) break
          const cols = (a.columns as string[]).map((c) => productionName(table, c))
          if (cols.every((c): c is string => typeof c === 'string') && (await duplicates(db, schema, table, cols, facts.softDelete))) {
            reasons.push(`${table} has rows that share a value of (${(a.columns as string[]).join(', ')}), so a unique index cannot be built on it`)
          }
          break
        }
        case 'drop_column': {
          note(table, a.columnName, null)
          break
        }
      }
    } catch {
      // A check that cannot run proves nothing either way; the merge's own
      // recovery still stands behind it.
    }
  }
  return reasons
}

/** Whether two live rows share these columns' values (NULLs never conflict). */
async function duplicates(db: Db, schema: string, table: string, columns: string[], softDelete: boolean): Promise<boolean> {
  const list = columns.map(q).join(', ')
  const live = [softDelete ? `"deleted_at" IS NULL` : null, ...columns.map((c) => `${q(c)} IS NOT NULL`)].filter(Boolean).join(' AND ')
  return any(db, `SELECT 1 FROM ${q(schema)}.${q(table)} WHERE ${live} GROUP BY ${list} HAVING count(*) > 1`)
}
