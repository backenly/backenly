/**
 * MCP Runtime DB — shared CRUD helpers for /api/mcp/db/*.
 *
 * These mirror the four data tools in catalog.ts:
 *   db_query, db_insert, db_update, db_delete.
 *
 * Implementation choice: we do NOT proxy to /api/v1/{projectId}/database/* over
 * HTTP. That would re-walk the v1 middleware stack, re-validate the API key,
 * and re-classify the WAF — adding ~50ms per call for no extra safety, since
 * we are already authenticated as the project owner.
 *
 * Instead we build the SQL the same way the v1 routes do (column-name regex
 * validation, parameterised values, table existence check) but skip the RLS
 * user-context block because MCP keys are server-to-server tools held by the
 * project owner — they have admin rights to their own workspace by design.
 */

import { prisma } from '@/lib/db/prisma'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { explainDbError, type QueryContext } from '@/lib/db/query-errors'

/**
 * Run a fully schema-qualified statement as the project owner with the
 * service-role RLS context set (app.is_service_role = 'true'). Every workspace
 * policy carries an `is_service_role = 'true'` escape clause, so this is the
 * correct way for an owner-held MCP key to read/seed/maintain workspace tables
 * regardless of the per-table RLS template. Previously these helpers went
 * through executeInWorkspaceSchema, which set NO user context — so FORCE-RLS'd
 * tables (the default for any owner-column table) denied every insert/update
 * and filtered every read to zero rows, contradicting the tool contract
 * ("bypasses end-user RLS").
 */
async function runAsServiceRole<T = any>(
  sql: string,
  values: unknown[] = [],
  ctx?: QueryContext,
): Promise<T[]> {
  try {
    return await executeWithUserContext<T>('', true, sql, values)
  } catch (err) {
    // Pass the bind context so the error can name the offending column even
    // when PostgreSQL reported only a type and a value (SQLSTATE 22007/22P02).
    throw explainDbError(err, ctx)
  }
}

// Error formatting lives in lib/db/query-errors.ts. It replaced a lookup table
// that mapped each SQLSTATE to one fixed sentence — e.g. 42804 always became
// "Type mismatch — a value has the wrong type for its column." That discarded
// the column name, the expected type and the offending value, so an agent had
// no way to correct itself and fell into blind retry loops.

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i
const VALID_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$contains', '$ilike'])

function schemaFor(projectId: string): string {
  return `workspace_${projectId}`
}

async function assertTable(projectId: string, tableName: string): Promise<void> {
  if (!IDENT.test(tableName)) {
    throw new Error(`Invalid table name "${tableName}".`)
  }
  const rec = await prisma.table.findFirst({
    where: { projectId, name: tableName.toLowerCase() },
    select: { id: true },
  })
  if (!rec) throw new Error(`Table "${tableName}" not found in this project.`)
}

/**
 * Map of column name → PostgreSQL data_type for a workspace table. Read from the
 * live catalog so casts always match reality.
 */
async function columnTypes(schema: string, table: string): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    schema, table,
  )
  return new Map(rows.map((r) => [r.column_name, r.data_type]))
}

/**
 * Prisma's $queryRawUnsafe binds each parameter with a PostgreSQL type derived
 * from the JS *runtime* type (string → text, number → int8/float8, boolean →
 * bool). PostgreSQL will not implicitly cast between those and a strictly-typed
 * column in a VALUES / SET / WHERE position, so it raises SQLSTATE 42804
 * ("column is of type X but expression is of type text").
 *
 * The old implementation only cast uuid/json/jsonb and assumed "numeric,
 * boolean, and timestamp columns coerce from text fine". They do not. That
 * assumption made every timestamp column literally unwritable through these
 * tools — no ISO string, epoch number, or 'YYYY-MM-DD HH:MM:SS' spelling could
 * be inserted — and any NOT NULL timestamp column therefore blocked inserts
 * into its table entirely. String-encoded numerics ("2500.00", the shape JSON
 * clients naturally send) failed the same way.
 *
 * The fix is to stop depending on inference: every strictly-typed column gets
 * an explicit `::type` cast, and its value is bound as TEXT so PostgreSQL uses
 * its own input parser — the same contract a REST layer applies when turning
 * JSON into column values. Text-family columns need no cast and bind natively.
 */
export function castTarget(dataType: string | undefined): string {
  switch (dataType) {
    case 'uuid':                        return 'uuid'
    case 'json':                        return 'json'
    case 'jsonb':                       return 'jsonb'
    case 'timestamp with time zone':    return 'timestamptz'
    case 'timestamp without time zone': return 'timestamp'
    case 'date':                        return 'date'
    case 'time without time zone':      return 'time'
    case 'time with time zone':         return 'timetz'
    case 'interval':                    return 'interval'
    case 'numeric':                     return 'numeric'
    case 'double precision':            return 'double precision'
    case 'real':                        return 'real'
    case 'smallint':                    return 'smallint'
    case 'integer':                     return 'integer'
    case 'bigint':                      return 'bigint'
    case 'boolean':                     return 'boolean'
    // text / character varying / character → no cast needed.
    // ARRAY → pg handles a JS array natively; a text cast would corrupt it.
    default:                            return ''
  }
}

function castSuffix(dataType: string | undefined): string {
  const target = castTarget(dataType)
  return target ? `::${target}` : ''
}

/**
 * Prepare a JS value for binding against a column of the given data_type.
 * Pairs with castSuffix(): anything that gets a `::type` cast is bound as text
 * so PostgreSQL parses it, which is what makes ISO timestamps, epoch-style
 * numbers, "true"/"false", and string-encoded numerics all work uniformly.
 */
export function coerceValue(dataType: string | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null

  if (dataType === 'json' || dataType === 'jsonb') {
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }

  // Arrays bind natively — pg builds the array literal itself.
  if (dataType === 'ARRAY') return value

  if (castTarget(dataType)) {
    if (value instanceof Date) return value.toISOString()
    return typeof value === 'string' ? value : String(value)
  }

  return value
}

/**
 * Translate a filter object into a WHERE clause + values. Supports both
 * shorthand (col: value → "col = ?") and operator-objects (col: { $gt: 5 }).
 *
 *   { status: "published", views: { $gt: 100 }, id: { $in: [1,2,3] } }
 *     → WHERE "status" = $1 AND "views" > $2 AND "id" IN ($3, $4, $5)
 */
function buildWhere(
  filter: Record<string, unknown> | undefined,
  startIdx = 1,
  types?: Map<string, string>,
): { sql: string; values: unknown[]; nextIdx: number } {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return { sql: '', values: [], nextIdx: startIdx }
  }
  const parts: string[] = []
  const values: unknown[] = []
  let idx = startIdx
  // Cast text params to strict types so equality/comparison filters on a
  // uuid/timestamp/numeric column don't fail with "operator does not exist".
  // `bind` mirrors the cast on the value side — without it, filtering a
  // timestamp column (`{ occurred_at: { $gt: "2026-01-01" } }`) hit the same
  // 42804 that made timestamp inserts impossible.
  const cs = (col: string) => castSuffix(types?.get(col))
  const bind = (col: string, v: unknown) => coerceValue(types?.get(col), v)

  for (const [col, raw] of Object.entries(filter)) {
    if (!IDENT.test(col)) continue
    if (raw === null) {
      parts.push(`"${col}" IS NULL`)
      continue
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const ops = raw as Record<string, unknown>
      for (const [op, v] of Object.entries(ops)) {
        if (!VALID_OPS.has(op)) continue
        if (op === '$gt')       { parts.push(`"${col}" > $${idx++}${cs(col)}`);  values.push(bind(col, v)) }
        else if (op === '$gte') { parts.push(`"${col}" >= $${idx++}${cs(col)}`); values.push(bind(col, v)) }
        else if (op === '$lt')  { parts.push(`"${col}" < $${idx++}${cs(col)}`);  values.push(bind(col, v)) }
        else if (op === '$lte') { parts.push(`"${col}" <= $${idx++}${cs(col)}`); values.push(bind(col, v)) }
        else if (op === '$ne')  { parts.push(`"${col}" != $${idx++}${cs(col)}`); values.push(bind(col, v)) }
        else if (op === '$contains') {
          parts.push(`"${col}" ILIKE $${idx++}`)
          values.push(`%${String(v)}%`)
        }
        else if (op === '$ilike') {
          parts.push(`"${col}" ILIKE $${idx++}`)
          values.push(String(v))
        }
        else if (op === '$in' && Array.isArray(v) && v.length > 0) {
          const ph = v.map(() => `$${idx++}${cs(col)}`).join(', ')
          parts.push(`"${col}" IN (${ph})`)
          values.push(...v.map((item) => bind(col, item)))
        }
      }
      continue
    }
    parts.push(`"${col}" = $${idx++}${cs(col)}`)
    values.push(bind(col, raw))
  }

  return {
    sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '',
    values,
    nextIdx: idx,
  }
}

export interface DbQueryInput {
  table: string
  filter?: Record<string, unknown>
  limit?: number
  offset?: number
  orderBy?: Record<string, 'asc' | 'desc' | 'ASC' | 'DESC'>
}

export async function dbQuery(projectId: string, input: DbQueryInput) {
  const table = String(input.table || '').toLowerCase()
  await assertTable(projectId, table)
  const schema = schemaFor(projectId)
  const limit = Math.min(Math.max(1, Number(input.limit ?? 50)), 200)
  const offset = Math.max(0, Number(input.offset ?? 0))

  const types = await columnTypes(schema, table)
  const where = buildWhere(input.filter, 1, types)
  let orderBy = ''
  if (input.orderBy && typeof input.orderBy === 'object') {
    const parts = Object.entries(input.orderBy)
      .filter(([c]) => IDENT.test(c))
      .map(([c, dir]) => `"${c}" ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
    if (parts.length) orderBy = ` ORDER BY ${parts.join(', ')}`
  }

  const sql =
    `SELECT * FROM "${schema}"."${table}"${where.sql}${orderBy} LIMIT ${limit} OFFSET ${offset}`
  const rows = await runAsServiceRole(sql, where.values, {
    table, columns: Object.keys(input.filter ?? {}), values: where.values, types,
  })
  return { rows: Array.isArray(rows) ? rows : [], count: Array.isArray(rows) ? rows.length : 0 }
}

export interface DbInsertInput {
  table: string
  row: Record<string, unknown>
}

export async function dbInsert(projectId: string, input: DbInsertInput) {
  const table = String(input.table || '').toLowerCase()
  await assertTable(projectId, table)
  const schema = schemaFor(projectId)
  const row = input.row ?? {}
  const cols = Object.keys(row).filter((c) => IDENT.test(c))
  if (cols.length === 0) throw new Error('`row` must include at least one valid column.')

  const types = await columnTypes(schema, table)
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const placeholders = cols.map((c, i) => `$${i + 1}${castSuffix(types.get(c))}`).join(', ')
  const values = cols.map((c) => coerceValue(types.get(c), (row as any)[c]))
  const sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${placeholders}) RETURNING *`
  const result = await runAsServiceRole(sql, values, { table, columns: cols, values, types })
  return { row: Array.isArray(result) ? result[0] : null }
}

export interface DbUpdateInput {
  table: string
  filter: Record<string, unknown>
  patch: Record<string, unknown>
}

export async function dbUpdate(projectId: string, input: DbUpdateInput) {
  const table = String(input.table || '').toLowerCase()
  await assertTable(projectId, table)
  const schema = schemaFor(projectId)

  const patch = input.patch ?? {}
  const setCols = Object.keys(patch).filter((c) => IDENT.test(c))
  if (setCols.length === 0) throw new Error('`patch` must include at least one valid column.')

  // Refuse empty filters — that would be a table-wide UPDATE. Forcing a
  // filter is the same guardrail the dashboard uses; the MCP host LLM should
  // not be able to accidentally clobber every row in a table.
  if (!input.filter || Object.keys(input.filter).length === 0) {
    throw new Error('`filter` is required and must be non-empty (refusing table-wide UPDATE).')
  }

  const types = await columnTypes(schema, table)
  let idx = 1
  const setSqlParts: string[] = []
  const setValues: unknown[] = []
  for (const c of setCols) {
    setSqlParts.push(`"${c}" = $${idx++}${castSuffix(types.get(c))}`)
    setValues.push(coerceValue(types.get(c), (patch as any)[c]))
  }

  const where = buildWhere(input.filter, idx, types)
  if (!where.sql) throw new Error('`filter` is required (refusing table-wide UPDATE).')

  const sql = `UPDATE "${schema}"."${table}" SET ${setSqlParts.join(', ')}${where.sql} RETURNING *`
  const result = await runAsServiceRole(sql, [...setValues, ...where.values], {
    table,
    columns: [...setCols, ...Object.keys(input.filter ?? {})],
    values: [...setValues, ...where.values],
    types,
  })
  const rows = Array.isArray(result) ? result : []
  return { updated: rows.length, rows }
}

export interface DbDeleteInput {
  table: string
  filter: Record<string, unknown>
}

export async function dbDelete(projectId: string, input: DbDeleteInput) {
  const table = String(input.table || '').toLowerCase()
  await assertTable(projectId, table)
  const schema = schemaFor(projectId)

  // Same guardrail as update: no filter, no go.
  if (!input.filter || Object.keys(input.filter).length === 0) {
    throw new Error('`filter` is required and must be non-empty (refusing table-wide DELETE).')
  }

  const types = await columnTypes(schema, table)
  const where = buildWhere(input.filter, 1, types)
  if (!where.sql) throw new Error('`filter` is required (refusing table-wide DELETE).')

  const sql = `DELETE FROM "${schema}"."${table}"${where.sql} RETURNING id`
  const result = await runAsServiceRole(sql, where.values, {
    table, columns: Object.keys(input.filter ?? {}), values: where.values, types,
  })
  const rows = Array.isArray(result) ? result : []
  return { deleted: rows.length }
}
