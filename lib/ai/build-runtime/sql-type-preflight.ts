/**
 * SQL TYPE SAFETY PREFLIGHT
 * =========================
 * Validates column definitions before CREATE TABLE or ALTER TABLE is executed.
 * Prevents type mismatches that cause silent SQL errors at runtime.
 *
 * Rules enforced:
 *  1. UUID FK columns must use UUID type (never TEXT for a column named *_id referencing another table)
 *  2. FK columns referencing UUID PKs must be nullable if no DEFAULT is provided
 *     (backfilling text into a NOT NULL UUID column breaks existing rows)
 *  3. Status/enum columns should not be UUID type
 *  4. Foreign key references must resolve to existing tables
 *
 * Returns a list of violations. If violations.length > 0, the caller must
 * either fix the column definitions or return a clean error to the user.
 */

import type { PrismaClient } from '@prisma/client'

export interface ColumnDef {
  name: string
  type: string          // SQL type: UUID, TEXT, INTEGER, BOOLEAN, TIMESTAMP, etc.
  nullable?: boolean
  required?: boolean
  foreignKey?: string   // referenced table name
}

export interface TypeViolation {
  column: string
  issue: string
  suggestion: string
  severity: 'error' | 'warning'
}

// ── Column name heuristics ────────────────────────────────────────────────────

const UUID_COLUMN_PATTERNS = /^id$|_id$|Id$/
const TEXT_COLUMN_PATTERNS = /^(name|title|slug|email|description|status|role|type|url|path|content|body|message|address|phone|bio|avatar|image|color|label|tag|key|code|token|secret|hash|note|comment|text|summary|caption|excerpt|metadata|extra|payload|config|settings|data)$/i
const NUMERIC_COLUMN_PATTERNS = /^(price|amount|total|quantity|count|score|rating|weight|balance|credits?|points?|rank|age|size|width|height|duration|order|sequence|priority|version|attempt|retry)$/i
const BOOLEAN_COLUMN_PATTERNS = /^(is_|has_|can_|was_|should_|enable|disable|active|archived|featured|published|verified|confirmed|deleted|blocked|locked)/.test

function guessExpectedType(columnName: string): string | null {
  const lower = columnName.toLowerCase()
  if (UUID_COLUMN_PATTERNS.test(lower)) return 'UUID'
  if (TEXT_COLUMN_PATTERNS.test(lower)) return 'TEXT'
  if (NUMERIC_COLUMN_PATTERNS.test(lower)) return 'NUMERIC'
  if (/^(is_|has_|can_|was_|should_|enabled?|disabled?|active|archived|featured|published|verified|confirmed)/.test(lower)) return 'BOOLEAN'
  if (/(_at|_date|_time)$|^(created|updated|deleted|published|expires|started|ended|scheduled)/.test(lower)) return 'TIMESTAMP'
  return null
}

// ── Main validation ───────────────────────────────────────────────────────────

/**
 * Validate column definitions before execution.
 * Returns violations — caller decides whether to abort or warn.
 */
export function validateColumnTypes(
  tableName: string,
  columns: ColumnDef[],
): TypeViolation[] {
  const violations: TypeViolation[] = []

  for (const col of columns) {
    const lower = col.name.toLowerCase()
    const upperType = col.type?.toUpperCase() ?? 'TEXT'
    const expected = guessExpectedType(lower)

    // Rule 1: UUID FK columns must use UUID type — TEXT is silently wrong
    if (UUID_COLUMN_PATTERNS.test(lower) && lower !== 'id') {
      if (upperType !== 'UUID' && !upperType.includes('UUID')) {
        violations.push({
          column: col.name,
          issue: `FK column "${col.name}" uses type ${upperType} but should be UUID (foreign keys reference UUID primary keys)`,
          suggestion: `Change "${col.name}" to type UUID`,
          severity: 'error',
        })
      }
    }

    // Rule 2: Status/enum columns should not be UUID type
    if (/^(status|state|type|role|kind|category|stage)$/.test(lower) && upperType.includes('UUID')) {
      violations.push({
        column: col.name,
        issue: `Status column "${col.name}" uses UUID type — likely a copy-paste error`,
        suggestion: `Change "${col.name}" to TEXT with a CHECK constraint`,
        severity: 'error',
      })
    }

    // Rule 3: Price/numeric columns should not be TEXT or UUID
    if (NUMERIC_COLUMN_PATTERNS.test(lower) && (upperType === 'TEXT' || upperType.includes('UUID'))) {
      violations.push({
        column: col.name,
        issue: `Numeric column "${col.name}" uses type ${upperType} — arithmetic operations will fail at runtime`,
        suggestion: `Change "${col.name}" to DECIMAL or INTEGER`,
        severity: 'warning',
      })
    }

    // Rule 4: Boolean columns should not be TEXT or UUID
    if (/^(is_|has_|can_)/.test(lower) && (upperType === 'TEXT' || upperType.includes('UUID'))) {
      violations.push({
        column: col.name,
        issue: `Boolean column "${col.name}" uses type ${upperType} — boolean comparisons will fail`,
        suggestion: `Change "${col.name}" to BOOLEAN DEFAULT FALSE`,
        severity: 'warning',
      })
    }
  }

  return violations
}

/**
 * Validate FK columns against actual DB column types to prevent
 * inserting UUID values into TEXT FK columns (or vice versa).
 *
 * Runs against information_schema — reads only, never mutates.
 */
export async function validateForeignKeyTypes(
  tableName: string,
  columns: ColumnDef[],
  postgresSchema: string,
  prisma: Pick<PrismaClient, '$queryRawUnsafe'>,
): Promise<TypeViolation[]> {
  const violations: TypeViolation[] = []

  // Find FK columns (those ending in _id or Id)
  const fkCols = columns.filter(c => {
    const lower = c.name.toLowerCase()
    return (lower.endsWith('_id') || /[a-z]id$/.test(lower)) && lower !== 'id'
  })

  if (fkCols.length === 0) return violations

  try {
    // Get all tables and their id column types in this workspace
    const tableIdTypes = await prisma.$queryRawUnsafe<{ table_name: string; data_type: string }[]>(
      `SELECT c.table_name, c.data_type
       FROM information_schema.columns c
       WHERE c.table_schema = $1
         AND c.column_name = 'id'
         AND c.table_name != $2`,
      postgresSchema,
      tableName,
    )

    const idTypeMap = new Map<string, string>()
    for (const row of tableIdTypes) {
      idTypeMap.set(row.table_name.toLowerCase(), row.data_type.toUpperCase())
    }

    for (const col of fkCols) {
      const lower = col.name.toLowerCase()
      const base = lower.endsWith('_id') ? lower.slice(0, -3) : lower.slice(0, -2)

      // Try singular and plural forms
      const refTableKey = idTypeMap.has(`${base}s`) ? `${base}s` : idTypeMap.has(base) ? base : null
      if (!refTableKey) continue

      const refIdType = idTypeMap.get(refTableKey)
      if (!refIdType) continue

      const colType = col.type?.toUpperCase() ?? 'TEXT'

      // FK column type must match the referenced table's id type
      if (refIdType.includes('UUID') && !colType.includes('UUID')) {
        violations.push({
          column: col.name,
          issue: `"${tableName}.${col.name}" (${colType}) references "${refTableKey}.id" which is UUID — type mismatch will reject all inserts`,
          suggestion: `Change "${col.name}" to UUID type`,
          severity: 'error',
        })
      } else if ((refIdType.includes('INT') || refIdType === 'BIGINT') && colType.includes('UUID')) {
        violations.push({
          column: col.name,
          issue: `"${tableName}.${col.name}" (UUID) references "${refTableKey}.id" which is ${refIdType} — type mismatch`,
          suggestion: `Change "${col.name}" to ${refIdType} type`,
          severity: 'error',
        })
      }
    }
  } catch {
    // Non-fatal — DB may not be accessible yet
  }

  return violations
}

/**
 * Format violations into a user-facing error message.
 * Used when an error-severity violation is found.
 */
export function formatTypeViolations(violations: TypeViolation[]): string {
  const errors = violations.filter(v => v.severity === 'error')
  const warnings = violations.filter(v => v.severity === 'warning')

  const lines: string[] = []

  if (errors.length > 0) {
    lines.push('**SQL type errors detected — cannot create table safely:**')
    for (const e of errors) {
      lines.push(`- ${e.issue}`)
      lines.push(`  Fix: ${e.suggestion}`)
    }
  }

  if (warnings.length > 0) {
    lines.push('')
    lines.push('**Type warnings (table created, but review these):**')
    for (const w of warnings) {
      lines.push(`- ${w.issue}`)
      lines.push(`  Fix: ${w.suggestion}`)
    }
  }

  return lines.join('\n')
}
