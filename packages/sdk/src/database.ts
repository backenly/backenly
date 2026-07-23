import type { BackenlyClient } from './client'
import type { QueryResponse, InsertResponse, UpdateResponse, DeleteResponse, OrderByOptions, QueryFilter, CountResponse } from './types'
import { normalizeError } from './errors'
import type { RealtimeCallback, Unsubscribe } from './realtime'

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
      return response.data ?? response
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
      return response.data ?? response
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** Deletes a record by id */
  async delete(id: string): Promise<{ success: boolean }> {
    try {
      const projectId = this.client.getProjectId()
      const response = await this.client.request(`/api/v1/${projectId}/database/delete`, {
        method: 'POST',
        body: JSON.stringify({ table: this.tableName, where: { id } }),
      })
      return response
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

function unwrapRows<T>(response: any): T[] {
  if (Array.isArray(response)) return response
  if (Array.isArray(response?.data)) return response.data
  if (Array.isArray(response?.data?.data)) return response.data.data
  return []
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
  private buildWhereClause(): any {
    if (this.filters.length === 0) return undefined

    const where: any = {}
    for (const filter of this.filters) {
      if (filter.operator === 'eq') {
        where[filter.column] = filter.value
      } else if (filter.operator === 'in') {
        where[filter.column] = { in: filter.value }
      } else if (filter.operator === 'gt') {
        where[filter.column] = { gt: filter.value }
      } else if (filter.operator === 'gte') {
        where[filter.column] = { gte: filter.value }
      } else if (filter.operator === 'lt') {
        where[filter.column] = { lt: filter.value }
      } else if (filter.operator === 'lte') {
        where[filter.column] = { lte: filter.value }
      } else if (filter.operator === 'neq') {
        where[filter.column] = { not: filter.value }
      } else if (filter.operator === 'like') {
        where[filter.column] = { contains: filter.value }
      } else if (filter.operator === 'ilike') {
        where[filter.column] = { contains: filter.value, mode: 'insensitive' }
      } else if (filter.operator === 'isNull') {
        where[filter.column] = null
      } else if (filter.operator === 'isNotNull') {
        where[filter.column] = { not: null }
      }
    }
    return where
  }

  private buildOrderByClause(): any {
    if (!this.orderByColumn) return undefined
    return { [this.orderByColumn]: this.orderDirection }
  }

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
        return response
      }

      if (this.operation === 'insert') {
        const response = await this.client.request(`/api/v1/${projectId}/database/insert`, {
          method: 'POST',
          body: JSON.stringify({
            table: this.tableName,
            data: this.insertData,
          }),
        })
        return response
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
        return response
      }

      if (this.operation === 'delete') {
        const response = await this.client.request(`/api/v1/${projectId}/database/delete`, {
          method: 'POST',
          body: JSON.stringify({
            table: this.tableName,
            where: this.buildWhereClause(),
          }),
        })
        return response
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
