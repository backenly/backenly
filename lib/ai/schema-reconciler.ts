/**
 * SCHEMA RECONCILER
 * =================
 * Compares the live PostgreSQL workspace schema against Backenly's stored
 * WorkspaceSchemaSnapshot to detect drift — tables or columns that have
 * appeared, disappeared, changed type, lost indexes, or had RLS stripped.
 *
 * Usage:
 *   const report = await detectSchemaDrift(projectId)
 *   // report.drifts  — structured list of every difference found
 *   // report.migrations  — ordered SQL to bring live schema back in sync
 *
 *   await applyReconciliationMigrations(projectId, report.migrations)
 */

import { prisma } from '@/lib/db/prisma'
import { Pool, PoolClient } from 'pg'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'
import { jwtClaimFunctionSql, ownRowsPredicate } from '@/lib/postgrest/rls-translation'

// ---------------------------------------------------------------------------
// Shared pg pool
// ---------------------------------------------------------------------------
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL })

async function pgQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pgPool.connect()
  try {
    const result = await client.query(sql, params)
    return result.rows as T[]
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DriftType =
  | 'missing_table'
  | 'extra_table'
  | 'missing_column'
  | 'extra_column'
  | 'type_mismatch'
  | 'missing_index'
  | 'missing_rls'

export interface DriftItem {
  type: DriftType
  severity: 'critical' | 'warning' | 'info'
  tableName: string
  columnName?: string
  expected?: string
  actual?: string
  description: string
  migration?: string
}

export interface ReconciliationReport {
  projectId: string
  ranAt: string
  snapshotVersion?: number
  drifts: DriftItem[]
  hasCritical: boolean
  hasWarnings: boolean
  migrations: string[]
  summary: string
}

// ---------------------------------------------------------------------------
// Type normalisation — be lenient across PostgreSQL aliases
// ---------------------------------------------------------------------------

function normaliseType(raw: string): string {
  const t = raw.toLowerCase().trim()
  // Varchar family → text
  if (t === 'character varying' || t === 'varchar' || t === 'character' || t === 'char') {
    return 'text'
  }
  // Integer family → integer
  if (t === 'int4' || t === 'int' || t === 'smallint' || t === 'int2' || t === 'bigint' || t === 'int8') {
    return 'integer'
  }
  // Boolean
  if (t === 'bool') return 'boolean'
  // Timestamp family → timestamptz
  if (
    t === 'timestamp with time zone' ||
    t === 'timestamptz' ||
    t === 'timestamp without time zone' ||
    t === 'timestamp'
  ) {
    return 'timestamptz'
  }
  // Numeric family
  if (t === 'numeric' || t === 'decimal') return 'numeric'
  // Float family
  if (t === 'float4' || t === 'real' || t === 'float') return 'real'
  if (t === 'float8' || t === 'double precision') return 'double precision'
  return t
}

function typesMatch(a: string, b: string): boolean {
  return normaliseType(a) === normaliseType(b)
}

// ---------------------------------------------------------------------------
// Internal table skip list
// ---------------------------------------------------------------------------

// `users` is skipped here (it is auth-owned, reconciled by the auth contract),
// plus the legacy `backenly_` prefix. Everything genuinely internal — every
// leading-underscore plumbing table, pg_*, information_schema — comes from the
// canonical predicate so a new internal table can never be misreported as
// "extra_table" schema drift.
const SKIP_EXTRA_TABLE_NAMES = new Set(['users'])

function isInternalTable(tableName: string): boolean {
  if (SKIP_EXTRA_TABLE_NAMES.has(tableName)) return true
  if (tableName.startsWith('backenly_')) return true
  return isReservedWorkspaceTable(tableName)
}

// ---------------------------------------------------------------------------
// Snapshot column shape (mirrors WorkspaceSchemaSnapshot.tables JSON)
// ---------------------------------------------------------------------------

interface SnapshotColumn {
  name: string
  type: string
  nullable?: boolean
  default?: string | null
  isPrimary?: boolean
}

interface SnapshotTable {
  name: string
  columns: SnapshotColumn[]
  indexes?: Array<{ name: string; columns: string[] }>
  foreignKeys?: Array<{
    column: string
    referencedTable: string
    referencedColumn: string
  }>
}

// ---------------------------------------------------------------------------
// detectSchemaDrift
// ---------------------------------------------------------------------------

export async function detectSchemaDrift(projectId: string): Promise<ReconciliationReport> {
  const ranAt = new Date().toISOString()
  const empty = (summary: string): ReconciliationReport => ({
    projectId,
    ranAt,
    drifts: [],
    hasCritical: false,
    hasWarnings: false,
    migrations: [],
    summary,
  })

  try {
    // 1. Load latest snapshot
    const snapshot = await prisma.workspaceSchemaSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        versionNum: true,
        tables: true,
        createdAt: true,
      },
    })

    if (!snapshot) {
      return {
        ...empty('No schema snapshot found — run a build first'),
        snapshotVersion: undefined,
      }
    }

    const snapshotTables = (snapshot.tables as unknown as SnapshotTable[]) ?? []
    const schema = `workspace_${projectId}`

    // 2. Query actual workspace columns from information_schema
    const actualCols = await pgQuery<{
      table_name: string
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema],
    )

    // 3. Build actual table map: tableName → [{column, type}]
    const actualMap = new Map<string, Array<{ column: string; type: string }>>()
    for (const row of actualCols) {
      if (!actualMap.has(row.table_name)) actualMap.set(row.table_name, [])
      actualMap.get(row.table_name)!.push({
        column: row.column_name,
        type: row.data_type,
      })
    }

    // 4. Build expected table map from snapshot
    const expectedMap = new Map<string, SnapshotTable>()
    for (const t of snapshotTables) {
      expectedMap.set(t.name, t)
    }

    const drifts: DriftItem[] = []

    // 5a. missing_table — in snapshot but not in actual
    for (const [tableName, snapTable] of expectedMap.entries()) {
      if (isInternalTable(tableName)) continue
      if (actualMap.has(tableName)) continue

      const colList = snapTable.columns.map((c) => `${c.name} ${c.type}`).join(', ')
      drifts.push({
        type: 'missing_table',
        severity: 'critical',
        tableName,
        expected: colList,
        description: `Table "${tableName}" exists in the schema snapshot but is missing from the live database.`,
        migration: [
          `CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (`,
          snapTable.columns
            .map((c) => {
              const nullable = c.nullable === false ? ' NOT NULL' : ''
              const pk = c.isPrimary ? ' PRIMARY KEY' : ''
              const def = c.default ? ` DEFAULT ${c.default}` : ''
              return `  "${c.name}" ${c.type}${nullable}${pk}${def}`
            })
            .join(',\n'),
          ');',
        ].join('\n'),
      })
    }

    // 5b. extra_table — in actual but not in snapshot (and not internal)
    for (const tableName of actualMap.keys()) {
      if (isInternalTable(tableName)) continue
      if (expectedMap.has(tableName)) continue

      drifts.push({
        type: 'extra_table',
        severity: 'warning',
        tableName,
        actual: tableName,
        description: `Table "${tableName}" exists in the live database but is not tracked in the schema snapshot. It may have been created outside of Backenly.`,
        // No migration — we don't drop untracked tables automatically
      })
    }

    // 5c. Per-table column comparison
    for (const [tableName, snapTable] of expectedMap.entries()) {
      if (isInternalTable(tableName)) continue
      const actualCols2 = actualMap.get(tableName)
      if (!actualCols2) continue // already flagged as missing_table above

      const actualColMap = new Map(actualCols2.map((c) => [c.column, c.type]))
      const expectedColMap = new Map(snapTable.columns.map((c) => [c.name, c.type]))

      // missing_column — expected but absent in actual
      for (const [colName, expectedType] of expectedColMap.entries()) {
        if (actualColMap.has(colName)) continue

        const snapColDef = snapTable.columns.find((c) => c.name === colName)
        const nullable = snapColDef?.nullable !== false
        const def = snapColDef?.default

        drifts.push({
          type: 'missing_column',
          severity: 'critical',
          tableName,
          columnName: colName,
          expected: expectedType,
          description: `Column "${colName}" on table "${tableName}" is in the snapshot but missing from the live schema.`,
          migration: [
            `ALTER TABLE "${schema}"."${tableName}"`,
            `  ADD COLUMN IF NOT EXISTS "${colName}" ${expectedType}${nullable ? '' : ' NOT NULL'}${def ? ` DEFAULT ${def}` : ''};`,
          ].join('\n'),
        })
      }

      // extra_column — in actual but not in snapshot
      for (const [colName] of actualColMap.entries()) {
        if (expectedColMap.has(colName)) continue

        drifts.push({
          type: 'extra_column',
          severity: 'info',
          tableName,
          columnName: colName,
          actual: colName,
          description: `Column "${colName}" on table "${tableName}" exists in the live schema but is not in the snapshot. It may have been added outside of Backenly.`,
          // No migration — we don't drop untracked columns automatically
        })
      }

      // type_mismatch — column present in both but different type
      for (const [colName, expectedType] of expectedColMap.entries()) {
        const actualType = actualColMap.get(colName)
        if (!actualType) continue // already flagged as missing_column
        if (typesMatch(expectedType, actualType)) continue

        drifts.push({
          type: 'type_mismatch',
          severity: 'warning',
          tableName,
          columnName: colName,
          expected: expectedType,
          actual: actualType,
          description: `Column "${tableName}.${colName}" has type "${actualType}" in the live schema but "${expectedType}" in the snapshot.`,
          // ALTER COLUMN TYPE can be destructive — generate but flag as warning
          migration: `ALTER TABLE "${schema}"."${tableName}" ALTER COLUMN "${colName}" TYPE ${expectedType} USING "${colName}"::${expectedType};`,
        })
      }
    }

    // 6. missing_index — FK columns without indexes
    const fkColsInActual = actualCols.filter(
      (r) => r.column_name.endsWith('_id') && r.column_name !== 'id',
    )

    if (fkColsInActual.length > 0) {
      const indexedCols = await pgQuery<{ tablename: string; indexdef: string }>(
        `SELECT tablename, indexdef
         FROM pg_indexes
         WHERE schemaname = $1`,
        [schema],
      )

      const indexedSet = new Set<string>()
      for (const idx of indexedCols) {
        const m = idx.indexdef.match(/\(([^)]+)\)/)
        if (m) {
          const cols = m[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
          for (const col of cols) {
            indexedSet.add(`${idx.tablename}.${col}`)
          }
        }
      }

      for (const row of fkColsInActual) {
        if (isInternalTable(row.table_name)) continue
        if (indexedSet.has(`${row.table_name}.${row.column_name}`)) continue

        const idxName = `idx_${row.table_name}_${row.column_name}`
        drifts.push({
          type: 'missing_index',
          severity: 'warning',
          tableName: row.table_name,
          columnName: row.column_name,
          description: `FK column "${row.table_name}.${row.column_name}" has no index — JOIN queries and filtered lookups will do full table scans.`,
          migration: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idxName} ON "${schema}"."${row.table_name}"("${row.column_name}");`,
        })
      }
    }

    // 7. missing_rls — tables with user_id but RLS disabled
    const userIdTables = [...new Set(
      actualCols
        .filter((r) => r.column_name === 'user_id' || r.column_name === 'owner_id')
        .map((r) => r.table_name),
    )]

    if (userIdTables.length > 0) {
      const rlsRows = await pgQuery<{ relname: string; relrowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relname = ANY($2)
           AND c.relkind = 'r'`,
        [schema, userIdTables],
      )

      const rlsMap = new Map(rlsRows.map((r) => [r.relname, r.relrowsecurity]))

      for (const tableName of userIdTables) {
        if (isInternalTable(tableName)) continue
        if (rlsMap.get(tableName)) continue

        const ownerCol =
          actualCols.find((r) => r.table_name === tableName && r.column_name === 'user_id')
            ?.column_name ?? 'user_id'

        drifts.push({
          type: 'missing_rls',
          severity: 'critical',
          tableName,
          description: `Table "${tableName}" has a "${ownerCol}" column but Row Level Security is disabled — all authenticated users can read/write each other's data.`,
          // Claim form, not the `app.*` GUCs: PostgREST never sets those, so a
          // GUC-form policy matches no rows there — silently, as an empty
          // result. See lib/services/rls-session.ts: claims satisfy both engines.
          migration: [
            jwtClaimFunctionSql(schema),
            `ALTER TABLE "${schema}"."${tableName}" ENABLE ROW LEVEL SECURITY;`,
            `CREATE POLICY IF NOT EXISTS user_isolation ON "${schema}"."${tableName}"`,
            `  USING (${ownRowsPredicate(schema, ownerCol)});`,
          ].join('\n'),
        })
      }
    }

    // 8. Build ordered migrations:
    //    1. create missing tables
    //    2. add missing columns
    //    3. alter type mismatches (warnings — included but clearly flagged)
    //    4. create missing indexes
    //    5. enable RLS

    const tableMigrations = drifts
      .filter((d) => d.type === 'missing_table' && d.migration)
      .map((d) => d.migration!)

    const columnMigrations = drifts
      .filter((d) => d.type === 'missing_column' && d.migration)
      .map((d) => d.migration!)

    const typeMigrations = drifts
      .filter((d) => d.type === 'type_mismatch' && d.migration)
      .map((d) => `-- WARNING: type change may require USING cast\n${d.migration!}`)

    const indexMigrations = drifts
      .filter((d) => d.type === 'missing_index' && d.migration)
      .map((d) => d.migration!)

    const rlsMigrations = drifts
      .filter((d) => d.type === 'missing_rls' && d.migration)
      .map((d) => d.migration!)

    const migrations = [
      ...tableMigrations,
      ...columnMigrations,
      ...typeMigrations,
      ...indexMigrations,
      ...rlsMigrations,
    ]

    const hasCritical = drifts.some((d) => d.severity === 'critical')
    const hasWarnings = drifts.some((d) => d.severity === 'warning')

    const issueLines: string[] = []
    const criticals = drifts.filter((d) => d.severity === 'critical')
    const warnings = drifts.filter((d) => d.severity === 'warning')
    const infos = drifts.filter((d) => d.severity === 'info')

    if (drifts.length === 0) {
      issueLines.push('Schema is in sync with snapshot — no drift detected.')
    } else {
      if (criticals.length) issueLines.push(`${criticals.length} critical issue(s): ${criticals.map((d) => d.type).join(', ')}`)
      if (warnings.length) issueLines.push(`${warnings.length} warning(s): ${warnings.map((d) => d.type).join(', ')}`)
      if (infos.length) issueLines.push(`${infos.length} info(s): ${infos.map((d) => d.type).join(', ')}`)
      if (migrations.length) issueLines.push(`${migrations.length} migration(s) generated to reconcile.`)
    }

    return {
      projectId,
      ranAt,
      snapshotVersion: snapshot.versionNum,
      drifts,
      hasCritical,
      hasWarnings,
      migrations,
      summary: issueLines.join(' | '),
    }
  } catch (err: unknown) {
    console.warn('[SchemaReconciler] detectSchemaDrift error:', (err as Error).message)
    return {
      projectId,
      ranAt,
      drifts: [],
      hasCritical: false,
      hasWarnings: false,
      migrations: [],
      summary: `Schema drift check failed: ${(err as Error).message}`,
    }
  }
}

// ---------------------------------------------------------------------------
// applyReconciliationMigrations
// ---------------------------------------------------------------------------

export async function applyReconciliationMigrations(
  projectId: string,
  migrations: string[],
  options?: { dryRun?: boolean },
): Promise<{ applied: number; failed: number; errors: string[] }> {
  const dryRun = options?.dryRun ?? false
  const errors: string[] = []
  let applied = 0
  let failed = 0

  if (migrations.length === 0) {
    return { applied: 0, failed: 0, errors: [] }
  }

  if (dryRun) {
    // Validate syntax only — wrap each statement in a transaction that is always rolled back
    const client: PoolClient = await pgPool.connect()
    try {
      await client.query('BEGIN')
      for (const sql of migrations) {
        try {
          await client.query(sql)
          applied++
        } catch (err: unknown) {
          failed++
          errors.push(`[dry-run] ${(err as Error).message} | SQL: ${sql.substring(0, 120)}`)
        }
      }
    } finally {
      // Always rollback in dry-run mode
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    return { applied, failed, errors }
  }

  // Live apply — run each migration in its own transaction so one failure
  // does not prevent subsequent migrations from being attempted.
  for (const sql of migrations) {
    const client: PoolClient = await pgPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('COMMIT')
      applied++
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {})
      failed++
      errors.push(`${(err as Error).message} | SQL: ${sql.substring(0, 200)}`)
      console.warn(
        `[SchemaReconciler] Migration failed for project ${projectId}:`,
        (err as Error).message,
        '\nSQL:', sql.substring(0, 200),
      )
    } finally {
      client.release()
    }
  }

  return { applied, failed, errors }
}
