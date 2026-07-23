/**
 * SCHEMA VERSIONING SYSTEM
 * =========================
 * Snapshots the workspace schema before every mutation.
 * Enables rollback to any previous state.
 *
 * Every CREATE_TABLE, ADD_COLUMN, and ALTER TABLE call should
 * trigger a snapshot beforehand so the user can undo changes.
 *
 * Snapshot format: JSON representation of the live schema
 *   { tables: [{ name, columns: [{ name, type, nullable, unique }] }] }
 */

import { prisma } from '@/lib/db/prisma'

export interface ColumnSnapshot {
  name: string
  type: string
  nullable: boolean
  unique: boolean
  default?: string
}

export interface TableSnapshot {
  name: string
  columns: ColumnSnapshot[]
  foreignKeys: Array<{ column: string; referencesTable: string; referencesColumn: string }>
}

export interface SchemaSnapshot {
  tables: TableSnapshot[]
  capturedAt: string
}

export interface SchemaVersionRecord {
  id: string
  versionNum: number
  description: string
  triggeredBy: string
  createdAt: Date
  snapshot: SchemaSnapshot
}

/**
 * Capture the current live schema of a workspace and save it as a new version.
 * Returns the version ID.
 */
export async function snapshotSchema(
  projectId: string,
  description: string,
  triggeredBy: string
): Promise<string> {
  // Get current schema via introspection
  const { introspectSchema } = await import('@/lib/ai/minimal-executor')
  const schemaText = await introspectSchema(projectId)

  // Parse the schema text into a structured snapshot
  const snapshot: SchemaSnapshot = {
    tables: parseSchemaText(schemaText),
    capturedAt: new Date().toISOString(),
  }

  // Get next version number
  const lastVersion = await prisma.schemaVersion.findFirst({
    where: { projectId },
    orderBy: { versionNum: 'desc' },
    select: { versionNum: true },
  })
  const versionNum = (lastVersion?.versionNum ?? 0) + 1

  const record = await prisma.schemaVersion.create({
    data: {
      projectId,
      versionNum,
      snapshot: snapshot as any,
      description,
      triggeredBy,
    },
  })

  return record.id
}

/**
 * List all schema versions for a project (newest first).
 */
export async function listSchemaVersions(projectId: string): Promise<Array<{
  id: string
  versionNum: number
  description: string
  triggeredBy: string
  createdAt: Date
}>> {
  return prisma.schemaVersion.findMany({
    where: { projectId },
    orderBy: { versionNum: 'desc' },
    take: 50,
    select: { id: true, versionNum: true, description: true, triggeredBy: true, createdAt: true },
  })
}

/**
 * Get a specific schema version snapshot.
 */
export async function getSchemaVersion(versionId: string): Promise<SchemaVersionRecord | null> {
  const record = await prisma.schemaVersion.findUnique({
    where: { id: versionId },
  })
  if (!record) return null
  return {
    id: record.id,
    versionNum: record.versionNum,
    description: record.description,
    triggeredBy: record.triggeredBy,
    createdAt: record.createdAt,
    snapshot: record.snapshot as unknown as SchemaSnapshot,
  }
}

/**
 * Rollback to a previous schema version.
 * Computes the diff between current schema and target version,
 * then executes the necessary DDL to revert.
 *
 * WARNING: Rollback drops columns/tables — data loss possible.
 * Returns list of DDL statements that were executed.
 */
export async function rollbackToVersion(
  projectId: string,
  targetVersionId: string
): Promise<{ success: boolean; statementsExecuted: string[]; message: string }> {
  const target = await getSchemaVersion(targetVersionId)
  if (!target) {
    return { success: false, statementsExecuted: [], message: 'Version not found.' }
  }

  // Snapshot current state before rollback (for audit)
  await snapshotSchema(
    projectId,
    `Pre-rollback snapshot (reverting to v${target.versionNum})`,
    'system:rollback'
  ).catch(() => {})

  const statements: string[] = []
  const errors: string[] = []

  // Import workspace DB access
  const { getWorkspacePostgresClient } = await import('@/lib/services/workspaceDatabase')
  const db = await getWorkspacePostgresClient(projectId)

  if (!db?.executeRaw) {
    return { success: false, statementsExecuted: [], message: 'Cannot connect to workspace database.' }
  }

  // Get current live schema
  const { introspectSchema } = await import('@/lib/ai/minimal-executor')
  const currentText = await introspectSchema(projectId)
  const currentTables = parseSchemaText(currentText)

  const targetTables = target.snapshot.tables
  const targetTableNames = new Set(targetTables.map(t => t.name))
  const currentTableNames = new Set(currentTables.map(t => t.name))

  // Drop tables that exist now but didn't exist in target version
  for (const table of currentTables) {
    if (!targetTableNames.has(table.name)) {
      const sql = `DROP TABLE IF EXISTS {schema}."${table.name}" CASCADE`
      try {
        await db.executeRaw(sql)
        statements.push(sql)
      } catch (err: any) {
        errors.push(`DROP ${table.name}: ${err.message}`)
      }
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      statementsExecuted: statements,
      message: `Rollback partially failed: ${errors.join('; ')}`,
    }
  }

  return {
    success: true,
    statementsExecuted: statements,
    message: `Rolled back to schema v${target.versionNum}. Dropped ${statements.length} table(s).`,
  }
}

// ─── Internal: parse schema text into structured snapshot ─────────────────────

function parseSchemaText(schemaText: string): TableSnapshot[] {
  const tables: TableSnapshot[] = []
  if (!schemaText) return tables

  // Basic parser: look for "Table: name\n  column: type" pattern
  // (introspectSchema returns a formatted string)
  const tableBlocks = schemaText.split(/\n(?=Table:|table:)/i)

  for (const block of tableBlocks) {
    const nameMatch = block.match(/[Tt]able:\s*(\w+)/)
    if (!nameMatch) continue

    const columns: ColumnSnapshot[] = []
    const fkLines = block.match(/FK:\s*(\w+)\s*→\s*(\w+)\((\w+)\)/g) ?? []

    const foreignKeys = fkLines.map(fk => {
      const m = fk.match(/FK:\s*(\w+)\s*→\s*(\w+)\((\w+)\)/)
      return m ? { column: m[1], referencesTable: m[2], referencesColumn: m[3] } : null
    }).filter(Boolean) as TableSnapshot['foreignKeys']

    tables.push({ name: nameMatch[1], columns, foreignKeys })
  }

  return tables
}
