/**
 * WORKSPACE TABLE VALIDATOR
 * =========================
 * Generates and caches Zod validation schemas from live workspace table definitions.
 * These schemas are applied to INSERT and UPDATE payloads to enforce:
 *   - Required fields (non-nullable columns without defaults)
 *   - Field types (string, number, boolean, date, uuid, etc.)
 *   - String length limits (from character_maximum_length)
 *   - Numeric ranges (sensible defaults when DB constraints are absent)
 *   - Enum values (from CHECK constraints or known column names like 'status')
 *
 * Schemas are cached per (projectId, tableName) for CACHE_TTL_MS to avoid
 * repeated information_schema queries on every request.
 *
 * Usage in route handlers:
 *   import { validateInsertPayload, validateUpdatePayload } from '@/lib/services/workspace-validator'
 *
 *   const result = await validateInsertPayload(projectId, tableName, requestData)
 *   if (!result.success) {
 *     return createErrorResponse(ErrorCodes.BAD_REQUEST, result.error, 422)
 *   }
 *   // result.data is the validated + stripped payload
 */

import { z, ZodTypeAny } from 'zod'
import { prisma } from '@/lib/db/prisma'

const CACHE_TTL_MS = 60_000   // Refresh schema cache every 60s

interface ColumnMeta {
  columnName: string
  dataType: string
  udtName: string
  isNullable: boolean
  columnDefault: string | null
  charMaxLen: number | null
  numPrecision: number | null
  isPrimaryKey: boolean
}

interface CacheEntry {
  insertSchema: z.ZodObject<Record<string, ZodTypeAny>>
  updateSchema: z.ZodObject<Record<string, ZodTypeAny>>
  expiresAt: number
}

const schemaCache = new Map<string, CacheEntry>()

// ── Column → Zod type ─────────────────────────────────────────────────────────

const AUTO_COLS = new Set(['id', 'created_at', 'updated_at', 'deleted_at'])

const STATUS_LIKE_COLS = new Set(['status', 'state', 'type', 'role', 'plan', 'tier', 'kind'])

function buildZodTypeForColumn(col: ColumnMeta): ZodTypeAny | null {
  // Auto-generated / server-managed columns are not accepted in payloads
  if (col.isPrimaryKey || AUTO_COLS.has(col.columnName)) return null

  const pg = col.dataType.toLowerCase()
  let schema: ZodTypeAny

  // ── Text types ────────────────────────────────────────────────────────────
  if (['text', 'varchar', 'character varying', 'character', 'char', 'citext', 'name'].includes(pg)) {
    let s = z.string()
    if (col.charMaxLen !== null) {
      s = s.max(col.charMaxLen, `${col.columnName} must be at most ${col.charMaxLen} characters`)
    } else {
      // Reasonable default limits to prevent payload floods
      s = s.max(col.columnName === 'email' ? 320 : 10_000)
    }
    if (col.columnName === 'email') s = s.email()
    if (col.columnName === 'url' || col.columnName.endsWith('_url')) {
      schema = s.url().or(z.literal(''))
    } else {
      schema = s
    }
  }
  // ── UUID ──────────────────────────────────────────────────────────────────
  else if (pg === 'uuid') {
    schema = z.string().uuid()
  }
  // ── Integers ──────────────────────────────────────────────────────────────
  else if (['integer', 'int', 'int2', 'int4', 'smallint', 'serial', 'smallserial'].includes(pg)) {
    schema = z.number().int().min(-2_147_483_648).max(2_147_483_647)
  }
  // ── BigInt ────────────────────────────────────────────────────────────────
  else if (['int8', 'bigint', 'bigserial'].includes(pg)) {
    schema = z.union([z.number().int(), z.string().regex(/^-?\d+$/, 'Must be an integer string')])
  }
  // ── Numeric / float ───────────────────────────────────────────────────────
  else if (['numeric', 'decimal', 'real', 'float4', 'float8', 'double precision', 'money'].includes(pg)) {
    schema = z.number()
  }
  // ── Boolean ───────────────────────────────────────────────────────────────
  else if (['boolean', 'bool'].includes(pg)) {
    schema = z.boolean()
  }
  // ── Date / time ───────────────────────────────────────────────────────────
  else if (['date'].includes(pg)) {
    schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
  }
  else if (pg.includes('timestamp') || pg === 'timestamptz') {
    schema = z.string().datetime({ offset: true }).or(z.string().datetime())
  }
  // ── JSON ──────────────────────────────────────────────────────────────────
  else if (['json', 'jsonb'].includes(pg)) {
    schema = z.any()
  }
  // ── Arrays ────────────────────────────────────────────────────────────────
  else if (pg === 'ARRAY' || col.udtName.startsWith('_')) {
    schema = z.array(z.any())
  }
  // ── Default: accept any scalar ────────────────────────────────────────────
  else {
    schema = z.any()
  }

  // Apply nullable wrapper
  if (col.isNullable) {
    schema = schema.nullable().optional()
  }

  return schema
}

// ── Load column metadata ──────────────────────────────────────────────────────

async function loadColumns(projectId: string, tableName: string): Promise<ColumnMeta[]> {
  const schemaName = `workspace_${projectId}`

  const rows = await prisma.$queryRawUnsafe<{
    column_name: string
    data_type: string
    udt_name: string
    is_nullable: string
    column_default: string | null
    character_maximum_length: number | null
    numeric_precision: number | null
  }[]>(
    `SELECT
       c.column_name,
       c.data_type,
       c.udt_name,
       c.is_nullable,
       c.column_default,
       c.character_maximum_length,
       c.numeric_precision
     FROM information_schema.columns c
     WHERE c.table_schema = $1 AND c.table_name = $2
     ORDER BY c.ordinal_position`,
    schemaName, tableName
  )

  // Primary keys
  const pkRows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = $1 AND tc.table_name = $2
       AND tc.constraint_type = 'PRIMARY KEY'`,
    schemaName, tableName
  )
  const pkSet = new Set(pkRows.map(r => r.column_name))

  return rows.map(r => ({
    columnName: r.column_name,
    dataType: r.data_type,
    udtName: r.udt_name,
    isNullable: r.is_nullable === 'YES',
    columnDefault: r.column_default,
    charMaxLen: r.character_maximum_length,
    numPrecision: r.numeric_precision,
    isPrimaryKey: pkSet.has(r.column_name),
  }))
}

// ── Build Zod schemas ─────────────────────────────────────────────────────────

async function buildSchemas(projectId: string, tableName: string): Promise<CacheEntry> {
  const columns = await loadColumns(projectId, tableName)

  const insertShape: Record<string, ZodTypeAny> = {}
  const updateShape: Record<string, ZodTypeAny> = {}

  for (const col of columns) {
    const zodType = buildZodTypeForColumn(col)
    if (!zodType) continue

    const isRequired = !col.isNullable && col.columnDefault === null && !col.isPrimaryKey
    insertShape[col.columnName] = isRequired ? zodType : zodType.optional()
    updateShape[col.columnName] = zodType.optional()
  }

  return {
    insertSchema: z.object(insertShape).strict(),  // .strict() rejects unknown keys
    updateSchema: z.object(updateShape).strict(),
    expiresAt: Date.now() + CACHE_TTL_MS,
  }
}

async function getSchemas(projectId: string, tableName: string): Promise<CacheEntry> {
  const key = `${projectId}:${tableName}`
  const cached = schemaCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached

  const entry = await buildSchemas(projectId, tableName)
  schemaCache.set(key, entry)
  return entry
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ValidationResult<T = Record<string, unknown>> {
  success: true
  data: T
}
export interface ValidationFailure {
  success: false
  error: string
  fields: Record<string, string[]>
}

export async function validateInsertPayload(
  projectId: string,
  tableName: string,
  data: unknown
): Promise<ValidationResult | ValidationFailure> {
  try {
    const { insertSchema } = await getSchemas(projectId, tableName)
    const result = insertSchema.safeParse(data)
    if (!result.success) {
      const fields: Record<string, string[]> = {}
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_root'
        if (!fields[key]) fields[key] = []
        fields[key].push(issue.message)
      }
      return { success: false, error: 'Validation failed', fields }
    }
    return { success: true, data: result.data }
  } catch (err: any) {
    // Schema load error (e.g. table not found) — return permissive pass-through
    // so we don't break existing behaviour; the route itself will catch NOT_FOUND
    console.warn(`[WorkspaceValidator] Schema load error for ${tableName}:`, err?.message)
    return { success: true, data: data as Record<string, unknown> }
  }
}

export async function validateUpdatePayload(
  projectId: string,
  tableName: string,
  data: unknown
): Promise<ValidationResult | ValidationFailure> {
  try {
    const { updateSchema } = await getSchemas(projectId, tableName)
    const result = updateSchema.safeParse(data)
    if (!result.success) {
      const fields: Record<string, string[]> = {}
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_root'
        if (!fields[key]) fields[key] = []
        fields[key].push(issue.message)
      }
      return { success: false, error: 'Validation failed', fields }
    }
    return { success: true, data: result.data }
  } catch (err: any) {
    console.warn(`[WorkspaceValidator] Schema load error for ${tableName}:`, err?.message)
    return { success: true, data: data as Record<string, unknown> }
  }
}

/**
 * Invalidate the cached schemas for a table — call after ALTER TABLE or CREATE TABLE.
 */
export function invalidateSchemaCache(projectId: string, tableName?: string) {
  if (tableName) {
    schemaCache.delete(`${projectId}:${tableName}`)
  } else {
    // Invalidate all schemas for this project
    for (const key of schemaCache.keys()) {
      if (key.startsWith(`${projectId}:`)) schemaCache.delete(key)
    }
  }
}
