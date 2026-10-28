/**
 * Placeholders for the v1 database routes (/database/insert, /update, /delete
 * and /query, which the SDK's create, update, delete and list call), cast to
 * the live column types.
 *
 * Prisma's $queryRawUnsafe binds a JS string as text, and PostgreSQL will not
 * assign text to a uuid, timestamp, numeric or boolean column (SQLSTATE 42804)
 * or compare one with it (42883). These routes built bare placeholders, so the
 * SDK could not write a uuid `owner_id`, update or delete by a uuid `id`, or
 * filter an integer column from a query string. Each value is now bound as
 * text with a `::type` cast to its column, so PostgreSQL's own input parser
 * reads it: the contract lib/mcp/runtime-db.ts applies to MCP writes and AI
 * functions, through the same cast table.
 */

import type { QueryContext } from '@/lib/db/query-errors'
import { castTarget, coerceValue } from '@/lib/mcp/runtime-db'

export interface TypedParams {
  /** The bound values, in placeholder order, for executeWithUserContext. */
  readonly values: unknown[]
  /** The column each value was bound for, in the same order ('' for a raw one). */
  readonly columns: string[]
  /** The placeholder for `value` written to or compared with `column`. */
  bind(column: string, value: unknown): string
  /** The placeholder for `value` bound as it is, with no cast (an ILIKE pattern). */
  raw(value: unknown): string
  /**
   * What was bound, for explaining a refusal (lib/api/v1/data-errors.ts):
   * PostgreSQL names the type and value it could not read, not the column.
   */
  context(table: string): QueryContext
}

/**
 * @param types column name → information_schema data_type, from columnTypes()
 *              on the project's own database. A column it does not name is
 *              bound as before, uncast.
 */
export function typedParams(types: Map<string, string>): TypedParams {
  const values: unknown[] = []
  const columns: string[] = []
  return {
    values,
    columns,
    bind(column, value) {
      const type = types.get(column)
      values.push(coerceValue(type, value))
      columns.push(column)
      const target = castTarget(type)
      return target ? `$${values.length}::${target}` : `$${values.length}`
    },
    raw(value) {
      values.push(value)
      columns.push('')
      return `$${values.length}`
    },
    context(table) {
      return { table, columns, values, types }
    },
  }
}
