/**
 * Schema diff — the pure core of preview branches.
 *
 * Compares two workspace-schema snapshots (main vs branch, both in the
 * lib/typegen schema-reader shape) and classifies every difference by what
 * merging it back would require:
 *
 *   • additive   — new tables / new columns: safe to bring to main
 *   • destructive — dropped tables / dropped columns: only via approval
 *   • altered    — type changes: manual review (a type change on live data
 *                  is a migration, not a merge)
 *
 * Pure function — unit-tested in scripts/verify-branch-diff.ts.
 */

import type { WorkspaceSchema, TableSchema } from '@/lib/typegen/schema-reader'

export interface ColumnDiff {
  name: string
  dataType: string
  isNullable: boolean
}

export interface TableAlteration {
  table: string
  addedColumns: ColumnDiff[]
  droppedColumns: string[]
  typeChanged: Array<{ column: string; from: string; to: string }>
}

export interface SchemaDiff {
  addedTables: TableSchema[]
  droppedTables: string[]
  altered: TableAlteration[]
  identical: boolean
}

export function computeSchemaDiff(main: WorkspaceSchema, branch: WorkspaceSchema): SchemaDiff {
  const mainTables = new Map(main.tables.map((t) => [t.tableName, t]))
  const branchTables = new Map(branch.tables.map((t) => [t.tableName, t]))

  const addedTables: TableSchema[] = []
  const droppedTables: string[] = []
  const altered: TableAlteration[] = []

  for (const [name, bt] of branchTables) {
    const mt = mainTables.get(name)
    if (!mt) {
      addedTables.push(bt)
      continue
    }
    const mainCols = new Map(mt.columns.map((c) => [c.columnName, c]))
    const branchCols = new Map(bt.columns.map((c) => [c.columnName, c]))

    const addedColumns: ColumnDiff[] = []
    const droppedColumns: string[] = []
    const typeChanged: TableAlteration['typeChanged'] = []

    for (const [cn, bc] of branchCols) {
      const mc = mainCols.get(cn)
      if (!mc) {
        addedColumns.push({ name: cn, dataType: bc.dataType, isNullable: bc.isNullable })
      } else if (mc.dataType !== bc.dataType) {
        typeChanged.push({ column: cn, from: mc.dataType, to: bc.dataType })
      }
    }
    for (const cn of mainCols.keys()) {
      if (!branchCols.has(cn)) droppedColumns.push(cn)
    }

    if (addedColumns.length || droppedColumns.length || typeChanged.length) {
      altered.push({ table: name, addedColumns, droppedColumns, typeChanged })
    }
  }

  for (const name of mainTables.keys()) {
    if (!branchTables.has(name)) droppedTables.push(name)
  }

  return {
    addedTables,
    droppedTables: droppedTables.sort(),
    altered,
    identical: addedTables.length === 0 && droppedTables.length === 0 && altered.length === 0,
  }
}

/** Slug rule for branch names — becomes part of a Postgres schema identifier. */
export function validateBranchName(name: string): string | null {
  const slug = name.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(slug)) {
    return 'Branch names are 2-31 chars: letters, numbers, _ or -, starting with a letter.'
  }
  return null
}

export function branchSchemaName(projectId: string, name: string): string {
  return `workspace_${projectId}_br_${name.replace(/-/g, '_')}`
}
