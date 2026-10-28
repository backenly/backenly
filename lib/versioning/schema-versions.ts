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
import { workspaceRawClient } from '@/lib/data-plane/regional'

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
 * Retired: rolling back is per change, through the change ledger.
 *
 * This used to diff the live schema against a SchemaVersion and run
 * `DROP TABLE … CASCADE` on every table newer than it and `DROP COLUMN` on every
 * newer column: statement by statement, outside any transaction, destroying
 * the rows and values written since with nothing kept, and unable to bring
 * back anything dropped since (it said so, and stopped there). It could only
 * destroy, under the name "rollback".
 *
 * Restoring now goes through lib/changes/recovery.ts: one change at a time,
 * proven first, in one transaction, keeping what it removes in a vault, and
 * verified against the restore point afterwards. It runs automatically only
 * when that is lossless and the change failed its checks; otherwise a person
 * decides, from History or by approving a request. This function
 * stays exported so nothing that still imports it can reach the old behaviour;
 * it changes nothing and says where restoring lives.
 */
export async function rollbackToVersion(
  projectId: string,
  targetVersionId: string,
): Promise<{ success: boolean; statementsExecuted: string[]; message: string }> {
  // Still scoped: another project's version is not found, never described.
  const target = await getSchemaVersion(targetVersionId, projectId)
  if (!target) {
    return { success: false, statementsExecuted: [], message: 'Version not found.' }
  }
  return {
    success: false,
    statementsExecuted: [],
    message:
      `Schema v${target.versionNum} cannot be restored wholesale. Each change since then is recorded with a ` +
      'restore point: a person goes back from History, one change at a time or with Restore to this point, ' +
      'each checked first and verified afterwards. Nothing was changed.',
  }
}

// ─── Internal: capture the live schema from the catalog ───────────────────────

/**
 * The workspace schema's real structure, read from information_schema.
 *
 * This is what gets stored in a snapshot: the shape read from the catalog,
 * so two snapshots compared are a statement about the database rather than
 * about a parser.
 *
 * Read in the project's own region (lib/data-plane/regional.ts). A regional
 * project's schema exists only in its region's database: read from the home
 * one it has no tables, so every snapshot would be empty. A region this
 * process cannot reach is refused, never read as empty.
 */
async function captureLiveSchema(projectId: string): Promise<TableSnapshot[]> {
  const schemaName = `workspace_${projectId}`
  const db = await workspaceRawClient(projectId)

  const tables = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    schemaName
  )
  if (tables.length === 0) return []

  const columns = await db.$queryRawUnsafe<Array<{
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
  const uniques = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND i.indisunique AND array_length(i.indkey, 1) = 1`,
    schemaName
  )
  const uniqueSet = new Set(uniques.map(u => `${u.table_name}.${u.column_name}`))

  const foreignKeys = await db.$queryRawUnsafe<Array<{
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
