/**
 * SCHEMA READER
 * =============
 * Reads live column metadata from the workspace PostgreSQL schema
 * (information_schema) for a given projectId, returning everything
 * the type-generator needs to produce accurate TypeScript types.
 */

import { Pool } from 'pg'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export interface ColumnInfo {
  tableName: string
  columnName: string
  /** PostgreSQL data_type (e.g. "text", "integer", "timestamp without time zone") */
  dataType: string
  /** udt_name is more specific for arrays / custom types (e.g. "_text", "uuid") */
  udtName: string
  isNullable: boolean
  columnDefault: string | null
  isPrimaryKey: boolean
  isForeignKey: boolean
  /** Referenced table for FK columns, e.g. "users" */
  referencedTable?: string
  /** Referenced column for FK columns, e.g. "id" */
  referencedColumn?: string
  ordinalPosition: number
}

export interface TableSchema {
  tableName: string
  columns: ColumnInfo[]
}

export interface WorkspaceSchema {
  projectId: string
  schemaName: string
  tables: TableSchema[]
  generatedAt: string
}

// Canonical predicate — a generated TS type must never expose a reserved
// internal table (leading-underscore plumbing, pg_*, information_schema).
function isInternalTable(tableName: string): boolean {
  return isReservedWorkspaceTable(tableName)
}

/**
 * Read the full workspace schema for a project from information_schema.
 * Returns table → column metadata including PK/FK flags.
 */
export async function readWorkspaceSchema(projectId: string): Promise<WorkspaceSchema> {
  const schemaName = `workspace_${projectId}`

  const client = await pool.connect()
  try {
    // ── Columns ──────────────────────────────────────────────────────────────
    const columnsResult = await client.query<{
      table_name: string
      column_name: string
      data_type: string
      udt_name: string
      is_nullable: string
      column_default: string | null
      ordinal_position: number
    }>(
      `SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default,
        c.ordinal_position
      FROM information_schema.columns c
      WHERE c.table_schema = $1
        AND c.table_name NOT LIKE '\\_backenly\\_%'
      ORDER BY c.table_name, c.ordinal_position`,
      [schemaName]
    )

    // ── Primary keys ─────────────────────────────────────────────────────────
    const pkResult = await client.query<{ table_name: string; column_name: string }>(
      `SELECT
        kcu.table_name,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = $1
        AND tc.constraint_type = 'PRIMARY KEY'`,
      [schemaName]
    )

    const pkSet = new Set(
      pkResult.rows.map(r => `${r.table_name}.${r.column_name}`)
    )

    // ── Foreign keys ──────────────────────────────────────────────────────────
    const fkResult = await client.query<{
      table_name: string
      column_name: string
      foreign_table_name: string
      foreign_column_name: string
    }>(
      `SELECT
        kcu.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      WHERE tc.table_schema = $1
        AND tc.constraint_type = 'FOREIGN KEY'`,
      [schemaName]
    )

    const fkMap = new Map<string, { referencedTable: string; referencedColumn: string }>()
    for (const fk of fkResult.rows) {
      fkMap.set(`${fk.table_name}.${fk.column_name}`, {
        referencedTable: fk.foreign_table_name,
        referencedColumn: fk.foreign_column_name,
      })
    }

    // ── Assemble tables ───────────────────────────────────────────────────────
    const tableMap = new Map<string, ColumnInfo[]>()

    for (const row of columnsResult.rows) {
      if (isInternalTable(row.table_name)) continue

      const key = `${row.table_name}.${row.column_name}`
      const fk = fkMap.get(key)

      const col: ColumnInfo = {
        tableName: row.table_name,
        columnName: row.column_name,
        dataType: row.data_type,
        udtName: row.udt_name,
        isNullable: row.is_nullable === 'YES',
        columnDefault: row.column_default,
        isPrimaryKey: pkSet.has(key),
        isForeignKey: !!fk,
        referencedTable: fk?.referencedTable,
        referencedColumn: fk?.referencedColumn,
        ordinalPosition: row.ordinal_position,
      }

      if (!tableMap.has(row.table_name)) {
        tableMap.set(row.table_name, [])
      }
      tableMap.get(row.table_name)!.push(col)
    }

    const tables: TableSchema[] = Array.from(tableMap.entries()).map(
      ([tableName, columns]) => ({ tableName, columns })
    )

    return {
      projectId,
      schemaName,
      tables,
      generatedAt: new Date().toISOString(),
    }
  } finally {
    client.release()
  }
}
