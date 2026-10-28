import type { BackenlyClient } from './client.js'
import type { QueryResponse, InsertResponse, UpdateResponse, DeleteResponse, OrderByOptions, QueryFilter, CountResponse } from './types.js'
import { BackenlyError, normalizeError } from './errors.js'
import type { RealtimeCallback, Unsubscribe } from './realtime.js'

/**
 * Relations to attach to returned rows. Accepts a single name, a list, or the
 * nested object form: { comments: { include: { author: true } } }
 */
export type IncludeInput = string | string[] | Record<string, any>

function normalizeInclude(include: IncludeInput | undefined): Record<string, any> | undefined {
  if (!include) return undefined
  if (typeof include === 'string') return { [include]: true }
  if (Array.isArray(include)) {
    const spec: Record<string, any> = {}
    for (const name of include) if (typeof name === 'string' && name) spec[name] = true
    return Object.keys(spec).length > 0 ? spec : undefined
  }
  return Object.keys(include).length > 0 ? include : undefined
}

/**
 * TableClient — the simple, agent-friendly API
 *
 * Usage:
 *   backend.posts.list()
 *   backend.posts.create({ title: 'Hello' })
 *   backend.posts.get('some-id')
 *   backend.posts.update('some-id', { title: 'Updated' })
 *   backend.posts.delete('some-id')
 */
export class TableClient<T = any> {
  constructor(
    private client: BackenlyClient,
    private tableName: string,
  ) {}

  /**
   * Returns all records. Optionally filter: { where: { status: 'active' }, limit: 20 }.
   * Fetch related rows in the same request with include:
   *   backend.posts.list({ include: ['comments', 'author'] })
   * Relations follow the table's foreign keys — has-many relations attach as
   * arrays, belongs-to relations (e.g. author_id) attach as a single object.
   */
  async list(options?: { where?: Record<string, any>; limit?: number; offset?: number; orderBy?: string; order?: 'asc' | 'desc'; include?: IncludeInput }): Promise<T[]> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
        method: 'POST',
        body: JSON.stringify({
          table: this.tableName,
          where: options?.where,
          orderBy: options?.orderBy ? { [options.orderBy]: options.order || 'asc' } : undefined,
          limit: options?.limit,
          offset: options?.offset,
          include: normalizeInclude(options?.include),
        }),
      })
      return unwrapRows<T>(response)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Creates a new record and returns it */
  async create(data: Partial<T>): Promise<T> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/insert`, {
        method: 'POST',
        body: JSON.stringify({ table: this.tableName, data }),
      })
      return rowsIn(resultOf(response))
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Returns a single record by id. Pass { include } to attach related rows. */
  async get(id: string, options?: { include?: IncludeInput }): Promise<T | null> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
        method: 'POST',
        body: JSON.stringify({
          table: this.tableName,
          where: { id },
          limit: 1,
          include: normalizeInclude(options?.include),
        }),
      })
      const rows: T[] = unwrapRows<T>(response)
      return rows.length > 0 ? rows[0] : null
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Updates a record by id and returns the updated record */
  async update(id: string, data: Partial<T>): Promise<T> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/update`, {
        method: 'POST',
        body: JSON.stringify({ table: this.tableName, data, where: { id } }),
      })
      return rowsIn(resultOf(response))
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Deletes a record by id. Resolves `{ success: true, deleted }`, the number of rows deleted. */
  async delete(id: string): Promise<{ success: boolean }> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/delete`, {
        method: 'POST',
        body: JSON.stringify({ table: this.tableName, where: { id } }),
      })
      return resultOf(response)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Count records, optionally filtered */
  async count(where?: Record<string, any>): Promise<number> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
        method: 'POST',
        body: JSON.stringify({
          table: this.tableName,
          where,
          limit: 1,
        }),
      })
      // Query responses include the total count for the filtered result set.
      if (typeof response.count === 'number') return response.count
      if (typeof response.data?.count === 'number') return response.data.count
      const rows = response.data ?? response
      if (Array.isArray(rows) && rows[0]?.count !== undefined) return Number(rows[0].count)
      return 0
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Advanced: returns a QueryBuilder for complex queries */
  query(): QueryBuilder<T> {
    return new QueryBuilder<T>(this.client, this.tableName)
  }

  /**
   * Subscribe to live changes on this table.
   *
   * Returns an unsubscribe function — call it to stop receiving events.
   *
   * @example
   * const unsub = backend.messages.subscribe((event) => {
   *   if (event.type === 'insert') addMessage(event.data)
   * })
   * // React useEffect cleanup:
   * return () => unsub()
   */
  subscribe(callback: RealtimeCallback<T>): Unsubscribe {
    return this.client.realtime.subscribe<T>(this.tableName, callback)
  }
}

// ── Reading a data route's answer ────────────────────────────────────────────
//
// Each data route answers `{ data: <result> }`, and each result is an object
// that carries its rows under a `data` of its own:
//
//   POST /database/query   { data: { data: rows, count }, meta }
//   POST /database/insert  { data: { data: row | rows } }
//   POST /database/update  { data: { data: row | rows, updated } }
//   POST /database/delete  { data: { success, deleted } }
//
// The Next routes (app/api/v1/[projectId]/database/*) and the runtime's twin
// (server/routes/database.ts) answer alike, and
// tests/integration/sdk-data-routes.spec.ts pins it. list() and get() always
// read the rows from inside the result, and count() its count. create() and
// update() returned the result itself, so `(await create(...)).id` was
// undefined, and delete() and the query builder returned the whole answer.
// They read through these two now.

/** The result inside a route's `{ data: <result> }` answer. */
function resultOf(response: any): any {
  return isRecord(response) && 'data' in response ? response.data : response
}

/** The row, or rows, a result carries under its own `data`. */
function rowsIn(result: any): any {
  return isRecord(result) && 'data' in result ? result.data : result
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unwrapRows<T>(response: any): T[] {
  const rows = rowsIn(resultOf(response))
  return Array.isArray(rows) ? rows : []
}

export class QueryBuilder<T = any> {
  private tableName: string
  private selectColumns: string[] | undefined = undefined
  private filters: QueryFilter[] = []
  private includeSpec?: Record<string, any>
  private limitCount?: number
  private offsetCount: number = 0
  private orderByColumn?: string
  private orderDirection: 'asc' | 'desc' = 'asc'
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private insertData?: any
  private updateData?: any

  constructor(private client: BackenlyClient, table: string) {
    this.tableName = table
  }

  // SELECT
  select(columns: string = '*'): this {
    this.selectColumns = columns === '*'
      ? undefined
      : columns
          .split(',')
          .map((column) => column.trim())
          .filter(Boolean)
    this.operation = 'select'
    return this
  }

  // INSERT
  insert(data: T | T[]): this {
    this.operation = 'insert'
    this.insertData = data
    return this
  }

  // UPDATE
  update(data: Partial<T>): this {
    this.operation = 'update'
    this.updateData = data
    return this
  }

  // DELETE
  delete(): this {
    this.operation = 'delete'
    return this
  }

  // FILTERS
  eq(column: string, value: any): this {
    this.filters.push({ column, operator: 'eq', value })
    return this
  }

  neq(column: string, value: any): this {
    this.filters.push({ column, operator: 'neq', value })
    return this
  }

  gt(column: string, value: any): this {
    this.filters.push({ column, operator: 'gt', value })
    return this
  }

  gte(column: string, value: any): this {
    this.filters.push({ column, operator: 'gte', value })
    return this
  }

  lt(column: string, value: any): this {
    this.filters.push({ column, operator: 'lt', value })
    return this
  }

  lte(column: string, value: any): this {
    this.filters.push({ column, operator: 'lte', value })
    return this
  }

  like(column: string, pattern: string): this {
    this.filters.push({ column, operator: 'like', value: pattern })
    return this
  }

  in(column: string, values: any[]): this {
    this.filters.push({ column, operator: 'in', value: values })
    return this
  }

  isNull(column: string): this {
    this.filters.push({ column, operator: 'isNull', value: null })
    return this
  }

  isNotNull(column: string): this {
    this.filters.push({ column, operator: 'isNotNull', value: null })
    return this
  }

  ilike(column: string, pattern: string): this {
    this.filters.push({ column, operator: 'ilike', value: pattern })
    return this
  }

  search(column: string, term: string): this {
    this.filters.push({ column, operator: 'ilike', value: `%${term}%` })
    return this
  }

  /**
   * Attach related rows to each result, following the table's foreign keys:
   *   backend.posts.query().include('comments', 'author')
   */
  include(...relations: (string | Record<string, any>)[]): this {
    for (const rel of relations) {
      const spec = normalizeInclude(rel as IncludeInput)
      if (spec) this.includeSpec = { ...(this.includeSpec ?? {}), ...spec }
    }
    return this
  }

  // MODIFIERS
  limit(count: number): this {
    this.limitCount = count
    return this
  }

  offset(count: number): this {
    this.offsetCount = count
    return this
  }

  order(column: string, options: OrderByOptions = {}): this {
    this.orderByColumn = column
    this.orderDirection = options.ascending === false ? 'desc' : 'asc'
    return this
  }

  // EXECUTION
  /**
   * The `where` the servers read: one entry per column, holding every filter
   * on it. `.gte('age', 18).lt('age', 65)` sends `{ age: { gte: 18, lt: 65 } }`.
   * Each filter used to replace the one before it on the same column, so that
   * range sent only `{ lt: 65 }`, and a ranged update() or delete() reached
   * every row below 65. Two filters that cannot be sent together on one
   * column (eq() or isNull() with any other, or one operator twice) throw
   * before anything is sent, and so does a value JSON cannot carry: an
   * undefined value left its filter out of the request altogether, and NaN
   * or Infinity arrived as null.
   */
  private buildWhereClause(): any {
    if (this.filters.length === 0) return undefined

    const where = new Map<string, unknown>()
    const comparedWhole = new Set<string>()
    const refuse = (message: string) => new BackenlyError(message, 'VALIDATION_ERROR')
    /** The methods that write each operator, as the caller wrote them. */
    const METHODS: Record<string, string> = {
      in: 'in()', gt: 'gt()', gte: 'gte()', lt: 'lt()', lte: 'lte()', not: 'neq() or isNotNull()', contains: 'like() or ilike()',
    }
    const conflict = (column: string, what: string, hint: string) =>
      refuse(`Two filters on "${column}" cannot be sent together: ${what}. ${hint}`)
    // A value JSON sends as it is. JSON leaves out undefined, a function or a
    // symbol, and turns NaN, Infinity and an invalid Date into null; inside an
    // array each of those becomes null. A bigint cannot be sent at all.
    const carried = (v: unknown): boolean => {
      let json: string | undefined
      try {
        json = JSON.stringify(v)
      } catch {
        return false
      }
      if (json === undefined || (json === 'null' && v !== null)) return false
      return !Array.isArray(v) || v.every(carried)
    }
    const describe = (v: unknown): string => {
      try {
        return typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.prototype.toString.call(v) : String(v)
      } catch {
        return typeof v
      }
    }
    const sendable = (column: string, value: unknown): void => {
      if (!carried(value)) throw refuse(`The filter on "${column}" has a value JSON cannot send as it is (${describe(value)}).`)
    }
    // A value compared whole: eq(), isNull().
    const compare = (column: string, value: unknown) => {
      sendable(column, value)
      if (where.has(column)) throw conflict(column, 'eq() or isNull() with another filter', 'For several values, use in().')
      comparedWhole.add(column)
      where.set(column, value)
    }
    // One operator among the column's others.
    const operator = (column: string, key: string, operand: unknown, extra: Record<string, unknown> = {}) => {
      sendable(column, operand)
      if (comparedWhole.has(column)) throw conflict(column, 'eq() or isNull() with another filter', 'For several values, use in().')
      const operators = (where.get(column) as Record<string, unknown> | undefined) ?? {}
      if (Object.prototype.hasOwnProperty.call(operators, key)) throw conflict(column, `${METHODS[key] ?? key} twice`, 'Keep one of them.')
      where.set(column, { ...operators, [key]: operand, ...extra })
    }

    for (const filter of this.filters) {
      const { column, value } = filter
      if (filter.operator === 'eq') compare(column, value)
      else if (filter.operator === 'isNull') compare(column, null)
      else if (filter.operator === 'in') operator(column, 'in', value)
      else if (filter.operator === 'gt') operator(column, 'gt', value)
      else if (filter.operator === 'gte') operator(column, 'gte', value)
      else if (filter.operator === 'lt') operator(column, 'lt', value)
      else if (filter.operator === 'lte') operator(column, 'lte', value)
      else if (filter.operator === 'neq') operator(column, 'not', value)
      else if (filter.operator === 'isNotNull') operator(column, 'not', null)
      else if (filter.operator === 'like') operator(column, 'contains', value)
      else if (filter.operator === 'ilike') operator(column, 'contains', value, { mode: 'insensitive' })
    }
    return Object.fromEntries(where)
  }

  private buildOrderByClause(): any {
    if (!this.orderByColumn) return undefined
    return { [this.orderByColumn]: this.orderDirection }
  }

  /**
   * Resolves the route's result, not its whole answer: `{ data: rows, count }`
   * for a select, `{ data: row | rows }` for an insert, `{ data, updated }` for
   * an update and `{ success, deleted }` for a delete.
   */
  async execute(): Promise<QueryResponse<T> | InsertResponse<T> | UpdateResponse<T> | DeleteResponse> {
    try {
      const projectId = this.client.getProjectId()

      if (this.operation === 'select') {
        const response = await this.client.request(`/api/v1/${projectId}/database/query`, {
          method: 'POST',
          body: JSON.stringify({
            table: this.tableName,
            select: this.selectColumns,
            where: this.buildWhereClause(),
            orderBy: this.buildOrderByClause(),
            limit: this.limitCount,
            offset: this.offsetCount,
            include: this.includeSpec,
          }),
        })
        return resultOf(response)
      }

      if (this.operation === 'insert') {
        const response = await this.client.request(`/api/v1/${projectId}/database/insert`, {
          method: 'POST',
          body: JSON.stringify({
            table: this.tableName,
            data: this.insertData,
          }),
        })
        return resultOf(response)
      }

      if (this.operation === 'update') {
        const response = await this.client.request(`/api/v1/${projectId}/database/update`, {
          method: 'POST',
          body: JSON.stringify({
            table: this.tableName,
            data: this.updateData,
            where: this.buildWhereClause(),
          }),
        })
        return resultOf(response)
      }

      if (this.operation === 'delete') {
        const response = await this.client.request(`/api/v1/${projectId}/database/delete`, {
          method: 'POST',
          body: JSON.stringify({
            table: this.tableName,
            where: this.buildWhereClause(),
          }),
        })
        return resultOf(response)
      }

      throw new Error('Invalid operation')
    } catch (error) {
      throw normalizeError(error)
    }
  }

  // Make the query builder thenable so it auto-executes on await
  then<TResult1 = QueryResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled as any, onrejected)
  }
}
