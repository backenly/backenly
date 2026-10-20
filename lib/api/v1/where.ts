/**
 * The `where` of a v1 data request (/database/query, /update and /delete,
 * which the SDK's list, get, count, update and delete call), as conditions on
 * the table. Both servers that answer those paths build them here: the Next
 * routes (app/api/v1/[projectId]/database/*) and the runtime
 * (server/routes/database.ts).
 *
 * The vocabulary is what the SDK writes (packages/sdk/src/database.ts):
 *
 *   { col: value }                   "col" = value                 eq()
 *   { col: null }                    "col" IS NULL                 isNull()
 *   { col: { not: null } }           "col" IS NOT NULL             isNotNull()
 *   { col: { not: value } }          "col" != value                neq()
 *   { col: { gt | gte | lt | lte } } "col" > value, and so on      gt(), gte(), lt(), lte()
 *   { col: { contains: text } }      "col"::text ILIKE '%text%'    like(), ilike()
 *   { col: { in: [ … ] } }           "col" IN (…), none for []     in()
 *
 * They had drifted apart. The Next query route compared a null with `=`, so
 * isNull() and isNotNull() matched no row, and its update and delete knew only
 * equality. The runtime knew every operator but bound each value uncast,
 * which PostgreSQL refuses for a uuid, timestamp, numeric or boolean column.
 * Here every value is bound through `bound`, cast to its column's type
 * (lib/api/v1/typed-params.ts).
 *
 * A filter that cannot be applied is refused (FilterError), not skipped:
 * skipping one widened a list, and widened an update past the rows the caller
 * named.
 */

import type { TypedParams } from './typed-params'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

const COMPARISONS = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

/** Every key an operator object may hold; `mode` rides along with `contains`. */
const OPERATORS = new Set<string>([...Object.keys(COMPARISONS), 'not', 'contains', 'in', 'mode'])

/** A `where` naming something no condition can be built from. Answered 400. */
export class FilterError extends Error {
  constructor(message: string, readonly column?: string) {
    super(message)
    this.name = 'FilterError'
  }
}

/**
 * Whether `value` is an operator object rather than a value to compare with.
 * A json or jsonb column compares with an object, so there only an object
 * naming an operator is one.
 */
function isOperators(value: unknown, type: string | undefined): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) return false
  if (type === 'json' || type === 'jsonb') return Object.keys(value).some((key) => OPERATORS.has(key))
  return true
}

/**
 * The conditions `where` sets, each a SQL fragment whose values are bound
 * through `bound`. Joined with AND by the caller, which may add its own.
 *
 * @param types column name → data_type, the map `bound` was built from.
 */
export function whereConditions(
  where: Record<string, unknown> | undefined,
  bound: TypedParams,
  types: Map<string, string>,
): string[] {
  const conditions: string[] = []
  if (!where) return conditions

  for (const [column, value] of Object.entries(where)) {
    if (!IDENTIFIER.test(column)) throw new FilterError(`"${column}" is not a column name.`, column)
    const name = `"${column}"`

    if (value === null) {
      conditions.push(`${name} IS NULL`)
      continue
    }
    if (!isOperators(value, types.get(column))) {
      conditions.push(`${name} = ${bound.bind(column, value)}`)
      continue
    }

    const unknown = Object.keys(value).filter((key) => !OPERATORS.has(key))
    if (unknown.length > 0) {
      throw new FilterError(
        `Unknown filter ${unknown.map((key) => `"${key}"`).join(', ')} on "${column}". ` +
          'Use gt, gte, lt, lte, not, contains or in.',
        column,
      )
    }

    const before = conditions.length
    for (const [key, operator] of Object.entries(COMPARISONS)) {
      if (value[key] !== undefined) conditions.push(`${name} ${operator} ${bound.bind(column, value[key])}`)
    }
    if (value.not === null) conditions.push(`${name} IS NOT NULL`)
    else if (value.not !== undefined) conditions.push(`${name} != ${bound.bind(column, value.not)}`)
    if (value.contains !== undefined) conditions.push(`${name}::text ILIKE ${bound.raw(`%${value.contains}%`)}`)
    if (value.in !== undefined) {
      if (!Array.isArray(value.in)) throw new FilterError(`"in" on "${column}" takes a list of values.`, column)
      conditions.push(
        value.in.length === 0 ? 'FALSE' : `${name} IN (${value.in.map((item) => bound.bind(column, item)).join(', ')})`,
      )
    }
    if (conditions.length === before) throw new FilterError(`The filter on "${column}" names no condition.`, column)
  }

  return conditions
}
