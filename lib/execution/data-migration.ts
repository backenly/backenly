/**
 * TYPED DATA MIGRATIONS
 * ======================
 * Schema evolution WITH data — the part of a backend engineer's job that goes
 * beyond add/drop column: backfills, column splits/merges, type changes with
 * live data, and value normalization.
 *
 * Design rules (non-negotiable):
 *   - NO raw SQL from callers. Every migration is one of the typed operations
 *     below; identifiers are validated against the live information_schema and
 *     values are parameterized. This keeps the raw-SQL non-feature intact.
 *   - Checkpoint first. Before mutating, the affected table is copied to
 *     "_dm_backup_{ts}_{table}" inside the SAME transaction as the migration,
 *     so a failed migration leaves no backup litter and a successful one is
 *     restorable via rollbackDataMigration().
 *   - Atomic. All operations in a migration run inside one transaction —
 *     either the whole migration lands or none of it does.
 *   - Dry-run first-class. estimateDataMigration() reports affected-row counts
 *     without touching anything, so the AI (and the user) can see the blast
 *     radius before approving.
 */

import { prisma } from '@/lib/db'
import { rlsSessionSql, rlsSessionParams } from '@/lib/services/rls-session'

// ── Operation types ────────────────────────────────────────────────────────────

export type DataMigrationOp =
  | {
      /** Fill a column's NULLs (or all rows) with a constant or another column. */
      op: 'backfill'
      table: string
      column: string
      /** Constant value to write (mutually exclusive with fromColumn). */
      value?: string | number | boolean | null
      /** Copy from this column instead of a constant. */
      fromColumn?: string
      /** Only rows where the column IS NULL (default true — the safe mode). */
      onlyNull?: boolean
    }
  | {
      /** Split "a, b" style text into new columns using a separator. */
      op: 'split_column'
      table: string
      source: string
      separator: string
      /** New (or existing text) columns, in part order: first part → targets[0]. */
      targets: string[]
    }
  | {
      /** Concatenate columns into a new (or existing text) column. */
      op: 'merge_columns'
      table: string
      sources: string[]
      target: string
      separator: string
    }
  | {
      /** Change a column's type, converting existing data. */
      op: 'cast_column'
      table: string
      column: string
      toType: 'integer' | 'bigint' | 'numeric' | 'boolean' | 'timestamptz' | 'date' | 'text' | 'uuid' | 'jsonb'
      /** 'fail' aborts on any unconvertible value (default); 'null' converts them to NULL. */
      onError?: 'fail' | 'null'
    }
  | {
      /** Rewrite values via an explicit mapping (e.g. unify status spellings). */
      op: 'normalize_values'
      table: string
      column: string
      mapping: Record<string, string>
    }

export interface DataMigrationEstimate {
  table: string
  op: string
  affectedRows: number
  totalRows: number
  detail: string
}

export interface DataMigrationResult {
  success: boolean
  applied: Array<{ op: string; table: string; affectedRows: number }>
  /** Name of the in-schema backup table (restore with rollbackDataMigration). */
  backupTables: Record<string, string>
  error?: string
}

// ── Validation ─────────────────────────────────────────────────────────────────

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertIdent(name: string, what: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid ${what} "${name}" — identifiers must match [a-zA-Z_][a-zA-Z0-9_]*`)
  }
}

async function loadColumns(schemaName: string, table: string): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    schemaName, table,
  )
  if (rows.length === 0) throw new Error(`Table "${table}" does not exist in this project.`)
  return new Map(rows.map(r => [r.column_name, r.data_type]))
}

/**
 * Per-type validity predicate used by cast_column onError:'null'. Only types
 * whose validity is regex-checkable are listed — timestamptz/date/jsonb can't
 * be validated without PG 16's pg_input_is_valid, so for those onError:'null'
 * is rejected and the caller must use 'fail' (abort on first bad value).
 */
const CAST_GUARDS: Record<string, (col: string) => string> = {
  integer:     c => `${c} ~ '^\\s*-?\\d+\\s*$'`,
  bigint:      c => `${c} ~ '^\\s*-?\\d+\\s*$'`,
  numeric:     c => `${c} ~ '^\\s*-?\\d+(\\.\\d+)?\\s*$'`,
  boolean:     c => `lower(trim(${c})) IN ('true','false','t','f','yes','no','y','n','1','0','on','off')`,
  uuid:        c => `${c} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
  text:        _ => 'TRUE',
}

// ── SQL builders (identifiers validated; user VALUES always parameterized) ────

interface BuiltOp {
  /** Statements executed in order inside the migration transaction. */
  statements: Array<{ sql: string; params: unknown[] }>
  /** Count of rows the op will touch (dry-run query). */
  countSql: { sql: string; params: unknown[] }
  detail: string
}

function buildOp(schemaName: string, columns: Map<string, string>, op: DataMigrationOp): BuiltOp {
  const q = (ident: string) => `"${ident}"`
  const t = `"${schemaName}".${q(op.table)}`

  switch (op.op) {
    case 'backfill': {
      assertIdent(op.column, 'column')
      if (!columns.has(op.column)) throw new Error(`Column "${op.column}" does not exist on "${op.table}".`)
      if (op.fromColumn !== undefined && op.value !== undefined) {
        throw new Error('backfill: provide either `value` or `fromColumn`, not both.')
      }
      const onlyNull = op.onlyNull !== false
      const where = onlyNull ? `WHERE ${q(op.column)} IS NULL` : ''
      if (op.fromColumn !== undefined) {
        assertIdent(op.fromColumn, 'fromColumn')
        if (!columns.has(op.fromColumn)) throw new Error(`Column "${op.fromColumn}" does not exist on "${op.table}".`)
        return {
          statements: [{ sql: `UPDATE ${t} SET ${q(op.column)} = ${q(op.fromColumn)} ${where}`, params: [] }],
          countSql: { sql: `SELECT COUNT(*)::int AS n FROM ${t} ${where}`, params: [] },
          detail: `backfill ${op.table}.${op.column} from ${op.fromColumn}${onlyNull ? ' (NULL rows only)' : ''}`,
        }
      }
      if (op.value === undefined) throw new Error('backfill: `value` or `fromColumn` is required.')
      return {
        statements: [{ sql: `UPDATE ${t} SET ${q(op.column)} = $1 ${where}`, params: [op.value] }],
        countSql: { sql: `SELECT COUNT(*)::int AS n FROM ${t} ${where}`, params: [] },
        detail: `backfill ${op.table}.${op.column} = ${JSON.stringify(op.value)}${onlyNull ? ' (NULL rows only)' : ''}`,
      }
    }

    case 'split_column': {
      assertIdent(op.source, 'source column')
      if (!columns.has(op.source)) throw new Error(`Column "${op.source}" does not exist on "${op.table}".`)
      if (!Array.isArray(op.targets) || op.targets.length < 1 || op.targets.length > 8) {
        throw new Error('split_column: 1–8 target columns required.')
      }
      op.targets.forEach(c => assertIdent(c, 'target column'))
      if (typeof op.separator !== 'string' || op.separator.length === 0 || op.separator.length > 8) {
        throw new Error('split_column: separator must be 1–8 characters.')
      }
      const statements: Array<{ sql: string; params: unknown[] }> = []
      for (const target of op.targets) {
        if (!columns.has(target)) {
          statements.push({ sql: `ALTER TABLE ${t} ADD COLUMN ${q(target)} TEXT`, params: [] })
        }
      }
      const sets = op.targets
        .map((target, i) => `${q(target)} = NULLIF(trim(split_part(${q(op.source)}::text, $1, ${i + 1})), '')`)
        .join(', ')
      statements.push({
        sql: `UPDATE ${t} SET ${sets} WHERE ${q(op.source)} IS NOT NULL`,
        params: [op.separator],
      })
      return {
        statements,
        countSql: { sql: `SELECT COUNT(*)::int AS n FROM ${t} WHERE ${q(op.source)} IS NOT NULL`, params: [] },
        detail: `split ${op.table}.${op.source} by "${op.separator}" into ${op.targets.join(', ')} (source kept)`,
      }
    }

    case 'merge_columns': {
      if (!Array.isArray(op.sources) || op.sources.length < 2 || op.sources.length > 8) {
        throw new Error('merge_columns: 2–8 source columns required.')
      }
      op.sources.forEach(c => {
        assertIdent(c, 'source column')
        if (!columns.has(c)) throw new Error(`Column "${c}" does not exist on "${op.table}".`)
      })
      assertIdent(op.target, 'target column')
      if (typeof op.separator !== 'string' || op.separator.length > 8) {
        throw new Error('merge_columns: separator must be 0–8 characters.')
      }
      const statements: Array<{ sql: string; params: unknown[] }> = []
      if (!columns.has(op.target)) {
        statements.push({ sql: `ALTER TABLE ${t} ADD COLUMN ${q(op.target)} TEXT`, params: [] })
      }
      const args = op.sources.map(c => `${q(c)}::text`).join(', ')
      statements.push({
        sql: `UPDATE ${t} SET ${q(op.target)} = concat_ws($1, ${args})`,
        params: [op.separator],
      })
      return {
        statements,
        countSql: { sql: `SELECT COUNT(*)::int AS n FROM ${t}`, params: [] },
        detail: `merge ${op.sources.join(' + ')} into ${op.table}.${op.target}`,
      }
    }

    case 'cast_column': {
      assertIdent(op.column, 'column')
      if (!columns.has(op.column)) throw new Error(`Column "${op.column}" does not exist on "${op.table}".`)
      const VALID_TYPES = ['integer', 'bigint', 'numeric', 'boolean', 'timestamptz', 'date', 'text', 'uuid', 'jsonb']
      if (!VALID_TYPES.includes(op.toType)) throw new Error(`cast_column: unsupported target type "${op.toType}".`)
      const guard = CAST_GUARDS[op.toType]
      if (op.onError === 'null' && !guard) {
        throw new Error(
          `cast_column: onError:'null' is not supported for ${op.toType} — ` +
          `use onError:'fail' (the migration aborts and rolls back on the first unconvertible value).`,
        )
      }
      const c = q(op.column)
      const usingExpr = op.onError === 'null' && guard
        ? `CASE WHEN ${c} IS NULL THEN NULL WHEN ${guard(`${c}::text`)} THEN ${c}::text::${op.toType} ELSE NULL END`
        : `${c}::text::${op.toType}`
      return {
        statements: [{ sql: `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${op.toType} USING (${usingExpr})`, params: [] }],
        countSql: {
          sql: op.onError === 'null' && guard
            ? `SELECT COUNT(*)::int AS n FROM ${t} WHERE ${c} IS NOT NULL AND NOT (${guard(`${c}::text`)})`
            : `SELECT COUNT(*)::int AS n FROM ${t}`,
          params: [],
        },
        detail: op.onError === 'null'
          ? `cast ${op.table}.${op.column} → ${op.toType} (unconvertible values become NULL; dry-run count = rows that would null out)`
          : `cast ${op.table}.${op.column} → ${op.toType} (aborts if any value cannot convert)`,
      }
    }

    case 'normalize_values': {
      assertIdent(op.column, 'column')
      if (!columns.has(op.column)) throw new Error(`Column "${op.column}" does not exist on "${op.table}".`)
      const entries = Object.entries(op.mapping ?? {})
      if (entries.length === 0 || entries.length > 100) {
        throw new Error('normalize_values: 1–100 mapping entries required.')
      }
      const c = q(op.column)
      const params: unknown[] = []
      const whens = entries.map(([from, to]) => {
        params.push(from, to)
        return `WHEN ${c} = $${params.length - 1} THEN $${params.length}`
      }).join(' ')
      const froms = entries.map((_, i) => `$${params.length + i + 1}`).join(', ')
      const whereParams = entries.map(([from]) => from)
      return {
        statements: [{
          sql: `UPDATE ${t} SET ${c} = CASE ${whens} ELSE ${c} END WHERE ${c} IN (${froms})`,
          params: [...params, ...whereParams],
        }],
        countSql: {
          sql: `SELECT COUNT(*)::int AS n FROM ${t} WHERE ${c} IN (${entries.map((_, i) => `$${i + 1}`).join(', ')})`,
          params: entries.map(([from]) => from),
        },
        detail: `normalize ${entries.length} value(s) in ${op.table}.${op.column}`,
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Dry-run: affected-row counts per operation. Read-only. */
export async function estimateDataMigration(
  projectId: string,
  ops: DataMigrationOp[],
): Promise<DataMigrationEstimate[]> {
  const schemaName = `workspace_${projectId}`
  const out: DataMigrationEstimate[] = []
  for (const op of ops) {
    assertIdent(op.table, 'table')
    const columns = await loadColumns(schemaName, op.table)
    const built = buildOp(schemaName, columns, op)
    const [affected, total] = await Promise.all([
      prisma.$queryRawUnsafe<{ n: number }[]>(built.countSql.sql, ...built.countSql.params),
      prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT COUNT(*)::int AS n FROM "${schemaName}"."${op.table}"`,
      ),
    ])
    out.push({
      table: op.table,
      op: op.op,
      affectedRows: affected[0]?.n ?? 0,
      totalRows: total[0]?.n ?? 0,
      detail: built.detail,
    })
  }
  return out
}

/**
 * Apply a migration atomically: per-table checkpoint copies, then every
 * operation, in one transaction with service-role RLS context (data
 * migrations are owner-level operations by definition).
 */
export async function executeDataMigration(
  projectId: string,
  ops: DataMigrationOp[],
): Promise<DataMigrationResult> {
  const schemaName = `workspace_${projectId}`
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 20) {
    return { success: false, applied: [], backupTables: {}, error: 'A migration needs 1–20 operations.' }
  }

  // Validate + build everything BEFORE opening the transaction.
  let built: Array<{ op: DataMigrationOp; plan: BuiltOp }>
  try {
    built = []
    for (const op of ops) {
      assertIdent(op.table, 'table')
      const columns = await loadColumns(schemaName, op.table)
      built.push({ op, plan: buildOp(schemaName, columns, op) })
    }
  } catch (err: any) {
    return { success: false, applied: [], backupTables: {}, error: err?.message ?? String(err) }
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupTables: Record<string, string> = {}
  const applied: Array<{ op: string; table: string; affectedRows: number }> = []

  try {
    await prisma.$transaction(async (tx) => {
      // Service-role RLS context — FORCE-RLS tables must be fully visible to a
      // migration or it would silently transform a subset of rows.
      await tx.$executeRawUnsafe(
        rlsSessionSql(),
        ...rlsSessionParams({ userId: null, isServiceRole: true }),
      )

      // One checkpoint per distinct table, taken before its first mutation.
      for (const { op } of built) {
        if (!backupTables[op.table]) {
          const backupName = `_dm_backup_${stamp}_${op.table}`.slice(0, 63)
          await tx.$executeRawUnsafe(
            `CREATE TABLE "${schemaName}"."${backupName}" AS TABLE "${schemaName}"."${op.table}"`,
          )
          backupTables[op.table] = backupName
        }
      }

      for (const { op, plan } of built) {
        let affectedRows = 0
        for (const stmt of plan.statements) {
          const n = await tx.$executeRawUnsafe(stmt.sql, ...stmt.params)
          if (stmt.sql.startsWith('UPDATE')) affectedRows = Number(n) || 0
        }
        if (op.op === 'cast_column') {
          const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT COUNT(*)::int AS n FROM "${schemaName}"."${op.table}"`,
          )
          affectedRows = rows[0]?.n ?? 0
        }
        applied.push({ op: op.op, table: op.table, affectedRows })
      }
    }, { timeout: 120_000, maxWait: 10_000 })

    return { success: true, applied, backupTables }
  } catch (err: any) {
    // Transaction rolled back — backups created inside it are gone too.
    return {
      success: false,
      applied: [],
      backupTables: {},
      error: err?.message ?? String(err),
    }
  }
}

/**
 * Restore a table from a migration checkpoint by swapping the backup into
 * place. LIMITATION (documented, not hidden): the checkpoint was created with
 * CREATE TABLE AS, which copies data but not constraints/indexes/defaults —
 * a rollback restores every row and column type exactly, but PK/FK/index
 * definitions must be re-applied (the observer's missing-FK/missing-index
 * detectors will flag and offer to fix them on the next scan).
 */
export async function rollbackDataMigration(
  projectId: string,
  table: string,
  backupTable: string,
): Promise<{ success: boolean; error?: string }> {
  const schemaName = `workspace_${projectId}`
  try {
    assertIdent(table, 'table')
    if (!/^_dm_backup_\d{8,14}_[a-zA-Z_][a-zA-Z0-9_]*$/.test(backupTable)) {
      throw new Error(`"${backupTable}" is not a data-migration backup table.`)
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        rlsSessionSql(),
        ...rlsSessionParams({ userId: null, isServiceRole: true }),
      )
      await tx.$executeRawUnsafe(`DROP TABLE "${schemaName}"."${table}"`)
      await tx.$executeRawUnsafe(
        `ALTER TABLE "${schemaName}"."${backupTable}" RENAME TO "${table}"`,
      )
    }, { timeout: 60_000 })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) }
  }
}
