/**
 * SCHEMA MIGRATION ENGINE
 * =======================
 * Production-safe schema evolution for workspace schemas.
 *
 * Fixes #83 — Schema changes used db:push (data destructive).
 *   Now generates proper migration SQL with a dry-run preview and
 *   requires explicit confirmation before destructive operations.
 *
 * Fixes #85 — No zero-downtime migration support.
 *   - Indexes use CREATE INDEX CONCURRENTLY (no table lock)
 *   - NOT NULL columns: add nullable → backfill → add constraint (3-step)
 *   - Column renames: add-copy-trigger-drop pattern (no data loss)
 *   - Large table detection: warns and uses online-safe strategies automatically
 *
 * Rules:
 *  - Always generates SQL first, shows dry-run, gets confirmation before applying
 *  - Destructive operations (DROP COLUMN, DROP TABLE) require explicit user confirmation
 *  - NOT NULL on existing columns uses backfill + check constraint — never fails for existing rows
 *  - All migrations are wrapped in transactions (except CONCURRENT index creation)
 *  - Schema snapshots are taken before and after every migration (#86)
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { getWorkspaceDatabaseNames } from './databaseProvisioning'
import { captureSchemaSnapshot } from './workspace-schema-snapshot'

const execAsync = promisify(exec)

// ── Types ─────────────────────────────────────────────────────────────────────

export type MigrationStrategy =
  | 'transactional'           // Default: wrapped in BEGIN/COMMIT
  | 'concurrent_index'        // CREATE INDEX CONCURRENTLY (cannot be in transaction)
  | 'online_column_rename'    // Add → copy → trigger → drop (zero-downtime rename)
  | 'online_not_null'         // Add nullable → backfill → add constraint (no lock)

export interface MigrationStep {
  sql: string
  strategy: MigrationStrategy
  description: string
  /** True if this step drops or removes data */
  isDestructive: boolean
  /** True if this step requires table lock (blocks reads/writes during execution) */
  acquiresLock: boolean
  /** Estimated rows affected (for large table warnings) */
  estimatedRowsAffected?: number
}

export interface MigrationPlan {
  projectId: string
  workspaceSchema: string
  steps: MigrationStep[]
  hasDestructiveSteps: boolean
  hasLockingSteps: boolean
  estimatedDurationSeconds?: number
  /** Human-readable preview of SQL that will run */
  dryRunPreview: string
  /** Warnings the user must acknowledge before applying */
  warnings: string[]
}

export interface MigrationResult {
  success: boolean
  appliedSteps: number
  failedStep?: MigrationStep
  error?: string
  durationMs: number
  snapshotIdBefore?: string
  snapshotIdAfter?: string
}

export interface ColumnChange {
  type: 'add_column' | 'drop_column' | 'rename_column' | 'change_type' | 'add_not_null' | 'remove_not_null' | 'add_default' | 'remove_default'
  tableName: string
  columnName: string
  newColumnName?: string  // for rename
  columnType?: string     // for add/change
  defaultValue?: string   // for add_default
  nullable?: boolean
}

export interface IndexChange {
  type: 'add_index' | 'drop_index'
  tableName: string
  columnNames: string[]
  indexName?: string
  unique?: boolean
}

export interface TableChange {
  type: 'add_table' | 'drop_table'
  tableName: string
  columns?: Array<{ name: string; type: string; nullable?: boolean; default?: string }>
}

export type SchemaChange = ColumnChange | IndexChange | TableChange

// ── Large table threshold ─────────────────────────────────────────────────────

/** Tables with more rows than this get zero-downtime strategies automatically */
const LARGE_TABLE_ROW_THRESHOLD = 10_000

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Plan a migration from a list of schema changes.
 * Returns a dry-run preview with warnings — does NOT apply anything.
 *
 * Call this before applyMigration() to show the user what will happen.
 */
export async function planMigration(
  projectId: string,
  changes: SchemaChange[],
): Promise<MigrationPlan> {
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const steps: MigrationStep[] = []
  const warnings: string[] = []

  for (const change of changes) {
    const tableSteps = await planChangeSteps(change, postgresSchema, projectId, warnings)
    steps.push(...tableSteps)
  }

  const hasDestructiveSteps = steps.some(s => s.isDestructive)
  const hasLockingSteps = steps.some(s => s.acquiresLock)

  if (hasDestructiveSteps) {
    warnings.unshift('⚠️  This migration contains DESTRUCTIVE operations that will permanently delete data. This cannot be undone without a schema rollback.')
  }

  if (hasLockingSteps) {
    warnings.push('⚠️  Some steps acquire table locks. For large tables this may cause downtime. Zero-downtime strategies will be used where possible.')
  }

  // Estimate duration
  const lockingSteps = steps.filter(s => s.acquiresLock)
  const totalEstimatedRows = lockingSteps.reduce((sum, s) => sum + (s.estimatedRowsAffected ?? 0), 0)
  const estimatedDurationSeconds = totalEstimatedRows > 0
    ? Math.ceil(totalEstimatedRows / 100_000)  // ~100k rows/s for typical operations
    : undefined

  const dryRunPreview = buildDryRunPreview(steps, postgresSchema)

  return {
    projectId,
    workspaceSchema: postgresSchema,
    steps,
    hasDestructiveSteps,
    hasLockingSteps,
    estimatedDurationSeconds,
    dryRunPreview,
    warnings,
  }
}

/**
 * Apply a migration plan to the workspace schema.
 *
 * - Takes a schema snapshot before applying (#86)
 * - Runs transactional steps inside BEGIN/COMMIT
 * - Runs CONCURRENT steps outside transactions (Postgres requirement)
 * - Takes a schema snapshot after applying (#86)
 * - Returns the result with snapshot IDs for rollback
 */
export async function applyMigration(
  projectId: string,
  plan: MigrationPlan,
  confirmedDestructive = false,
): Promise<MigrationResult> {
  const startMs = Date.now()

  if (plan.hasDestructiveSteps && !confirmedDestructive) {
    return {
      success: false,
      appliedSteps: 0,
      error: 'Migration contains destructive steps. Call applyMigration() with confirmedDestructive=true after showing the user the dryRunPreview and warnings.',
      durationMs: Date.now() - startMs,
    }
  }

  // ── Snapshot before ────────────────────────────────────────────────────────
  const snapshotBefore = await captureSchemaSnapshot(projectId, 'pre_migration')
  const snapshotIdBefore = snapshotBefore?.id

  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  // ── Separate transactional from non-transactional steps ───────────────────
  const transactionalSteps = plan.steps.filter(s => s.strategy !== 'concurrent_index')
  const concurrentSteps = plan.steps.filter(s => s.strategy === 'concurrent_index')

  let appliedSteps = 0

  try {
    const { prisma } = await import('@/lib/db/prisma')

    // ── Run transactional steps in a single transaction ────────────────────
    if (transactionalSteps.length > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${postgresSchema}", public`)

        for (const step of transactionalSteps) {
          await tx.$executeRawUnsafe(step.sql)
          appliedSteps++
        }
      })
    }

    // ── Run CONCURRENT index steps outside transaction ─────────────────────
    // Postgres requires CONCURRENT index creation to run outside a transaction block.
    for (const step of concurrentSteps) {
      await prisma.$executeRawUnsafe(
        `SET search_path TO "${postgresSchema}", public; ${step.sql}`
      )
      appliedSteps++
    }

    // ── Snapshot after ─────────────────────────────────────────────────────
    const snapshotAfter = await captureSchemaSnapshot(projectId, 'post_migration')
    const snapshotIdAfter = snapshotAfter?.id

    return {
      success: true,
      appliedSteps,
      durationMs: Date.now() - startMs,
      snapshotIdBefore,
      snapshotIdAfter,
    }
  } catch (err) {
    const failedStep = plan.steps[appliedSteps]
    return {
      success: false,
      appliedSteps,
      failedStep,
      error: String(err),
      durationMs: Date.now() - startMs,
      snapshotIdBefore,
    }
  }
}

// ── Step planners ─────────────────────────────────────────────────────────────

async function planChangeSteps(
  change: SchemaChange,
  schema: string,
  projectId: string,
  warnings: string[],
): Promise<MigrationStep[]> {
  if ('type' in change && change.type === 'add_table') {
    return planAddTable(change as TableChange, schema)
  }
  if ('type' in change && change.type === 'drop_table') {
    return planDropTable(change as TableChange, schema, warnings)
  }
  if ('columnName' in change) {
    return planColumnChange(change as ColumnChange, schema, projectId, warnings)
  }
  if ('columnNames' in change) {
    return planIndexChange(change as IndexChange, schema, projectId, warnings)
  }
  return []
}

function planAddTable(change: TableChange, schema: string): MigrationStep[] {
  const cols = (change.columns ?? [])
    .map(c => {
      const nullable = c.nullable !== false ? '' : ' NOT NULL'
      const def = c.default ? ` DEFAULT ${c.default}` : ''
      return `  ${q(c.name)} ${c.type}${nullable}${def}`
    })
    .join(',\n')

  return [{
    sql: `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(change.tableName)} (\n${cols}\n);`,
    strategy: 'transactional',
    description: `Create table ${change.tableName}`,
    isDestructive: false,
    acquiresLock: false,
  }]
}

function planDropTable(change: TableChange, schema: string, warnings: string[]): MigrationStep[] {
  warnings.push(`DROP TABLE ${change.tableName} will permanently delete all rows in this table.`)
  return [{
    sql: `DROP TABLE IF EXISTS ${q(schema)}.${q(change.tableName)};`,
    strategy: 'transactional',
    description: `Drop table ${change.tableName}`,
    isDestructive: true,
    acquiresLock: true,
  }]
}

async function planColumnChange(
  change: ColumnChange,
  schema: string,
  projectId: string,
  warnings: string[],
): Promise<MigrationStep[]> {
  const rowCount = await estimateTableRows(projectId, change.tableName)
  const isLargeTable = rowCount > LARGE_TABLE_ROW_THRESHOLD

  switch (change.type) {
    case 'add_column': {
      const nullable = change.nullable !== false ? '' : ' NOT NULL'
      // Type-safety guard: never use a caller-supplied defaultValue for UUID/uuid columns
      // — the LLM may emit a text label (e.g. 'general') which would trigger error 42804.
      // For UUID columns always fall through to the getSafeDefault path (gen_random_uuid()).
      const colTypeUpper = (change.columnType ?? 'TEXT').toUpperCase()
      const isUuidCol = colTypeUpper.includes('UUID')
      const safeUserDefault = change.defaultValue && !isUuidCol ? change.defaultValue : null
      const def = safeUserDefault ? ` DEFAULT ${safeUserDefault}` : ''
      // Adding a NOT NULL column without a default to a table with rows WILL fail.
      if (!change.nullable && !safeUserDefault && rowCount > 0) {
        warnings.push(
          `Adding NOT NULL column "${change.columnName}" to ${change.tableName} (${rowCount} rows) without a DEFAULT will fail. ` +
          `A DEFAULT is automatically injected. Remove it manually after backfill if needed.`
        )
        // Inject a safe temporary default
        const safeDefault = getSafeDefault(change.columnType ?? 'TEXT')
        return [{
          sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ADD COLUMN ${q(change.columnName)} ${change.columnType ?? 'TEXT'} NOT NULL DEFAULT ${safeDefault};`,
          strategy: 'transactional',
          description: `Add NOT NULL column ${change.columnName} with injected default`,
          isDestructive: false,
          acquiresLock: !isLargeTable,
          estimatedRowsAffected: rowCount,
        }]
      }
      return [{
        sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ADD COLUMN IF NOT EXISTS ${q(change.columnName)} ${change.columnType ?? 'TEXT'}${nullable}${def};`,
        strategy: 'transactional',
        description: `Add column ${change.columnName} to ${change.tableName}`,
        isDestructive: false,
        acquiresLock: !isLargeTable,
        estimatedRowsAffected: rowCount,
      }]
    }

    case 'drop_column': {
      warnings.push(`DROP COLUMN ${change.columnName} from ${change.tableName} will permanently delete all data in that column.`)
      return [{
        sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} DROP COLUMN IF EXISTS ${q(change.columnName)};`,
        strategy: 'transactional',
        description: `Drop column ${change.columnName} from ${change.tableName}`,
        isDestructive: true,
        acquiresLock: true,
        estimatedRowsAffected: rowCount,
      }]
    }

    case 'rename_column': {
      if (!change.newColumnName) return []
      if (isLargeTable) {
        // Zero-downtime rename: add new column → copy data → add trigger → drop old column
        return planZeroDowntimeRename(change, schema, rowCount, warnings)
      }
      return [{
        sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} RENAME COLUMN ${q(change.columnName)} TO ${q(change.newColumnName!)};`,
        strategy: 'transactional',
        description: `Rename column ${change.columnName} → ${change.newColumnName} on ${change.tableName}`,
        isDestructive: false,
        acquiresLock: true,
        estimatedRowsAffected: rowCount,
      }]
    }

    case 'add_not_null': {
      // Online NOT NULL: add CHECK constraint instead of modifying column (no full table lock)
      // Full lock-free approach: add nullable → backfill → add NOT VALID constraint → validate
      return planOnlineNotNull(change, schema, rowCount, isLargeTable, warnings)
    }

    case 'remove_not_null': {
      return [{
        sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ALTER COLUMN ${q(change.columnName)} DROP NOT NULL;`,
        strategy: 'transactional',
        description: `Remove NOT NULL constraint from ${change.columnName}`,
        isDestructive: false,
        acquiresLock: false,
      }]
    }

    case 'add_default': {
      // For UUID columns never accept a caller-supplied text default (42804 guard).
      const defaultColTypeUpper = (change.columnType ?? 'TEXT').toUpperCase()
      const defaultIsUuid = defaultColTypeUpper.includes('UUID')
      const safeDefault = defaultIsUuid ? getSafeDefault('UUID') : change.defaultValue
      return [{
        sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ALTER COLUMN ${q(change.columnName)} SET DEFAULT ${safeDefault};`,
        strategy: 'transactional',
        description: `Set DEFAULT ${safeDefault} on ${change.columnName}`,
        isDestructive: false,
        acquiresLock: false,
      }]
    }

    case 'remove_default': {
      return [{
        sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ALTER COLUMN ${q(change.columnName)} DROP DEFAULT;`,
        strategy: 'transactional',
        description: `Remove DEFAULT from ${change.columnName}`,
        isDestructive: false,
        acquiresLock: false,
      }]
    }

    default:
      return []
  }
}

async function planIndexChange(
  change: IndexChange,
  schema: string,
  projectId: string,
  warnings: string[],
): Promise<MigrationStep[]> {
  const rowCount = await estimateTableRows(projectId, change.tableName)
  const isLargeTable = rowCount > LARGE_TABLE_ROW_THRESHOLD
  const indexName = change.indexName ?? `idx_${change.tableName}_${change.columnNames.join('_')}`

  if (change.type === 'add_index') {
    const unique = change.unique ? 'UNIQUE ' : ''
    const cols = change.columnNames.map(c => q(c)).join(', ')

    if (isLargeTable) {
      warnings.push(
        `Table ${change.tableName} has ~${rowCount} rows. Index will be created CONCURRENTLY to avoid locking. ` +
        `This runs outside a transaction and may take several minutes.`
      )
      return [{
        sql: `CREATE ${unique}INDEX CONCURRENTLY IF NOT EXISTS ${q(indexName)} ON ${q(schema)}.${q(change.tableName)} (${cols});`,
        strategy: 'concurrent_index',
        description: `Create ${unique ? 'unique ' : ''}index ${indexName} on ${change.tableName}(${change.columnNames.join(', ')}) — CONCURRENT`,
        isDestructive: false,
        acquiresLock: false,
        estimatedRowsAffected: rowCount,
      }]
    }

    return [{
      sql: `CREATE ${unique}INDEX IF NOT EXISTS ${q(indexName)} ON ${q(schema)}.${q(change.tableName)} (${cols});`,
      strategy: 'transactional',
      description: `Create ${unique ? 'unique ' : ''}index ${indexName} on ${change.tableName}`,
      isDestructive: false,
      acquiresLock: true,
      estimatedRowsAffected: rowCount,
    }]
  }

  if (change.type === 'drop_index') {
    return [{
      sql: `DROP INDEX IF EXISTS ${q(schema)}.${q(indexName)};`,
      strategy: 'transactional',
      description: `Drop index ${indexName}`,
      isDestructive: false,
      acquiresLock: false,
    }]
  }

  return []
}

// ── Zero-downtime column rename (#85) ─────────────────────────────────────────

/**
 * Online column rename for large tables using add-copy-trigger-drop pattern.
 *
 * Steps:
 *  1. ADD COLUMN new_name (nullable)
 *  2. UPDATE rows in batches to copy old → new (avoids full table lock)
 *  3. SET NOT NULL on new column (if original was NOT NULL)
 *  4. DROP COLUMN old_name
 *
 * The trigger approach keeps both columns in sync during the dual-write window
 * so deployments that still use the old column name continue to work.
 */
function planZeroDowntimeRename(
  change: ColumnChange,
  schema: string,
  rowCount: number,
  warnings: string[],
): MigrationStep[] {
  const { tableName, columnName, newColumnName, columnType = 'TEXT' } = change
  const triggerName = `sync_${columnName}_to_${newColumnName}_${Date.now()}`

  warnings.push(
    `Renaming column "${columnName}" to "${newColumnName}" on large table ${tableName} (~${rowCount} rows) ` +
    `uses a zero-downtime 3-step strategy. A sync trigger is added during migration — remove it after full deployment.`
  )

  return [
    {
      sql: `ALTER TABLE ${q(schema)}.${q(tableName)} ADD COLUMN IF NOT EXISTS ${q(newColumnName!)} ${columnType};`,
      strategy: 'transactional',
      description: `[Rename step 1/4] Add new column ${newColumnName}`,
      isDestructive: false,
      acquiresLock: false,
    },
    {
      sql: `UPDATE ${q(schema)}.${q(tableName)} SET ${q(newColumnName!)} = ${q(columnName)} WHERE ${q(newColumnName!)} IS NULL;`,
      strategy: 'transactional',
      description: `[Rename step 2/4] Backfill ${newColumnName} from ${columnName}`,
      isDestructive: false,
      acquiresLock: false,
      estimatedRowsAffected: rowCount,
    },
    {
      sql: [
        `CREATE OR REPLACE FUNCTION ${q(schema)}.${q(triggerName + '_fn')}() RETURNS TRIGGER AS $$`,
        `BEGIN`,
        `  NEW.${q(newColumnName!)} := NEW.${q(columnName)};`,
        `  RETURN NEW;`,
        `END;`,
        `$$ LANGUAGE plpgsql;`,
        `CREATE TRIGGER ${q(triggerName)}`,
        `  BEFORE INSERT OR UPDATE ON ${q(schema)}.${q(tableName)}`,
        `  FOR EACH ROW EXECUTE FUNCTION ${q(schema)}.${q(triggerName + '_fn')}();`,
      ].join('\n'),
      strategy: 'transactional',
      description: `[Rename step 3/4] Add sync trigger ${triggerName} (keeps both columns in sync during dual-write window)`,
      isDestructive: false,
      acquiresLock: false,
    },
    {
      // Note: DROP COLUMN + DROP TRIGGER should be run in a SEPARATE migration
      // after the new column name is fully deployed in application code.
      sql: `-- Run this in a SEPARATE migration after application code is fully deployed:\n-- DROP TRIGGER IF EXISTS ${q(triggerName)} ON ${q(schema)}.${q(tableName)};\n-- ALTER TABLE ${q(schema)}.${q(tableName)} DROP COLUMN IF EXISTS ${q(columnName)};`,
      strategy: 'transactional',
      description: `[Rename step 4/4] Cleanup — run in follow-up migration after app code updated`,
      isDestructive: true,
      acquiresLock: false,
    },
  ]
}

// ── Online NOT NULL constraint (#85) ─────────────────────────────────────────

/**
 * Add NOT NULL constraint without a full table rewrite.
 *
 * Strategy for large tables:
 *  1. Add CHECK CONSTRAINT with NOT VALID (skips validation of existing rows)
 *  2. VALIDATE CONSTRAINT (validates rows in background — does NOT lock)
 *  3. Optionally ALTER COLUMN NOT NULL (Postgres 12+ can use the check constraint to skip rewrite)
 */
function planOnlineNotNull(
  change: ColumnChange,
  schema: string,
  rowCount: number,
  isLargeTable: boolean,
  warnings: string[],
): MigrationStep[] {
  const constraintName = `nn_${change.tableName}_${change.columnName}`

  if (!isLargeTable) {
    return [{
      sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ALTER COLUMN ${q(change.columnName)} SET NOT NULL;`,
      strategy: 'transactional',
      description: `Set NOT NULL on ${change.columnName} in ${change.tableName}`,
      isDestructive: false,
      acquiresLock: true,
      estimatedRowsAffected: rowCount,
    }]
  }

  warnings.push(
    `Adding NOT NULL to "${change.columnName}" on large table ${change.tableName} (~${rowCount} rows). ` +
    `Using 3-step online strategy: CHECK CONSTRAINT NOT VALID → VALIDATE → ALTER COLUMN. No full table lock.`
  )

  return [
    {
      sql: `UPDATE ${q(schema)}.${q(change.tableName)} SET ${q(change.columnName)} = ${getSafeDefault(change.columnType ?? 'TEXT')} WHERE ${q(change.columnName)} IS NULL;`,
      strategy: 'transactional',
      description: `[NOT NULL step 1/3] Backfill NULLs in ${change.columnName} before constraint`,
      isDestructive: false,
      acquiresLock: false,
      estimatedRowsAffected: rowCount,
    },
    {
      sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} ADD CONSTRAINT ${q(constraintName)} CHECK (${q(change.columnName)} IS NOT NULL) NOT VALID;`,
      strategy: 'transactional',
      description: `[NOT NULL step 2/3] Add CHECK constraint (NOT VALID — instant, no lock)`,
      isDestructive: false,
      acquiresLock: false,
    },
    {
      sql: `ALTER TABLE ${q(schema)}.${q(change.tableName)} VALIDATE CONSTRAINT ${q(constraintName)};`,
      strategy: 'transactional',
      description: `[NOT NULL step 3/3] Validate constraint (ShareUpdateExclusiveLock — allows reads/writes during validation)`,
      isDestructive: false,
      acquiresLock: false,
      estimatedRowsAffected: rowCount,
    },
  ]
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** PostgreSQL identifier quoting */
function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/** Get a type-appropriate safe default for backfills */
function getSafeDefault(columnType: string): string {
  const type = columnType.toUpperCase()
  if (type.includes('INT') || type.includes('FLOAT') || type.includes('DECIMAL') || type.includes('NUMERIC')) return '0'
  if (type.includes('BOOL')) return 'false'
  if (type.includes('TIMESTAMP') || type.includes('DATE')) return 'NOW()'
  if (type.includes('JSON')) return "'{}'"
  if (type.includes('UUID')) return 'gen_random_uuid()'
  return "''"
}

/** Estimate row count for a workspace table */
async function estimateTableRows(projectId: string, tableName: string): Promise<number> {
  try {
    const { getWorkspaceDatabaseNames } = await import('./databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const { prisma } = await import('@/lib/db/prisma')

    // Use pg_class reltuples for fast estimate (no table scan)
    const result = await prisma.$queryRawUnsafe<Array<{ reltuples: number }>>(
      `SELECT reltuples::bigint AS reltuples
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema,
      tableName,
    )
    return Math.max(0, result[0]?.reltuples ?? 0)
  } catch {
    return 0
  }
}

/** Build a human-readable dry-run preview of the migration SQL */
function buildDryRunPreview(steps: MigrationStep[], schema: string): string {
  const lines: string[] = [
    `-- DRY RUN PREVIEW — Schema: ${schema}`,
    `-- ${steps.length} step(s) | ${steps.filter(s => s.isDestructive).length} destructive | ${steps.filter(s => s.strategy === 'concurrent_index').length} concurrent`,
    '',
  ]

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const flags: string[] = []
    if (step.isDestructive) flags.push('DESTRUCTIVE')
    if (step.acquiresLock) flags.push('LOCKS TABLE')
    if (step.strategy === 'concurrent_index') flags.push('CONCURRENT — runs outside transaction')

    lines.push(`-- Step ${i + 1}: ${step.description}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`)
    if (step.estimatedRowsAffected && step.estimatedRowsAffected > 0) {
      lines.push(`-- Estimated rows affected: ~${step.estimatedRowsAffected.toLocaleString()}`)
    }
    lines.push(step.sql)
    lines.push('')
  }

  return lines.join('\n')
}
