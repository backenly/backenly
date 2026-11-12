/**
 * WHAT A MERGE DOES, AS ITS APPROVAL CARD SAYS IT
 * ===============================================
 * A merge card listed the branch's statements and nothing else. On production
 * (2026-11-09) a person approved six statements that renamed populated columns
 * of `orders` and added replacements with defaults, which reset every existing
 * order's status to 'pending' and its email to empty; the card said only "Not
 * auto-reversible". And a CREATE TABLE of two columns landed with Backenly's
 * own columns, row-level security and indexes, none of them on the card.
 *
 * So a merge request now says, besides the statements:
 *  - what each statement does to rows already in production: how many rows a
 *    new column's default fills or leaves empty, which values a rename moves
 *    and a drop or retype touches, which new rule must hold for them;
 *  - what Backenly adds to each new table, read from the branch, where the
 *    same executors built it: its own columns, its row-level security policies
 *    and its indexes.
 * Row counts are exact up to COUNT_CAP and read as "more than" past it, so
 * describing a merge never scans a large table.
 */

import { parseMigration, type PlannedAction } from '@/lib/mcp/migration-parser'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { quoteIdent } from '@/lib/changes/names'

/** Rows counted exactly; past this a table reads as "more than" it. */
const COUNT_CAP = 100_000

export interface MergeImpact {
  /** One line per statement that touches rows already in production. */
  existingRows: string[]
  /** One line per new table: what Backenly adds besides its declared columns. */
  added: string[]
}

type Db = Awaited<ReturnType<typeof workspaceRawClient>>

async function rowsIn(db: Db, schema: string, table: string): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${COUNT_CAP + 1}) t`,
    )
    const n = rows[0]?.n ?? 0
    if (n === 0) return null
    return n > COUNT_CAP ? `more than ${COUNT_CAP.toLocaleString('en-US')}` : n.toLocaleString('en-US')
  } catch {
    return null
  }
}

const plural = (count: string, word: string) => `${count} ${word}${count === '1' ? '' : 's'}`

function describeStep(step: PlannedAction, table: string, rows: string): string | null {
  const a = step.args as Record<string, any>
  switch (step.tool) {
    case 'add_column': {
      const col = a.column?.name ?? a.columnName
      if (!col) return null
      if (a.column?.default !== undefined) return `${table}: the ${plural(rows, 'existing row')} get ${a.column.default} in the new column ${col}`
      if (a.column?.nullable === false) return `${table}: adding ${col} as NOT NULL with no default fails, since ${table} has ${plural(rows, 'row')}`
      return `${table}: the new column ${col} is empty for the ${plural(rows, 'existing row')}`
    }
    case 'rename_column':
      return `${table}: ${a.oldName} is renamed ${a.newName}; its values in ${plural(rows, 'row')} move with it, and a client still reading ${a.oldName} stops finding it`
    case 'drop_column':
      return `${table}: ${a.columnName} is dropped; its values in ${plural(rows, 'row')} leave the table and are kept with the change`
    case 'alter_column_type':
      return `${table}: ${a.columnName} becomes ${a.sqlType ?? a.newType}; its values in ${plural(rows, 'row')} are converted, and the values before are kept with the change`
    case 'add_constraint': {
      const kind = String(a.constraintType ?? 'a rule').replace(/_/g, ' ')
      const on = Array.isArray(a.columns) && a.columns.length ? a.columns.join(', ') : a.columnName ?? ''
      if (kind === 'set default' || kind === 'drop default' || kind === 'drop not null') return null
      return `${table}: ${kind}${on ? ` on ${on}` : ''} must hold for the ${plural(rows, 'existing row')}, or the merge stops there`
    }
    case 'create_index':
      return a.unique === true
        ? `${table}: a unique index on ${(a.columns ?? []).join(', ')} must hold for the ${plural(rows, 'existing row')}, or the merge stops there`
        : `${table}: an index is built over its ${plural(rows, 'row')}`
    case 'drop_constraint':
    case 'drop_index':
      return `${table}: rows the dropped rule refused can be written from then on`
    default:
      return null
  }
}

/**
 * What merging `statements` does, described from production's rows and from
 * what the branch built for its new tables.
 */
export async function mergeImpact(projectId: string, branchSchema: string, statements: string[]): Promise<MergeImpact> {
  const impact: MergeImpact = { existingRows: [], added: [] }
  if (statements.length === 0) return impact
  let planned: PlannedAction[]
  try {
    planned = parseMigration(statements.join(';\n'))
  } catch {
    return impact
  }
  const main = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)

  const created = new Map<string, Set<string>>()
  for (const step of planned) {
    if (step.tool !== 'create_table') continue
    const declared = new Set<string>(((step.args.columns as Array<{ name: string }>) ?? []).map((c) => c.name))
    created.set(String(step.args.tableName), declared)
  }

  // Rows already in production, for the tables the statements change.
  const counted = new Map<string, string | null>()
  for (const step of planned) {
    const table = typeof step.args.tableName === 'string' ? step.args.tableName : null
    if (!table || created.has(table)) continue
    if (!counted.has(table)) counted.set(table, await rowsIn(db, main, table))
    const rows = counted.get(table)
    if (!rows) continue
    const line = describeStep(step, table, rows)
    if (line) impact.existingRows.push(line)
  }

  // What the branch built for each new table besides the declared columns.
  for (const [table, declared] of created) {
    try {
      const [columns, policies, indexes] = await Promise.all([
        db.$queryRawUnsafe<Array<{ name: string }>>(
          `SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          branchSchema, table,
        ),
        db.$queryRawUnsafe<Array<{ cmd: string }>>(
          `SELECT cmd FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
          branchSchema, table,
        ),
        db.$queryRawUnsafe<Array<{ def: string }>>(
          `SELECT pg_get_indexdef(ix.indexrelid) AS def
             FROM pg_index ix
             JOIN pg_class t ON t.oid = ix.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary`,
          branchSchema, table,
        ),
      ])
      const extra = columns.map((c) => c.name).filter((c) => !declared.has(c))
      const parts: string[] = []
      if (extra.length) parts.push(`the columns ${extra.map((c) => (/^[a-z_][a-z0-9_]*$/.test(c) ? c : `"${c}"`)).join(', ')}`)
      if (policies.length) {
        const cmds = [...new Set(policies.map((p) => p.cmd))].join(', ')
        parts.push(`row-level security (${policies.length === 1 ? '1 policy' : `${policies.length} policies`}: ${cmds})`)
      }
      if (indexes.length) {
        const on = indexes
          .map((i) => /\(([^)]*)\)\s*(WHERE.*)?$/.exec(i.def)?.[1] ?? '')
          .filter(Boolean)
          .map((cols) => (cols.includes(',') ? `(${cols})` : cols))
        parts.push(`${indexes.length === 1 ? 'an index' : 'indexes'} on ${on.join(', ')}`)
      }
      if (parts.length) impact.added.push(`${table}: ${parts.join(', ')}`)
    } catch {
      // A new table the branch cannot be read for is listed by its statement alone.
    }
  }
  return impact
}

/** The impact as the lines a merge card shows before its statements. */
export function impactText(impact: MergeImpact): string {
  const out: string[] = []
  if (impact.existingRows.length) {
    out.push('What it does to rows already in production:', ...impact.existingRows.map((l) => `• ${l}`))
  }
  if (impact.added.length) {
    out.push('What Backenly adds to the new tables:', ...impact.added.map((l) => `• ${l}`))
  }
  return out.join('\n')
}
