/**
 * How the Database page reads a table's values and columns: which columns are
 * Backenly's to manage, which can be filtered, how a cell is shown and how a
 * typed value goes back to its column's type. Plain functions, shared by the
 * grid, the row drawer, the filter and Structure, so each says it one way.
 */

import type { ColumnInfo } from '@/lib/api/database'

export type Column = ColumnInfo
export type Row = Record<string, unknown>

/** Rows read per page: the footer, the step back after a delete and the query agree on it. */
export const PAGE_SIZE = 50

/**
 * Columns Backenly manages. They cannot be renamed or dropped and the row form
 * leaves them alone; the executor refuses the same set server-side.
 */
const RESERVED = new Set(['id', 'createdat', 'updatedat', 'deleted_at', 'deletedat'])
export const isReservedColumn = (name: string) => RESERVED.has(name.toLowerCase())

/**
 * Query parameters the rows route reads for itself (app/api/database/rows,
 * `knownParams`): a column with one of these names cannot be filtered through
 * it, so the filter does not offer it rather than offering a filter that is
 * silently ignored.
 */
const ROUTE_PARAMS = new Set(['type', 'schema', 'table', 'projectid', 'view', 'page', 'limit', 'sortby', 'sortorder', 'search'])
export const isFilterable = (name: string) => !ROUTE_PARAMS.has(name.toLowerCase())

const t = (type: string) => type.toLowerCase()
export const isNumericType = (type: string) => /int|numeric|decimal|float|double|real|serial/.test(t(type))
export const isBoolType = (type: string) => t(type).includes('bool')
export const isDateType = (type: string) => /date|timestamp/.test(t(type)) && !/interval/.test(t(type))
export const isJsonType = (type: string) => t(type).includes('json')
export const isUuidType = (type: string) => t(type) === 'uuid'

/** The primary key's column: what a row is opened and changed by. */
export function keyColumn(columns: readonly Column[]): string {
  return columns.find((c) => c.primary)?.name ?? 'id'
}

/** A row's key as text, for the URL (?row=) and the drawer's moves. */
export function rowKey(row: Row, key: string): string {
  const v = row[key] ?? row.id
  return v === null || v === undefined ? '' : String(v)
}

/**
 * The grid's column order: the key, the table's own columns, then the managed
 * timestamps, so createdAt, updatedAt and an all-NULL deleted_at do not fill
 * the first screen. Structure keeps the table's real order.
 */
export function gridOrder(columns: readonly Column[]): Column[] {
  return [
    ...columns.filter((c) => c.primary),
    ...columns.filter((c) => !c.primary && !isReservedColumn(c.name)),
    ...columns.filter((c) => !c.primary && isReservedColumn(c.name)),
  ]
}

/** The value the route sent for a withheld column (lib/mcp/read-query.ts). */
export const REDACTED = '[redacted]'

/** A cell as text: raw, as the data is (decision 13: grid cells stay raw). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A value as the form edits it: the empty string is NULL. */
export function formText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

/**
 * A form value back to its column's type. `undefined` means "leave this field
 * out" (a number that does not parse, an empty value on a column that cannot
 * be NULL, which the database then fills or refuses in its own words).
 */
export function toColumnValue(col: Column, raw: string): unknown {
  if (raw === '') return col.nullable ? null : undefined
  const type = col.type
  if (isBoolType(type)) return raw === 'true' ? true : raw === 'false' ? false : undefined
  if (/int|serial/.test(t(type))) {
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? undefined : n
  }
  if (isNumericType(type)) {
    const n = Number.parseFloat(raw)
    return Number.isNaN(n) ? undefined : n
  }
  if (isJsonType(type)) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (isDateType(type)) {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  return raw
}

/** Columns the database fills itself when a row is inserted: serials and the managed timestamps. */
export function fillsItself(col: Column): boolean {
  const name = col.name.toLowerCase()
  if (t(col.type).includes('serial')) return true
  const stamped = name === 'createdat' || name === 'updatedat' || name === 'created_at' || name === 'updated_at'
  return stamped && /now\(\)|current_timestamp/i.test(col.default ?? '')
}

/** "1 row", "1,284 rows". */
export const rowsWord = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`
export const tablesWord = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'table' : 'tables'}`

/** How a sort reads in its chip: "newest first" for dates, "highest first" for numbers. */
export function sortWords(col: Column | undefined, dir: 'asc' | 'desc'): string {
  if (col && isDateType(col.type)) return dir === 'desc' ? 'newest first' : 'oldest first'
  if (col && isNumericType(col.type)) return dir === 'desc' ? 'highest first' : 'lowest first'
  return dir === 'desc' ? 'Z to A' : 'A to Z'
}

/** The Mac says ⌘, everything else Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return /mac|iphone|ipad/i.test(p)
}
