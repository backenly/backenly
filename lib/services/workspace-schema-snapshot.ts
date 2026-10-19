/**
 * WORKSPACE SCHEMA SNAPSHOT
 * =========================
 * Captures the live database DDL for each workspace schema after every mutation.
 *
 * Fixes #86 — Schema version history not stored per workspace.
 *   - "There is no record of what the schema looked like 1 week ago."
 *   - ROLLBACK_TO_VERSION reverted AI graph state but NOT the actual database state.
 *
 * What this does:
 *  - Snapshots the real PostgreSQL DDL (not the AI graph representation) after every change
 *  - Stores column types, constraints, indexes, foreign keys — the full live schema
 *  - Provides diff between any two snapshots (shows exactly what changed)
 *
 * It is a record, not a way back. Snapshot-to-snapshot rollback (which replayed
 * a DDL delta and dropped whatever was newer) is retired: a change is undone by
 * restoring its own checkpoint, through lib/changes/recovery.ts.
 *
 * Rules:
 *  - captureSchemaSnapshot() is called by schema-migration-engine before and after every migration
 *  - Snapshots are read-only records — never mutated after creation
 *  - Diffs are structural (column-level), not just raw DDL string diffs
 */

import { getWorkspaceDatabaseNames } from './databaseProvisioning'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ColumnSnapshot {
  name: string
  type: string
  nullable: boolean
  default: string | null
  isPrimary: boolean
}

export interface IndexSnapshot {
  name: string
  columns: string[]
  unique: boolean
  definition: string
  /**
   * True when the index is owned by a constraint (PRIMARY KEY / UNIQUE). Such
   * indexes can never be dropped via DROP INDEX — anything diffing snapshots
   * must skip them (their lifecycle belongs to the constraint diff). Optional:
   * snapshots captured before this field existed lack it.
   */
  constraintBacked?: boolean
}

export interface ForeignKeySnapshot {
  constraintName: string
  column: string
  referencedTable: string
  referencedColumn: string
  onDelete: string
}

export interface PolicySnapshot {
  name: string
  /** 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' (pg_policies.cmd) */
  cmd: string
  permissive: boolean
  roles: string[]
  using: string | null
  withCheck: string | null
}

export interface TriggerSnapshot {
  name: string
  /** Full CREATE TRIGGER statement from pg_get_triggerdef — replayable as-is. */
  definition: string
}

export interface TableSnapshot {
  name: string
  columns: ColumnSnapshot[]
  indexes: IndexSnapshot[]
  foreignKeys: ForeignKeySnapshot[]
  rowEstimate: number
  /**
   * RLS / policy / trigger state — the exact objects the autonomy loop's
   * Tier 0/1 fixes create (SET_PERMISSION, FIX_REALTIME). Optional: snapshots
   * captured before these fields existed lack them, and every consumer must
   * treat `undefined` as "state unknown" and draw no conclusion for that
   * dimension — never as "RLS off" / "no triggers".
   */
  rlsEnabled?: boolean
  policies?: PolicySnapshot[]
  triggers?: TriggerSnapshot[]
}

export interface SchemaSnapshotRecord {
  id: string
  projectId: string
  versionNum: number
  trigger: string
  tables: TableSnapshot[]
  rawDdl: string
  tableCount: number
  columnCount: number
  createdAt: Date
}

export interface SchemaDiff {
  fromVersion: number
  toVersion: number
  addedTables: string[]
  droppedTables: string[]
  modifiedTables: Array<{
    tableName: string
    addedColumns: ColumnSnapshot[]
    droppedColumns: string[]
    modifiedColumns: Array<{
      columnName: string
      before: Partial<ColumnSnapshot>
      after: Partial<ColumnSnapshot>
    }>
    addedIndexes: IndexSnapshot[]
    droppedIndexes: string[]
  }>
  isEmpty: boolean
  summary: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Capture a snapshot of the current workspace schema state.
 * Called before and after every migration, and at build completion.
 */
export async function captureSchemaSnapshot(
  projectId: string,
  trigger: 'pre_migration' | 'post_migration' | 'manual' | 'build_complete',
): Promise<SchemaSnapshotRecord | null> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    // ── Read live schema from PostgreSQL ──────────────────────────────────────
    const tables = await readLiveSchema(projectId, postgresSchema)
    const rawDdl = generateDdlFromTables(tables, postgresSchema)

    const tableCount = tables.length
    const columnCount = tables.reduce((sum, t) => sum + t.columns.length, 0)

    // ── Get next version number ────────────────────────────────────────────────
    const latest = await prisma.workspaceSchemaSnapshot.findFirst({
      where: { projectId },
      orderBy: { versionNum: 'desc' },
      select: { versionNum: true },
    })
    const versionNum = (latest?.versionNum ?? 0) + 1

    const record = await prisma.workspaceSchemaSnapshot.create({
      data: {
        projectId,
        versionNum,
        trigger,
        tables: tables as any,
        rawDdl,
        tableCount,
        columnCount,
      },
    })

    return {
      id: record.id,
      projectId: record.projectId,
      versionNum: record.versionNum,
      trigger: record.trigger,
      tables,
      rawDdl: record.rawDdl,
      tableCount: record.tableCount,
      columnCount: record.columnCount,
      createdAt: record.createdAt,
    }
  } catch (err) {
    console.error('[workspace-schema-snapshot] captureSchemaSnapshot failed:', err)
    return null
  }
}

/**
 * List all schema snapshots for a project, newest first.
 */
export async function listSchemaSnapshots(
  projectId: string,
  limit = 20,
): Promise<Array<Omit<SchemaSnapshotRecord, 'tables' | 'rawDdl'>>> {
  const { prisma } = await import('@/lib/db/prisma')

  const records = await prisma.workspaceSchemaSnapshot.findMany({
    where: { projectId },
    orderBy: { versionNum: 'desc' },
    take: limit,
    select: {
      id: true,
      projectId: true,
      versionNum: true,
      trigger: true,
      tableCount: true,
      columnCount: true,
      createdAt: true,
    },
  })

  return records.map(r => ({
    id: r.id,
    projectId: r.projectId,
    versionNum: r.versionNum,
    trigger: r.trigger,
    tableCount: r.tableCount,
    columnCount: r.columnCount,
    tables: [],
    rawDdl: '',
    createdAt: r.createdAt,
  }))
}

/**
 * Get a specific snapshot by version number (full, including tables and DDL).
 */
export async function getSchemaSnapshot(
  projectId: string,
  versionNum: number,
): Promise<SchemaSnapshotRecord | null> {
  const { prisma } = await import('@/lib/db/prisma')

  const record = await prisma.workspaceSchemaSnapshot.findFirst({
    where: { projectId, versionNum },
  })

  if (!record) return null

  return {
    id: record.id,
    projectId: record.projectId,
    versionNum: record.versionNum,
    trigger: record.trigger,
    tables: record.tables as unknown as TableSnapshot[],
    rawDdl: record.rawDdl,
    tableCount: record.tableCount,
    columnCount: record.columnCount,
    createdAt: record.createdAt,
  }
}

/**
 * Diff between any two schema versions.
 * Returns a structured diff showing exactly what changed at the column level.
 */
export async function diffSchemaVersions(
  projectId: string,
  fromVersion: number,
  toVersion: number,
): Promise<SchemaDiff> {
  const [from, to] = await Promise.all([
    getSchemaSnapshot(projectId, fromVersion),
    getSchemaSnapshot(projectId, toVersion),
  ])

  if (!from || !to) {
    return {
      fromVersion,
      toVersion,
      addedTables: [],
      droppedTables: [],
      modifiedTables: [],
      isEmpty: true,
      summary: `Cannot diff: version ${!from ? fromVersion : toVersion} not found`,
    }
  }

  return computeDiff(from.tables, to.tables, fromVersion, toVersion)
}

/**
 * Diff the current live schema against a previous snapshot version.
 */
export async function diffCurrentVsVersion(
  projectId: string,
  compareToVersion: number,
): Promise<SchemaDiff> {
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const [currentTables, historicSnapshot] = await Promise.all([
    readLiveSchema(projectId, postgresSchema),
    getSchemaSnapshot(projectId, compareToVersion),
  ])

  if (!historicSnapshot) {
    return {
      fromVersion: compareToVersion,
      toVersion: -1,
      addedTables: [],
      droppedTables: [],
      modifiedTables: [],
      isEmpty: true,
      summary: `Cannot diff: version ${compareToVersion} not found`,
    }
  }

  return computeDiff(historicSnapshot.tables, currentTables, compareToVersion, -1)
}

// ── Live schema reader ────────────────────────────────────────────────────────

async function readLiveSchema(
  projectId: string,
  postgresSchema: string,
): Promise<TableSnapshot[]> {
  // The catalog of the database holding the project's data, in its region.
  const { workspaceRawClient } = await import('@/lib/data-plane/regional')
  const db = await workspaceRawClient(projectId)

  // ── Get all tables in the schema ──────────────────────────────────────────
  const tableRows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    postgresSchema,
  )

  const tables: TableSnapshot[] = []

  for (const { table_name } of tableRows) {
    // ── Columns ───────────────────────────────────────────────────────────
    const colRows = await db.$queryRawUnsafe<Array<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      postgresSchema,
      table_name,
    )

    const primaryKeyRows = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      postgresSchema,
      table_name,
    )
    const primaryKeys = new Set(primaryKeyRows.map(r => r.column_name))

    const columns: ColumnSnapshot[] = colRows.map(c => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === 'YES',
      default: c.column_default,
      isPrimary: primaryKeys.has(c.column_name),
    }))

    // ── Indexes ───────────────────────────────────────────────────────────
    const idxRows = await db.$queryRawUnsafe<Array<{
      indexname: string
      indexdef: string
    }>>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2`,
      postgresSchema,
      table_name,
    )

    // Indexes owned by a constraint (PK/UNIQUE) — DROP INDEX cannot touch
    // these, so a consumer of the snapshot needs to know which they are.
    const conIdxRows = await db.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT ci.relname FROM pg_constraint con
       JOIN pg_class ci ON ci.oid = con.conindid
       JOIN pg_class c  ON c.oid  = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema,
      table_name,
    )
    const constraintBackedIdx = new Set(conIdxRows.map(r => r.relname))

    const indexes: IndexSnapshot[] = idxRows.map(r => ({
      name: r.indexname,
      columns: extractIndexColumns(r.indexdef),
      unique: r.indexdef.includes('UNIQUE'),
      definition: r.indexdef,
      constraintBacked: constraintBackedIdx.has(r.indexname),
    }))

    // ── Foreign keys ──────────────────────────────────────────────────────
    const fkRows = await db.$queryRawUnsafe<Array<{
      constraint_name: string
      column_name: string
      foreign_table_name: string
      foreign_column_name: string
      delete_rule: string
    }>>(
      `SELECT
         tc.constraint_name,
         kcu.column_name,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name,
         rc.delete_rule
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage AS ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       LEFT JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      postgresSchema,
      table_name,
    )

    const foreignKeys: ForeignKeySnapshot[] = fkRows.map(r => ({
      constraintName: r.constraint_name,
      column: r.column_name,
      referencedTable: r.foreign_table_name,
      referencedColumn: r.foreign_column_name,
      onDelete: r.delete_rule ?? 'NO ACTION',
    }))

    // ── Row estimate ──────────────────────────────────────────────────────
    const countRows = await db.$queryRawUnsafe<Array<{ reltuples: bigint | number }>>(
      `SELECT reltuples::bigint AS reltuples FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema,
      table_name,
    )
    // reltuples::bigint comes back as a JS BigInt — Math.max(0, bigint) throws
    // "Cannot convert a BigInt value to a number", which failed the whole
    // pre-fix snapshot. Coerce to Number first.
    const rowEstimate = Math.max(0, Number(countRows[0]?.reltuples ?? 0))

    // ── RLS state + policies ──────────────────────────────────────────────
    // These are the objects SET_PERMISSION creates. Without capturing them,
    // one-click undo of an RLS fix is structurally impossible.
    const rlsRows = await db.$queryRawUnsafe<Array<{ relrowsecurity: boolean }>>(
      `SELECT c.relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema,
      table_name,
    )
    const rlsEnabled = rlsRows[0]?.relrowsecurity === true

    const polRows = await db.$queryRawUnsafe<Array<{
      policyname: string
      permissive: string
      roles: string[] | string
      cmd: string
      qual: string | null
      with_check: string | null
    }>>(
      `SELECT policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
      postgresSchema,
      table_name,
    )
    const policies: PolicySnapshot[] = polRows.map(p => ({
      name: p.policyname,
      cmd: p.cmd ?? 'ALL',
      permissive: String(p.permissive).toUpperCase() !== 'RESTRICTIVE',
      // pg name[] usually parses to a JS array; harden against the raw
      // '{role_a,role_b}' string form too.
      roles: Array.isArray(p.roles)
        ? p.roles
        : String(p.roles ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean),
      using: p.qual,
      withCheck: p.with_check,
    }))

    // ── User triggers (NOT tgisinternal — excludes FK/PK machinery) ───────
    // These are the objects FIX_REALTIME creates (NOTIFY triggers).
    const trgRows = await db.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal`,
      postgresSchema,
      table_name,
    )
    const triggers: TriggerSnapshot[] = trgRows.map(t => ({ name: t.tgname, definition: t.def }))

    tables.push({ name: table_name, columns, indexes, foreignKeys, rowEstimate, rlsEnabled, policies, triggers })
  }

  return tables
}

// ── DDL generator ─────────────────────────────────────────────────────────────

function generateDdlFromTables(tables: TableSnapshot[], schema: string): string {
  const lines: string[] = [`-- Schema: ${schema}`, `-- Captured: ${new Date().toISOString()}`, '']

  for (const table of tables) {
    lines.push(`CREATE TABLE IF NOT EXISTS "${schema}"."${table.name}" (`)
    const colDefs = table.columns.map(c => {
      const nullable = c.nullable ? '' : ' NOT NULL'
      const def = c.default ? ` DEFAULT ${c.default}` : ''
      const pk = c.isPrimary ? ' PRIMARY KEY' : ''
      return `  "${c.name}" ${c.type}${pk}${nullable}${def}`
    })
    lines.push(colDefs.join(',\n'))
    lines.push(');')
    lines.push('')

    for (const idx of table.indexes) {
      if (!idx.definition.includes('PRIMARY KEY')) {
        lines.push(`${idx.definition};`)
      }
    }

    for (const fk of table.foreignKeys) {
      lines.push(
        `ALTER TABLE "${schema}"."${table.name}" ADD CONSTRAINT "${fk.constraintName}" ` +
        `FOREIGN KEY ("${fk.column}") REFERENCES "${schema}"."${fk.referencedTable}"("${fk.referencedColumn}") ON DELETE ${fk.onDelete};`
      )
    }

    lines.push('')
  }

  return lines.join('\n')
}

// ── Diff engine ───────────────────────────────────────────────────────────────

function computeDiff(
  fromTables: TableSnapshot[],
  toTables: TableSnapshot[],
  fromVersion: number,
  toVersion: number,
): SchemaDiff {
  const fromMap = new Map(fromTables.map(t => [t.name, t]))
  const toMap = new Map(toTables.map(t => [t.name, t]))

  const addedTables = toTables.filter(t => !fromMap.has(t.name)).map(t => t.name)
  const droppedTables = fromTables.filter(t => !toMap.has(t.name)).map(t => t.name)

  const modifiedTables: SchemaDiff['modifiedTables'] = []

  for (const [tableName, fromTable] of fromMap) {
    const toTable = toMap.get(tableName)
    if (!toTable) continue

    const fromColMap = new Map(fromTable.columns.map(c => [c.name, c]))
    const toColMap = new Map(toTable.columns.map(c => [c.name, c]))

    const addedColumns = toTable.columns.filter(c => !fromColMap.has(c.name))
    const droppedColumns = fromTable.columns.filter(c => !toColMap.has(c.name)).map(c => c.name)

    const modifiedColumns: SchemaDiff['modifiedTables'][0]['modifiedColumns'] = []
    for (const [colName, fromCol] of fromColMap) {
      const toCol = toColMap.get(colName)
      if (!toCol) continue

      const changes: Partial<ColumnSnapshot> = {}
      const before: Partial<ColumnSnapshot> = {}

      if (fromCol.type !== toCol.type) { before.type = fromCol.type; changes.type = toCol.type }
      if (fromCol.nullable !== toCol.nullable) { before.nullable = fromCol.nullable; changes.nullable = toCol.nullable }
      if (fromCol.default !== toCol.default) { before.default = fromCol.default; changes.default = toCol.default }

      if (Object.keys(changes).length > 0) {
        modifiedColumns.push({ columnName: colName, before, after: changes })
      }
    }

    const fromIdxNames = new Set(fromTable.indexes.map(i => i.name))
    const toIdxNames = new Set(toTable.indexes.map(i => i.name))
    const addedIndexes = toTable.indexes.filter(i => !fromIdxNames.has(i.name))
    const droppedIndexes = fromTable.indexes.filter(i => !toIdxNames.has(i.name)).map(i => i.name)

    if (addedColumns.length > 0 || droppedColumns.length > 0 || modifiedColumns.length > 0 || addedIndexes.length > 0 || droppedIndexes.length > 0) {
      modifiedTables.push({ tableName, addedColumns, droppedColumns, modifiedColumns, addedIndexes, droppedIndexes })
    }
  }

  const isEmpty = addedTables.length === 0 && droppedTables.length === 0 && modifiedTables.length === 0

  const summary = isEmpty
    ? `No schema changes between v${fromVersion} and v${toVersion}`
    : buildDiffSummary(addedTables, droppedTables, modifiedTables, fromVersion, toVersion)

  return { fromVersion, toVersion, addedTables, droppedTables, modifiedTables, isEmpty, summary }
}

function buildDiffSummary(
  added: string[],
  dropped: string[],
  modified: SchemaDiff['modifiedTables'],
  fromV: number,
  toV: number,
): string {
  const parts: string[] = [`Schema diff v${fromV} → v${toV === -1 ? 'current' : toV}:`]
  if (added.length) parts.push(`+${added.length} table(s) added: ${added.join(', ')}`)
  if (dropped.length) parts.push(`-${dropped.length} table(s) dropped: ${dropped.join(', ')}`)
  for (const t of modified) {
    const changes: string[] = []
    if (t.addedColumns.length) changes.push(`+${t.addedColumns.length} col(s)`)
    if (t.droppedColumns.length) changes.push(`-${t.droppedColumns.length} col(s)`)
    if (t.modifiedColumns.length) changes.push(`~${t.modifiedColumns.length} col(s) modified`)
    if (t.addedIndexes.length) changes.push(`+${t.addedIndexes.length} index(es)`)
    if (t.droppedIndexes.length) changes.push(`-${t.droppedIndexes.length} index(es)`)
    parts.push(`${t.tableName}: ${changes.join(', ')}`)
  }
  return parts.join(' | ')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractIndexColumns(indexdef: string): string[] {
  const match = /\(([^)]+)\)/.exec(indexdef)
  if (!match) return []
  return match[1].split(',').map(c => c.trim().replace(/^"|"$/g, ''))
}
