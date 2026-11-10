/**
 * The column renames a branch made, read from its statements.
 *
 * A diff of two catalogs sees only names. `RENAME COLUMN email TO
 * legacy_email` reads as a new, empty `legacy_email` and a dropped `email`;
 * when a later statement adds `email` again, it reads as `legacy_email` alone.
 * Production QA (2026-11-09) read "orders: +legacy_email, +legacy_status" for
 * a merge that moved two populated columns aside and recreated them.
 */

import { parseMigration } from '@/lib/mcp/migration-parser'
import type { ColumnDiff, SchemaDiff, TableAlteration } from './diff'

interface SnapshotColumn { columnName: string; dataType: string; isNullable: boolean }
interface Snapshot { tables: Array<{ tableName: string; columns: SnapshotColumn[] }> }

export interface ColumnRename {
  /** Its name on production. */
  from: string
  /** Its name after the branch's statements, followed through later renames. */
  to: string
  /** Whether a later statement added a new column under the old name. */
  readded: boolean
}

/** Per table, the columns its statements renamed, in order. */
export function renamesIn(statements: string[]): Map<string, ColumnRename[]> {
  const out = new Map<string, ColumnRename[]>()
  // Per table, the names that hold a column the statements added: renaming
  // one of those is not a rename of a production column.
  const added = new Map<string, Set<string>>()
  for (const statement of statements) {
    let steps
    try {
      steps = parseMigration(statement)
    } catch {
      continue
    }
    for (const step of steps) {
      const table = typeof step.args.tableName === 'string' ? step.args.tableName : null
      if (!table) continue
      const renames = out.get(table) ?? []
      const fresh = added.get(table) ?? new Set<string>()
      if (step.tool === 'rename_column') {
        const from = String(step.args.oldName)
        const to = String(step.args.newName)
        if (fresh.has(from)) {
          fresh.delete(from)
          fresh.add(to)
        } else {
          const earlier = renames.find((r) => r.to === from)
          if (earlier) earlier.to = to
          else renames.push({ from, to, readded: false })
        }
      } else if (step.tool === 'add_column') {
        const name = (step.args.column as { name?: unknown } | undefined)?.name
        if (typeof name !== 'string') continue
        fresh.add(name)
        const movedAside = renames.find((r) => r.from === name)
        if (movedAside) movedAside.readded = true
      }
      out.set(table, renames)
      added.set(table, fresh)
    }
  }
  for (const [table, renames] of out) if (renames.length === 0) out.delete(table)
  return out
}

/**
 * The diff with each renamed column said as a rename.
 *
 * Only a rename the snapshots bear out counts: production has the old name
 * and the branch has the new one. For those tables the columns are compared
 * through the renames, so a column renamed and then retyped shows as a type
 * change under its new name, and a new column under an old name shows as a
 * new column, never as a retype of the one moved aside.
 */
export function withRenames(diff: SchemaDiff, statements: string[], base: Snapshot, branch: Snapshot): SchemaDiff {
  const renames = renamesIn(statements)
  if (renames.size === 0) return diff
  const altered: TableAlteration[] = diff.altered.map((a) => ({ ...a }))

  for (const [table, candidates] of renames) {
    const was = base.tables.find((t) => t.tableName === table)
    const now = branch.tables.find((t) => t.tableName === table)
    if (!was || !now) continue
    const wasCol = new Map(was.columns.map((c) => [c.columnName, c]))
    const nowCol = new Map(now.columns.map((c) => [c.columnName, c]))
    const real = candidates.filter((r) => wasCol.has(r.from) && nowCol.has(r.to))
    if (real.length === 0) continue

    // Each branch column's production column, if it has one.
    const origin = new Map<string, string>()
    for (const r of real) origin.set(r.to, r.from)
    const movedAside = new Set(real.map((r) => r.from))
    for (const name of nowCol.keys()) {
      if (!origin.has(name) && wasCol.has(name) && !movedAside.has(name)) origin.set(name, name)
    }

    const addedColumns: ColumnDiff[] = []
    const typeChanged: TableAlteration['typeChanged'] = []
    for (const [name, c] of nowCol) {
      const from = origin.get(name)
      if (from === undefined) addedColumns.push({ name, dataType: c.dataType, isNullable: c.isNullable })
      else if (wasCol.get(from)!.dataType !== c.dataType) typeChanged.push({ column: name, from: wasCol.get(from)!.dataType, to: c.dataType })
    }
    const kept = new Set(origin.values())
    const droppedColumns = [...wasCol.keys()].filter((name) => !kept.has(name))
    const entry: TableAlteration = {
      table,
      addedColumns,
      droppedColumns,
      typeChanged,
      renamedColumns: real.map((r) => ({ from: r.from, to: r.to, readded: r.readded && nowCol.has(r.from) })),
    }
    const at = altered.findIndex((a) => a.table === table)
    if (at >= 0) altered[at] = entry
    else altered.push(entry)
  }

  return {
    ...diff,
    altered,
    identical: diff.addedTables.length === 0 && diff.droppedTables.length === 0 && altered.length === 0,
  }
}

/** "email renamed legacy_email; a new email takes its place", for text. */
export function renameText(r: { from: string; to: string; readded?: boolean }): string {
  return `${r.from} renamed ${r.to}${r.readded ? `; a new ${r.from} takes its place` : ''}`
}
