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
 *  - Provides one-click rollback to any previous snapshot (runs the actual DDL delta)
 *
 * Rules:
 *  - captureSchemaSnapshot() is called by schema-migration-engine before and after every migration
 *  - Snapshots are read-only records — never mutated after creation
 *  - Rollback uses add-new/rename-old strategy — never DROP without archiving
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
   * indexes can never be dropped via DROP INDEX — the rollback DDL engine must
   * skip them (their lifecycle belongs to the constraint diff). Optional:
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
   * treat `undefined` as "state unknown" and emit NO rollback DDL for that
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

export interface SchemaRollbackResult {
  success: boolean
  appliedSteps: number
  error?: string
  durationMs: number
  rollbackDdl: string
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

/**
 * Roll back the workspace schema to a previous snapshot.
 *
 * Strategy:
 *  - Added tables (tables that exist now but not in target) → RENAME to _archived_{name}_{ts}
 *  - Dropped tables (tables that existed in target but not now) → RECREATE from snapshot DDL
 *  - Modified columns → ALTER TABLE to restore previous types, defaults, constraints
 *  - Indexes → DROP new / RECREATE old
 *
 * Non-destructive: tables are never DROPped — only renamed (preserving data for manual recovery).
 */
export async function rollbackToSchemaVersion(
  projectId: string,
  targetVersionNum: number,
): Promise<SchemaRollbackResult> {
  const start = Date.now()

  try {
    const { prisma } = await import('@/lib/db/prisma')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const targetSnapshot = await getSchemaSnapshot(projectId, targetVersionNum)
    if (!targetSnapshot) {
      return {
        success: false,
        appliedSteps: 0,
        error: `Version ${targetVersionNum} not found`,
        durationMs: Date.now() - start,
        rollbackDdl: '',
      }
    }

    // Snapshot current state before rollback (for safety)
    await captureSchemaSnapshot(projectId, 'pre_migration')

    const currentTables = await readLiveSchema(projectId, postgresSchema)
    const rollbackSteps = computeRollbackDdl(currentTables, targetSnapshot.tables, postgresSchema)

    let appliedSteps = 0
    for (const sql of rollbackSteps) {
      await prisma.$executeRawUnsafe(sql)
      appliedSteps++
    }

    // Snapshot after rollback
    await captureSchemaSnapshot(projectId, 'post_migration')

    return {
      success: true,
      appliedSteps,
      durationMs: Date.now() - start,
      rollbackDdl: rollbackSteps.join('\n'),
    }
  } catch (err) {
    return {
      success: false,
      appliedSteps: 0,
      error: String(err),
      durationMs: Date.now() - start,
      rollbackDdl: '',
    }
  }
}

// ── Live schema reader ────────────────────────────────────────────────────────

async function readLiveSchema(
  projectId: string,
  postgresSchema: string,
): Promise<TableSnapshot[]> {
  const { prisma } = await import('@/lib/db/prisma')

  // ── Get all tables in the schema ──────────────────────────────────────────
  const tableRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    postgresSchema,
  )

  const tables: TableSnapshot[] = []

  for (const { table_name } of tableRows) {
    // ── Columns ───────────────────────────────────────────────────────────
    const colRows = await prisma.$queryRawUnsafe<Array<{
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

    const primaryKeyRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
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
    const idxRows = await prisma.$queryRawUnsafe<Array<{
      indexname: string
      indexdef: string
    }>>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2`,
      postgresSchema,
      table_name,
    )

    // Indexes owned by a constraint (PK/UNIQUE) — DROP INDEX cannot touch
    // these, so the rollback DDL engine needs to know which they are.
    const conIdxRows = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(
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
    const fkRows = await prisma.$queryRawUnsafe<Array<{
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
    const countRows = await prisma.$queryRawUnsafe<Array<{ reltuples: bigint | number }>>(
      `SELECT reltuples::bigint AS reltuples FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema,
      table_name,
    )
    // reltuples::bigint comes back as a JS BigInt — Math.max(0, bigint) throws
    // "Cannot convert a BigInt value to a number", which failed the whole
    // pre-fix rollback snapshot. Coerce to Number first.
    const rowEstimate = Math.max(0, Number(countRows[0]?.reltuples ?? 0))

    // ── RLS state + policies ──────────────────────────────────────────────
    // These are the objects SET_PERMISSION creates. Without capturing them,
    // one-click undo of an RLS fix is structurally impossible.
    const rlsRows = await prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean }>>(
      `SELECT c.relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema,
      table_name,
    )
    const rlsEnabled = rlsRows[0]?.relrowsecurity === true

    const polRows = await prisma.$queryRawUnsafe<Array<{
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
    const trgRows = await prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
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

// ── Rollback DDL generator ────────────────────────────────────────────────────

function computeRollbackDdl(
  currentTables: TableSnapshot[],
  targetTables: TableSnapshot[],
  schema: string,
): string[] {
  const steps: string[] = [`SET search_path TO "${schema}", public;`]
  const ts = Date.now()

  const currentMap = new Map(currentTables.map(t => [t.name, t]))
  const targetMap = new Map(targetTables.map(t => [t.name, t]))

  // Tables that exist now but not in target → RENAME (non-destructive)
  for (const [name] of currentMap) {
    if (!targetMap.has(name)) {
      steps.push(`ALTER TABLE "${schema}"."${name}" RENAME TO "_archived_${name}_${ts}";`)
    }
  }

  // Tables that existed in target but not now → RECREATE from target DDL
  for (const [name, table] of targetMap) {
    if (!currentMap.has(name)) {
      const colDefs = table.columns.map(c => {
        const nullable = c.nullable ? '' : ' NOT NULL'
        const def = c.default ? ` DEFAULT ${c.default}` : ''
        const pk = c.isPrimary ? ' PRIMARY KEY' : ''
        return `  "${c.name}" ${c.type}${pk}${nullable}${def}`
      }).join(',\n')
      steps.push(`CREATE TABLE IF NOT EXISTS "${schema}"."${name}" (\n${colDefs}\n);`)
    }
  }

  // Modified tables → restore columns
  for (const [name, currentTable] of currentMap) {
    const target = targetMap.get(name)
    if (!target) continue

    const currentColMap = new Map(currentTable.columns.map(c => [c.name, c]))
    const targetColMap = new Map(target.columns.map(c => [c.name, c]))

    // Columns in target but not in current → ADD
    for (const [colName, col] of targetColMap) {
      if (!currentColMap.has(colName)) {
        const nullable = col.nullable ? '' : ' NOT NULL'
        const def = col.default ? ` DEFAULT ${col.default}` : ''
        steps.push(`ALTER TABLE "${schema}"."${name}" ADD COLUMN IF NOT EXISTS "${colName}" ${col.type}${nullable}${def};`)
      }
    }

    // Columns in current but not in target → RENAME to archived (non-destructive)
    for (const [colName] of currentColMap) {
      if (!targetColMap.has(colName)) {
        steps.push(`ALTER TABLE "${schema}"."${name}" RENAME COLUMN "${colName}" TO "_archived_${colName}_${ts}";`)
      }
    }

    // Modified columns → ALTER to restore
    for (const [colName, currentCol] of currentColMap) {
      const targetCol = targetColMap.get(colName)
      if (!targetCol) continue

      if (currentCol.type !== targetCol.type) {
        steps.push(`ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${colName}" TYPE ${targetCol.type};`)
      }
      if (currentCol.nullable !== targetCol.nullable) {
        if (targetCol.nullable) {
          steps.push(`ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${colName}" DROP NOT NULL;`)
        } else {
          steps.push(`ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${colName}" SET NOT NULL;`)
        }
      }
      if (currentCol.default !== targetCol.default) {
        if (targetCol.default) {
          steps.push(`ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${colName}" SET DEFAULT ${targetCol.default};`)
        } else {
          steps.push(`ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${colName}" DROP DEFAULT;`)
        }
      }
    }

    // Restore dropped indexes
    const currentIdxNames = new Set(currentTable.indexes.map(i => i.name))
    for (const idx of target.indexes) {
      if (!currentIdxNames.has(idx.name) && !idx.definition.includes('PRIMARY KEY')) {
        steps.push(`${idx.definition};`)
      }
    }

    // Drop indexes ADDED since the target — the missing branch that made a
    // reverted CREATE_INDEX fix survive its own undo. Constraint-backed
    // indexes are skipped: DROP INDEX cannot touch them, and their lifecycle
    // belongs to the constraint diff below.
    const targetIdxNames = new Set(target.indexes.map(i => i.name))
    for (const idx of currentTable.indexes) {
      if (
        !targetIdxNames.has(idx.name) &&
        !idx.constraintBacked &&
        !idx.definition.includes('PRIMARY KEY')
      ) {
        steps.push(`DROP INDEX IF EXISTS "${schema}"."${idx.name}";`)
      }
    }

    // Foreign-key constraints — both directions. FKs were captured in every
    // snapshot since v1 but never diffed, so ADD_CONSTRAINT fixes were
    // irreversible via snapshots.
    const currentFks = new Map(currentTable.foreignKeys.map(f => [f.constraintName, f]))
    const targetFks = new Map((target.foreignKeys ?? []).map(f => [f.constraintName, f]))
    for (const [fkName] of currentFks) {
      if (!targetFks.has(fkName)) {
        steps.push(`ALTER TABLE "${schema}"."${name}" DROP CONSTRAINT IF EXISTS "${fkName}";`)
      }
    }
    for (const [fkName, fk] of targetFks) {
      if (!currentFks.has(fkName)) {
        steps.push(
          `ALTER TABLE "${schema}"."${name}" ADD CONSTRAINT "${fkName}" ` +
          `FOREIGN KEY ("${fk.column}") REFERENCES "${schema}"."${fk.referencedTable}"("${fk.referencedColumn}") ` +
          `ON DELETE ${fk.onDelete};`,
        )
      }
    }

    // RLS + policies — ONLY when the target snapshot RECORDED this state.
    // Snapshots captured before policies existed leave RLS untouched: "state
    // unknown" must never be treated as "RLS off" (that would strip protection
    // as a side effect of an unrelated rollback).
    if (target.rlsEnabled !== undefined && target.policies !== undefined) {
      const currentPolicies = new Map((currentTable.policies ?? []).map(p => [p.name, p]))
      const targetPolicies = new Map(target.policies.map(p => [p.name, p]))

      // Enable first so recreated policies land on an RLS-enabled table.
      if (target.rlsEnabled && currentTable.rlsEnabled === false) {
        steps.push(`ALTER TABLE "${schema}"."${name}" ENABLE ROW LEVEL SECURITY;`)
      }

      for (const [polName, cur] of currentPolicies) {
        const tgt = targetPolicies.get(polName)
        if (!tgt) {
          steps.push(`DROP POLICY IF EXISTS "${polName}" ON "${schema}"."${name}";`)
        } else if (cur.using !== tgt.using || cur.withCheck !== tgt.withCheck || cur.cmd !== tgt.cmd) {
          // Policy body changed — recreate from the target definition.
          steps.push(`DROP POLICY IF EXISTS "${polName}" ON "${schema}"."${name}";`)
          steps.push(buildCreatePolicyDdl(schema, name, tgt))
        }
      }
      for (const [polName, tgt] of targetPolicies) {
        if (!currentPolicies.has(polName)) {
          steps.push(buildCreatePolicyDdl(schema, name, tgt))
        }
      }

      // Disable last, after added policies have been dropped.
      if (!target.rlsEnabled && currentTable.rlsEnabled === true) {
        steps.push(`ALTER TABLE "${schema}"."${name}" DISABLE ROW LEVEL SECURITY;`)
      }
    }

    // Triggers — same "recorded state only" rule as RLS. This is what makes a
    // FIX_REALTIME (NOTIFY trigger) fix reversible.
    if (target.triggers !== undefined) {
      const currentTrgs = new Map((currentTable.triggers ?? []).map(t => [t.name, t]))
      const targetTrgs = new Map(target.triggers.map(t => [t.name, t]))
      for (const [trgName] of currentTrgs) {
        if (!targetTrgs.has(trgName)) {
          steps.push(`DROP TRIGGER IF EXISTS "${trgName}" ON "${schema}"."${name}";`)
        }
      }
      for (const [trgName, trg] of targetTrgs) {
        if (!currentTrgs.has(trgName)) {
          steps.push(`${trg.definition};`)
        }
      }
    }
  }

  return steps
}

/** Reconstruct a CREATE POLICY statement from a captured PolicySnapshot. */
function buildCreatePolicyDdl(schema: string, table: string, p: PolicySnapshot): string {
  const roles = p.roles.length > 0
    ? p.roles.map(r => (r === 'public' ? 'public' : `"${r}"`)).join(', ')
    : 'public'
  const asClause = p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'
  const usingClause = p.using ? ` USING (${p.using})` : ''
  const checkClause = p.withCheck ? ` WITH CHECK (${p.withCheck})` : ''
  return `CREATE POLICY "${p.name}" ON "${schema}"."${table}" AS ${asClause} FOR ${p.cmd} TO ${roles}${usingClause}${checkClause};`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractIndexColumns(indexdef: string): string[] {
  const match = /\(([^)]+)\)/.exec(indexdef)
  if (!match) return []
  return match[1].split(',').map(c => c.trim().replace(/^"|"$/g, ''))
}
