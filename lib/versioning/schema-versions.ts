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
  // Read the structure straight from the catalog. This used to round-trip
  // through introspectSchema's human-formatted string and a parser expecting
  // `Table:` / `FK:` lines that format never contained, so every snapshot was
  // stored with ZERO tables — the History panel always rendered empty, and
  // rollback diffed two empty sets and reported "Rolled back ... Dropped 0
  // table(s)" as a success while changing nothing.
  const snapshot: SchemaSnapshot = {
    tables: await captureLiveSchema(projectId),
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
 * Get a specific schema version snapshot, scoped to the project that owns it.
 *
 * `projectId` is REQUIRED, and the lookup filters on it rather than checking
 * afterwards, because this used to be a `findUnique` on the version id alone.
 * A version id is a uuid from a different namespace than a project id, so
 * holding one said nothing about which project it belonged to — and the only
 * caller that could have compared them never saw `projectId`, since this
 * function strips it from what it returns.
 *
 * The result was that `rollbackToVersion` would happily roll a project back to
 * ANOTHER project's snapshot: destroying the caller's schema using a shape it
 * had never had, and disclosing the other tenant's table structure on the way.
 *
 * Scoping the query makes that unrepresentable instead of relying on every
 * caller to remember a check.
 */
export async function getSchemaVersion(
  versionId: string,
  projectId: string,
): Promise<SchemaVersionRecord | null> {
  const record = await prisma.schemaVersion.findFirst({
    where: { id: versionId, projectId },
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
  // Scoped to this project. Unscoped, a caller could name any version in the
  // system and roll their own schema into another tenant's shape.
  const target = await getSchemaVersion(targetVersionId, projectId)
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

  // The live structure, from the catalog — the same reader snapshots use.
  const currentTables = await captureLiveSchema(projectId)

  const targetTables = target.snapshot.tables ?? []
  const targetByName = new Map(targetTables.map(t => [t.name, t]))
  const currentTableNames = new Set(currentTables.map(t => t.name))

  // Drop tables that exist now but didn't exist in the target version. The
  // auth-managed users table and internal `_` tables are never dropped by a
  // rollback: they are platform-provisioned, not part of the versioned shape.
  for (const table of currentTables) {
    if (targetByName.has(table.name)) continue
    if (table.name === 'users' || table.name.startsWith('_')) continue
    const sql = `DROP TABLE IF EXISTS {schema}."${table.name}" CASCADE`
    try {
      await db.executeRaw(sql)
      statements.push(sql)
    } catch (err: any) {
      errors.push(`DROP ${table.name}: ${err.message}`)
    }
  }

  // Drop columns added since the target version on tables both shapes share.
  let droppedColumns = 0
  for (const table of currentTables) {
    const targetTable = targetByName.get(table.name)
    if (!targetTable) continue
    const targetColumns = new Set(targetTable.columns.map(c => c.name))
    // A target snapshot with no recorded columns (legacy empty snapshots)
    // cannot say a column is new; dropping on its say-so would destroy data.
    if (targetColumns.size === 0) continue
    for (const column of table.columns) {
      if (targetColumns.has(column.name)) continue
      const sql = `ALTER TABLE {schema}."${table.name}" DROP COLUMN IF EXISTS "${column.name}"`
      try {
        await db.executeRaw(sql)
        statements.push(sql)
        droppedColumns++
      } catch (err: any) {
        errors.push(`DROP COLUMN ${table.name}.${column.name}: ${err.message}`)
      }
    }
  }

  // What rollback CANNOT do: recreate what was dropped after the snapshot.
  // Claiming "rolled back" while these stayed missing is the lie this module
  // used to tell (its empty snapshots made every diff empty, so it reported
  // success and changed nothing). Name them and fail honestly instead.
  const missingTables = targetTables
    .filter(t => !currentTableNames.has(t.name))
    .map(t => t.name)
  const missingColumns: string[] = []
  for (const targetTable of targetTables) {
    const current = currentTables.find(t => t.name === targetTable.name)
    if (!current) continue
    const currentColumns = new Set(current.columns.map(c => c.name))
    for (const col of targetTable.columns) {
      if (!currentColumns.has(col.name)) missingColumns.push(`${targetTable.name}.${col.name}`)
    }
  }

  const droppedTables = statements.length - droppedColumns
  const did = `Dropped ${droppedTables} table(s) and ${droppedColumns} column(s) added after v${target.versionNum}.`

  if (errors.length > 0) {
    return {
      success: false,
      statementsExecuted: statements,
      message: `Rollback partially failed: ${errors.join('; ')}`,
    }
  }

  if (missingTables.length > 0 || missingColumns.length > 0) {
    const missing = [
      missingTables.length ? `tables ${missingTables.map(t => `"${t}"`).join(', ')}` : '',
      missingColumns.length ? `columns ${missingColumns.join(', ')}` : '',
    ].filter(Boolean).join(' and ')
    return {
      success: false,
      statementsExecuted: statements,
      message:
        `Rollback to v${target.versionNum} is INCOMPLETE. ${did} ` +
        `Not restored (rollback cannot recreate dropped structure): ${missing}. ` +
        `Restore those from a database Snapshot instead.`,
    }
  }

  if (statements.length === 0) {
    return {
      success: true,
      statementsExecuted: [],
      message: `Schema already matches v${target.versionNum} — nothing to roll back.`,
    }
  }

  return {
    success: true,
    statementsExecuted: statements,
    message: `Rolled back to schema v${target.versionNum}. ${did}`,
  }
}

// ─── Internal: capture the live schema from the catalog ───────────────────────

/**
 * The workspace schema's real structure, read from information_schema.
 *
 * This is what gets stored in a snapshot and what rollback diffs against —
 * both sides read the same shape from the same source, so a diff of the two is
 * a statement about the database rather than about a parser.
 */
async function captureLiveSchema(projectId: string): Promise<TableSnapshot[]> {
  const schemaName = `workspace_${projectId}`

  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    schemaName
  )
  if (tables.length === 0) return []

  const columns = await prisma.$queryRawUnsafe<Array<{
    table_name: string
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
  }>>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    schemaName
  )

  // Single-column UNIQUE constraints and unique indexes, for the `unique` flag.
  const uniques = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND i.indisunique AND array_length(i.indkey, 1) = 1`,
    schemaName
  )
  const uniqueSet = new Set(uniques.map(u => `${u.table_name}.${u.column_name}`))

  const foreignKeys = await prisma.$queryRawUnsafe<Array<{
    table_name: string
    column_name: string
    foreign_table: string
    foreign_column: string
  }>>(
    `SELECT tc.table_name,
            kcu.column_name,
            ccu.table_name  AS foreign_table,
            ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
    schemaName
  )

  return tables.map(({ table_name }) => ({
    name: table_name,
    columns: columns
      .filter(c => c.table_name === table_name)
      .map(c => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        unique: uniqueSet.has(`${table_name}.${c.column_name}`),
        ...(c.column_default != null ? { default: c.column_default } : {}),
      })),
    foreignKeys: foreignKeys
      .filter(fk => fk.table_name === table_name)
      .map(fk => ({
        column: fk.column_name,
        referencesTable: fk.foreign_table,
        referencesColumn: fk.foreign_column,
      })),
  }))
}
