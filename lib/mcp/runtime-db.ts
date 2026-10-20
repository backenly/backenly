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
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { redactRows } from './read-query'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { explainDbError, type QueryContext } from '@/lib/db/query-errors'
import { typedParams, type TypedParams } from '@/lib/api/v1/typed-params'
import { FilterError, whereConditions } from '@/lib/api/v1/where'

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
  projectId: string,
  sql: string,
  values: unknown[] = [],
  ctx?: QueryContext,
): Promise<T[]> {
  try {
    return await executeWithUserContext<T>(projectId, '', true, sql, values)
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

/** The MCP filter operators, as the operators of the v1 vocabulary whereConditions builds. */
const V1_OPERATOR: Record<string, string> = {
  $gt: 'gt', $gte: 'gte', $lt: 'lt', $lte: 'lte', $ne: 'not', $in: 'in', $contains: 'contains',
}

function schemaFor(projectId: string): string {
  return `workspace_${projectId}`
}

/** Where a row tool reads or writes: main, or one preview branch of this project. */
interface Target {
  schema: string
  /** The branch's name, or null for main. */
  branch: string | null
}

/**
 * Resolve an optional branch id to the schema it names.
 *
 * Looked up on THIS project and only while active, then passed through the
 * gateway's own check, so an id from another project, or a merged branch whose
 * schema is gone, can never point a write anywhere but where it was meant.
 */
async function resolveTarget(projectId: string, branchId?: string | null): Promise<Target> {
  if (!branchId) return { schema: schemaFor(projectId), branch: null }
  const branch = await prisma.workspaceBranch.findFirst({
    where: { id: branchId, projectId, status: 'active' },
    select: { name: true, schemaName: true },
  })
  if (!branch) throw new Error('No active preview branch with that id on this project. branch { action: "list" } shows the ids.')
  const { profileForBranchSchema } = await import('@/lib/postgrest/gateway')
  return { schema: profileForBranchSchema(projectId, branch.schemaName), branch: branch.name }
}

async function assertTable(projectId: string, tableName: string, target: Target): Promise<void> {
  if (!IDENT.test(tableName)) {
    throw new Error(`Invalid table name "${tableName}".`)
  }
  // A branch's tables are in its catalog only; main's metadata does not list
  // a table created on the branch, and must not.
  if (target.branch) {
    // The branch schema lives in the project's database, in its region.
    const db = await workspaceRawClient(projectId)
    const found = await db.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS exists`,
      target.schema, tableName.toLowerCase(),
    )
    if (found[0]?.exists !== true || tableName.startsWith('_')) {
      throw new Error(`Table "${tableName}" not found on branch "${target.branch}".`)
    }
    return
  }
  const rec = await prisma.table.findFirst({
    where: { projectId, name: tableName.toLowerCase() },
    select: { id: true },
  })
  if (!rec) throw new Error(`Table "${tableName}" not found in this project.`)
}

/**
 * Map of column name → PostgreSQL data_type for a workspace table. Read from the
 * live catalog so casts always match reality: the catalog of the project's
 * database, in its region. Any other catalog answers no columns, and every
 * cast would silently be dropped.
 */
export async function columnTypes(projectId: string, schema: string, table: string): Promise<Map<string, string>> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
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
 * The conditions of a db_query, db_update or db_delete filter, each value
 * bound through `bound`, cast to its column's type. Shorthand compares
 * (col: value → "col" = value, col: null → "col" IS NULL); an operator object
 * uses the MCP names ($gt, $gte, $lt, $lte, $ne, $in, $contains, $ilike):
 *
 *   { status: "published", views: { $gt: 100 }, id: { $in: [1,2,3] } }
 *     → "status" = $1 AND "views" > $2::integer AND "id" IN ($3::integer, …)
 *
 * Built by whereConditions (lib/api/v1/where.ts), the builder both v1 data
 * servers use, so a filter that cannot be applied is refused (FilterError,
 * answered 400) rather than skipped. Skipping an invalid column name, an
 * unknown operator or an empty $in left the other conditions to choose the
 * rows, and db_update and db_delete, which run as the service role past every
 * RLS policy, then changed rows the caller had not named. $ne: null is
 * IS NOT NULL ("col" != NULL matched no row), and $in: [] matches no row.
 */
function mcpWhere(filter: unknown, bound: TypedParams, types: Map<string, string>): string[] {
  if (filter === undefined || filter === null) return []
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new FilterError('`filter` must be an object of column names and values.')
  }
  const conditions: string[] = []
  for (const [column, value] of Object.entries(filter as Record<string, unknown>)) {
    if (!IDENT.test(column)) throw new FilterError(`"${column}" is not a column name.`, column)
    const type = types.get(column)
    const object = typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
    // A json or jsonb column compares with a whole object; there only an
    // object naming a $ operator is one.
    const operators = object && (type === 'json' || type === 'jsonb'
      ? Object.keys(value).some((key) => key.startsWith('$'))
      : true)
    if (!operators) {
      conditions.push(value === null ? `"${column}" IS NULL` : `"${column}" = ${bound.bind(column, value)}`)
      continue
    }

    const v1: Record<string, unknown> = {}
    for (const [key, operand] of Object.entries(value as Record<string, unknown>)) {
      // A pattern used as written (whereConditions' contains wraps it in %).
      if (key === '$ilike') {
        conditions.push(`"${column}"::text ILIKE ${bound.raw(String(operand))}`)
        continue
      }
      // Own keys only: "constructor" is no operator.
      if (!Object.prototype.hasOwnProperty.call(V1_OPERATOR, key)) {
        throw new FilterError(
          `Unknown filter "${key}" on "${column}". Use $gt, $gte, $lt, $lte, $ne, $in, $contains or $ilike.`,
          column,
        )
      }
      v1[V1_OPERATOR[key]] = operand
    }
    if (Object.keys(v1).length > 0) conditions.push(...whereConditions({ [column]: v1 }, bound, types))
    else if (!('$ilike' in (value as Record<string, unknown>))) {
      throw new FilterError(`The filter on "${column}" names no condition.`, column)
    }
  }
  return conditions
}

export interface DbQueryInput {
  table: string
  /** A preview branch of this project instead of main. */
  branchId?: string | null
  filter?: Record<string, unknown>
  limit?: number
  offset?: number
  orderBy?: Record<string, 'asc' | 'desc' | 'ASC' | 'DESC'>
}

export async function dbQuery(projectId: string, input: DbQueryInput) {
  const table = String(input.table || '').toLowerCase()
  const target = await resolveTarget(projectId, input.branchId)
  await assertTable(projectId, table, target)
  const schema = target.schema
  const limit = Math.min(Math.max(1, Number(input.limit ?? 50)), 200)
  const offset = Math.max(0, Number(input.offset ?? 0))

  const types = await columnTypes(projectId, schema, table)
  const bound = typedParams(types)
  const conditions = mcpWhere(input.filter, bound, types)
  let orderBy = ''
  if (input.orderBy && typeof input.orderBy === 'object') {
    const parts = Object.entries(input.orderBy)
      .filter(([c]) => IDENT.test(c))
      .map(([c, dir]) => `"${c}" ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
    if (parts.length) orderBy = ` ORDER BY ${parts.join(', ')}`
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const sql =
    `SELECT * FROM "${schema}"."${table}"${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`
  const rows = await runAsServiceRole(projectId, sql, bound.values, bound.context(table))
  // Secret columns never land in an agent transcript. run_query redacts for
  // exactly this reason; db_query returned the end-user `users` table —
  // bcrypt hashes included — verbatim. Values are replaced, not dropped, so
  // the shape still says the column exists.
  const list = Array.isArray(rows) ? rows : []
  const { rows: safeRows, redactedColumns } = redactRows(list as Record<string, unknown>[])
  return {
    rows: safeRows,
    count: list.length,
    ...(redactedColumns.length > 0 ? { redactedColumns } : {}),
  }
}

export interface DbInsertInput {
  table: string
  /** A preview branch of this project instead of main. */
  branchId?: string | null
  row: Record<string, unknown>
}

export async function dbInsert(projectId: string, input: DbInsertInput) {
  const table = String(input.table || '').toLowerCase()
  const target = await resolveTarget(projectId, input.branchId)
  await assertTable(projectId, table, target)
  const schema = target.schema
  const row = input.row ?? {}
  const cols = Object.keys(row).filter((c) => IDENT.test(c))
  if (cols.length === 0) throw new Error('`row` must include at least one valid column.')

  const types = await columnTypes(projectId, schema, table)
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const placeholders = cols.map((c, i) => `$${i + 1}${castSuffix(types.get(c))}`).join(', ')
  const values = cols.map((c) => coerceValue(types.get(c), (row as any)[c]))
  const sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${placeholders}) RETURNING *`
  const result = await runAsServiceRole(projectId, sql, values, { table, columns: cols, values, types })
  const returned = Array.isArray(result) && result[0] ? [result[0] as Record<string, unknown>] : []
  const { rows: safeRows, redactedColumns } = redactRows(returned)
  return { row: safeRows[0] ?? null, ...(redactedColumns.length > 0 ? { redactedColumns } : {}) }
}

export interface DbUpdateInput {
  table: string
  /** A preview branch of this project instead of main. */
  branchId?: string | null
  filter: Record<string, unknown>
  patch: Record<string, unknown>
}

export async function dbUpdate(projectId: string, input: DbUpdateInput) {
  const table = String(input.table || '').toLowerCase()
  const target = await resolveTarget(projectId, input.branchId)
  await assertTable(projectId, table, target)
  const schema = target.schema

  const patch = input.patch ?? {}
  const setCols = Object.keys(patch).filter((c) => IDENT.test(c))
  if (setCols.length === 0) throw new Error('`patch` must include at least one valid column.')

  // Refuse empty filters — that would be a table-wide UPDATE. Forcing a
  // filter is the same guardrail the dashboard uses; the MCP host LLM should
  // not be able to accidentally clobber every row in a table.
  if (!input.filter || Object.keys(input.filter).length === 0) {
    throw new Error('`filter` is required and must be non-empty (refusing table-wide UPDATE).')
  }

  const types = await columnTypes(projectId, schema, table)
  // The filter's values follow the patch's in the same sequence.
  const bound = typedParams(types)
  const setSqlParts = setCols.map((c) => `"${c}" = ${bound.bind(c, (patch as any)[c])}`)

  const conditions = mcpWhere(input.filter, bound, types)
  if (conditions.length === 0) throw new Error('`filter` is required (refusing table-wide UPDATE).')

  const sql = `UPDATE "${schema}"."${table}" SET ${setSqlParts.join(', ')} WHERE ${conditions.join(' AND ')} RETURNING *`
  const result = await runAsServiceRole(projectId, sql, bound.values, bound.context(table))
  const rows = Array.isArray(result) ? result : []
  const { rows: safeRows, redactedColumns } = redactRows(rows as Record<string, unknown>[])
  return { updated: rows.length, rows: safeRows, ...(redactedColumns.length > 0 ? { redactedColumns } : {}) }
}

export interface DbDeleteInput {
  table: string
  /** A preview branch of this project instead of main. */
  branchId?: string | null
  filter: Record<string, unknown>
}

export async function dbDelete(projectId: string, input: DbDeleteInput) {
  const table = String(input.table || '').toLowerCase()
  const target = await resolveTarget(projectId, input.branchId)
  await assertTable(projectId, table, target)
  const schema = target.schema

  // Same guardrail as update: no filter, no go.
  if (!input.filter || Object.keys(input.filter).length === 0) {
    throw new Error('`filter` is required and must be non-empty (refusing table-wide DELETE).')
  }

  const types = await columnTypes(projectId, schema, table)
  const bound = typedParams(types)
  const conditions = mcpWhere(input.filter, bound, types)
  if (conditions.length === 0) throw new Error('`filter` is required (refusing table-wide DELETE).')

  const sql = `DELETE FROM "${schema}"."${table}" WHERE ${conditions.join(' AND ')} RETURNING id`
  const result = await runAsServiceRole(projectId, sql, bound.values, bound.context(table))
  const rows = Array.isArray(result) ? result : []
  return { deleted: rows.length }
}
