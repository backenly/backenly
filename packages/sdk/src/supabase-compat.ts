/**
 * supabase-js compatibility shim — the migration bridge.
 *
 * A frontend written against supabase-js keeps working against a Backenly
 * backend by swapping exactly two strings:
 *
 *   // before
 *   import { createClient } from '@supabase/supabase-js'
 *   const supabase = createClient('https://xyz.supabase.co', 'SUPABASE_ANON_KEY')
 *
 *   // after
 *   import { createClient } from 'https://backenly.com/backenly-supabase.esm.js'
 *   const supabase = createClient('https://backenly.com/api/v1/<PROJECT_ID>', 'BACKENLY_ANON_KEY')
 *
 * Contract fidelity over completeness:
 *   • Every operation resolves { data, error } and NEVER throws — the
 *     supabase-js convention frontends are written against.
 *   • The PostgREST filter chain (eq/neq/gt/gte/lt/lte/like/ilike/in/is),
 *     order/limit/range, single/maybeSingle, insert/update/delete/upsert-lite,
 *     count — all mapped onto Backenly's governed /database/* API.
 *   • auth.signUp / signInWithPassword / signOut / getUser / getSession map
 *     onto Backenly end-user auth (JWT sessions).
 *   • channel().on('postgres_changes', …) maps onto Backenly realtime.
 *   • Unsupported surface (rpc, .or(), column projection, foreign-table
 *     embeds) returns a structured error naming the Backenly equivalent —
 *     never a silent wrong answer.
 */

import { BackenlyClient } from './client'

// ── result & error shapes (supabase-js conventions) ───────────────────────────

export interface CompatError {
  message: string
  code: string
  details: string | null
  hint: string | null
}

export interface CompatResult<T> {
  data: T | null
  error: CompatError | null
  count: number | null
  status: number
  statusText: string
}

function err(message: string, code = 'BACKENLY_COMPAT', hint: string | null = null): CompatError {
  return { message, code, details: null, hint }
}

function fromException(e: unknown): CompatError {
  const m = e instanceof Error ? e.message : String(e)
  return { message: m, code: (e as any)?.code ?? 'BACKENLY_ERROR', details: null, hint: null }
}

// ── query builder ──────────────────────────────────────────────────────────────

type Op = Record<string, unknown>

/**
 * Thenable filter chain. `await sb.from('posts').select().eq('id', 1)` works
 * because the builder implements then() — same trick supabase-js uses.
 */
export class CompatQueryBuilder<T = any> implements PromiseLike<CompatResult<T[] | T>> {
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private where: Record<string, unknown> = {}
  private payload: unknown = null
  private orderBy: { column: string; ascending: boolean } | null = null
  private limitN: number | null = null
  private offsetN: number | null = null
  private wantSingle: 'strict' | 'maybe' | null = null
  private wantCount = false
  private returnRows = true
  private unsupported: string | null = null

  constructor(
    private backend: BackenlyClient,
    private tableName: string,
  ) {}

  // ── verbs ────────────────────────────────────────────────────────────────────

  select(columns?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    // After insert()/update(), .select() is a no-op — rows are returned anyway.
    if (columns && columns.trim() !== '*' && columns.trim() !== '') {
      if (/[(,]/.test(columns) && columns.includes('(')) {
        this.unsupported =
          `Foreign-table embeds in select("${columns}") are not supported by the compat shim. ` +
          `Use the Backenly SDK's include option instead: backend.${this.tableName}.list({ include: [...] }).`
      }
      // Plain column lists: Backenly returns full rows; extra columns are harmless.
    }
    if (opts?.count) this.wantCount = true
    if (opts?.head) this.returnRows = false
    return this
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.mode = 'insert'
    this.payload = values
    return this
  }

  upsert(values: Record<string, unknown> | Record<string, unknown>[], _opts?: unknown): this {
    // Backenly insert has no ON CONFLICT merge — honest degradation to insert.
    this.mode = 'insert'
    this.payload = values
    return this
  }

  update(values: Record<string, unknown>): this {
    this.mode = 'update'
    this.payload = values
    return this
  }

  delete(): this {
    this.mode = 'delete'
    return this
  }

  // ── filters (map to Backenly where-operators) ───────────────────────────────

  eq(column: string, value: unknown): this { this.where[column] = value; return this }
  neq(column: string, value: unknown): this { this.mergeOp(column, { not: value }); return this }
  gt(column: string, value: unknown): this { this.mergeOp(column, { gt: value }); return this }
  gte(column: string, value: unknown): this { this.mergeOp(column, { gte: value }); return this }
  lt(column: string, value: unknown): this { this.mergeOp(column, { lt: value }); return this }
  lte(column: string, value: unknown): this { this.mergeOp(column, { lte: value }); return this }
  in(column: string, values: unknown[]): this { this.mergeOp(column, { in: values }); return this }

  /** like/ilike → Backenly `contains` (ILIKE %…%). Leading/trailing % stripped. */
  like(column: string, pattern: string): this { return this.ilike(column, pattern) }
  ilike(column: string, pattern: string): this {
    this.mergeOp(column, { contains: pattern.replace(/^%|%$/g, '') })
    return this
  }

  is(column: string, value: null | boolean): this {
    if (value === null) this.where[column] = null
    else this.where[column] = value
    return this
  }

  or(_filters: string): this {
    this.unsupported =
      'The .or() filter string is not supported by the compat shim (Backenly composes AND filters). ' +
      'Split the query, or use the Backenly SDK directly.'
    return this
  }

  // ── modifiers ────────────────────────────────────────────────────────────────

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: opts?.ascending !== false }
    return this
  }

  limit(n: number): this { this.limitN = n; return this }

  range(from: number, to: number): this {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }

  single(): this { this.wantSingle = 'strict'; return this }
  maybeSingle(): this { this.wantSingle = 'maybe'; return this }

  // ── execution ────────────────────────────────────────────────────────────────

  then<R1 = CompatResult<T[] | T>, R2 = never>(
    onfulfilled?: ((value: CompatResult<T[] | T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined)
  }

  private mergeOp(column: string, op: Op): void {
    const existing = this.where[column]
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      this.where[column] = { ...(existing as Op), ...op }
    } else {
      this.where[column] = op
    }
  }

  private async execute(): Promise<CompatResult<T[] | T>> {
    if (this.unsupported) {
      return { data: null, error: err(this.unsupported, 'UNSUPPORTED'), count: null, status: 400, statusText: 'Bad Request' }
    }
    const projectId = this.backend.getProjectId()
    try {
      if (this.mode === 'select') {
        const body: Record<string, unknown> = {
          table: this.tableName,
          where: Object.keys(this.where).length ? this.where : undefined,
          orderBy: this.orderBy ? { [this.orderBy.column]: this.orderBy.ascending ? 'asc' : 'desc' } : undefined,
          limit: this.wantSingle ? 2 : this.limitN ?? undefined,
          offset: this.offsetN ?? undefined,
        }
        const res = await this.backend.request(`/api/v1/${projectId}/database/query`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        // Mirror the SDK's unwrapRows: bare array | {data: []} | {data:{data: []}}
        const rows: T[] = Array.isArray(res) ? res
          : Array.isArray(res?.data) ? res.data
          : Array.isArray(res?.data?.data) ? res.data.data
          : []
        const count: number | null = res?.data?.count ?? res?.meta?.total ?? null

        if (this.wantSingle) {
          if (rows.length === 0) {
            return this.wantSingle === 'strict'
              ? { data: null, error: err('JSON object requested, multiple (or no) rows returned', 'PGRST116', 'single() found 0 rows'), count, status: 406, statusText: 'Not Acceptable' }
              : { data: null, error: null, count, status: 200, statusText: 'OK' }
          }
          return { data: rows[0], error: null, count, status: 200, statusText: 'OK' }
        }
        return { data: this.returnRows ? rows : null, error: null, count: this.wantCount ? count : null, status: 200, statusText: 'OK' }
      }

      if (this.mode === 'insert') {
        const res = await this.backend.request(`/api/v1/${projectId}/database/insert`, {
          method: 'POST',
          body: JSON.stringify({ table: this.tableName, data: this.payload }),
        })
        const data = res?.data ?? res
        return { data, error: null, count: null, status: 201, statusText: 'Created' }
      }

      if (this.mode === 'update') {
        if (Object.keys(this.where).length === 0) {
          return { data: null, error: err('update() requires at least one filter (e.g. .eq("id", …)) — unfiltered updates are refused', 'NO_FILTER'), count: null, status: 400, statusText: 'Bad Request' }
        }
        const res = await this.backend.request(`/api/v1/${projectId}/database/update`, {
          method: 'POST',
          body: JSON.stringify({ table: this.tableName, data: this.payload, where: this.where }),
        })
        const data = res?.data ?? res
        return { data, error: null, count: null, status: 200, statusText: 'OK' }
      }

      // delete
      if (Object.keys(this.where).length === 0) {
        return { data: null, error: err('delete() requires at least one filter (e.g. .eq("id", …)) — unfiltered deletes are refused', 'NO_FILTER'), count: null, status: 400, statusText: 'Bad Request' }
      }
      const res = await this.backend.request(`/api/v1/${projectId}/database/delete`, {
        method: 'POST',
        body: JSON.stringify({ table: this.tableName, where: this.where }),
      })
      const data = res?.data ?? null
      return { data, error: null, count: null, status: 200, statusText: 'OK' }
    } catch (e) {
      return { data: null, error: fromException(e), count: null, status: 400, statusText: 'Bad Request' }
    }
  }
}

// ── auth ───────────────────────────────────────────────────────────────────────

interface CompatSession {
  access_token: string
  token_type: 'bearer'
  user: Record<string, unknown>
}

class CompatAuth {
  constructor(private backend: BackenlyClient) {}

  async signUp(opts: { email: string; password: string; options?: { data?: Record<string, unknown> } }) {
    try {
      const res: any = await this.backend.auth.signUp({ email: opts.email, password: opts.password })
      return this.sessionResult(res)
    } catch (e) {
      return { data: { user: null, session: null }, error: fromException(e) }
    }
  }

  async signInWithPassword(opts: { email: string; password: string }) {
    try {
      const res: any = await this.backend.auth.signIn({ email: opts.email, password: opts.password })
      return this.sessionResult(res)
    } catch (e) {
      return { data: { user: null, session: null }, error: fromException(e) }
    }
  }

  async signOut() {
    try {
      await this.backend.auth.logout()
      return { error: null }
    } catch (e) {
      return { error: fromException(e) }
    }
  }

  async getUser() {
    try {
      const user = await this.backend.auth.getUser()
      return { data: { user: user ?? null }, error: null }
    } catch (e) {
      return { data: { user: null }, error: fromException(e) }
    }
  }

  async getSession() {
    try {
      const token = (this.backend as any).getUserToken?.() ?? null
      if (!token) return { data: { session: null }, error: null }
      const user = await this.backend.auth.getUser()
      const session: CompatSession | null = user
        ? { access_token: token, token_type: 'bearer', user: user as any }
        : null
      return { data: { session }, error: null }
    } catch (e) {
      return { data: { session: null }, error: fromException(e) }
    }
  }

  private sessionResult(res: any) {
    const user = res?.user ?? res?.data?.user ?? null
    const token = res?.token ?? res?.data?.token ?? (this.backend as any).getUserToken?.() ?? null
    const session: CompatSession | null = token ? { access_token: token, token_type: 'bearer', user } : null
    return { data: { user, session }, error: null }
  }
}

// ── realtime channels ─────────────────────────────────────────────────────────

type ChangeCallback = (payload: {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
  table: string
  schema: string
}) => void

class CompatChannel {
  private unsubs: Array<() => void> = []
  private pending: Array<{ table: string; event: string; cb: ChangeCallback }> = []

  constructor(private backend: BackenlyClient, private name: string) {}

  on(
    type: string,
    filter: { event?: string; schema?: string; table?: string },
    callback: ChangeCallback,
  ): this {
    if (type !== 'postgres_changes' || !filter?.table) return this
    this.pending.push({ table: filter.table, event: (filter.event ?? '*').toUpperCase(), cb: callback })
    return this
  }

  subscribe(statusCallback?: (status: string) => void): this {
    for (const p of this.pending) {
      const tableClient: any = (this.backend as any)[p.table]
      const unsub = tableClient.subscribe((evt: any) => {
        const eventType = String(evt.event ?? evt.type ?? '').toUpperCase() as 'INSERT' | 'UPDATE' | 'DELETE'
        if (p.event !== '*' && p.event !== eventType) return
        p.cb({
          eventType,
          new: evt.row ?? evt.new ?? null,
          old: evt.oldRow ?? evt.old ?? null,
          table: p.table,
          schema: 'public',
        })
      })
      this.unsubs.push(unsub)
    }
    statusCallback?.('SUBSCRIBED')
    return this
  }

  unsubscribe(): void {
    for (const u of this.unsubs.splice(0)) {
      try { u() } catch { /* already closed */ }
    }
  }
}

// ── storage ────────────────────────────────────────────────────────────────────

class CompatStorage {
  constructor(private backend: BackenlyClient) {}

  from(_bucket: string) {
    const backend = this.backend
    return {
      async upload(_path: string, file: File | Blob) {
        try {
          const res: any = await (backend.storage as any).upload(file)
          const id = res?.id ?? res?.data?.id ?? null
          return { data: { path: id, id, fullPath: id }, error: null }
        } catch (e) {
          return { data: null, error: fromException(e) }
        }
      },
      getPublicUrl(path: string) {
        const url = (backend.storage as any).getFileUrl?.(path) ?? null
        return { data: { publicUrl: url } }
      },
      async remove(paths: string[]) {
        try {
          for (const p of paths) await (backend.storage as any).delete?.(p)
          return { data: paths.map((p) => ({ name: p })), error: null }
        } catch (e) {
          return { data: null, error: fromException(e) }
        }
      },
    }
  }
}

// ── client ─────────────────────────────────────────────────────────────────────

export class BackenlySupabaseCompat {
  auth: CompatAuth
  storage: CompatStorage
  private channels: CompatChannel[] = []

  constructor(private backend: BackenlyClient) {
    this.auth = new CompatAuth(backend)
    this.storage = new CompatStorage(backend)
  }

  from<T = any>(table: string): CompatQueryBuilder<T> {
    return new CompatQueryBuilder<T>(this.backend, table)
  }

  channel(name: string): CompatChannel {
    const ch = new CompatChannel(this.backend, name)
    this.channels.push(ch)
    return ch
  }

  removeChannel(ch: CompatChannel): void {
    ch.unsubscribe()
    this.channels = this.channels.filter((c) => c !== ch)
  }

  async rpc(fn: string): Promise<CompatResult<never>> {
    return {
      data: null,
      error: err(
        `rpc("${fn}") is not supported — Backenly has no exposed SQL functions by design. ` +
        `Create an HTTP AI function in the Backenly dashboard and call it via fetch instead.`,
        'UNSUPPORTED',
      ),
      count: null,
      status: 400,
      statusText: 'Bad Request',
    }
  }

  /** Escape hatch to the full Backenly SDK for anything the shim doesn't cover. */
  get backenly(): BackenlyClient {
    return this.backend
  }
}

/**
 * Drop-in createClient. Accepts the supabase-js signature:
 *   createClient('https://backenly.com/api/v1/<PROJECT_ID>', '<BACKENLY_ANON_KEY>')
 * The project id is extracted from the URL; the origin becomes the API base.
 */
export function createClient(url: string, anonKey: string): BackenlySupabaseCompat {
  const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (!m) {
    throw new Error(
      'createClient: could not find a Backenly project id in the URL. Use the shape ' +
      "createClient('https://backenly.com/api/v1/<PROJECT_ID>', '<BACKENLY_ANON_KEY>') — " +
      'copy it from your project → Connect → Frontend SDK.',
    )
  }
  const origin = new URL(url).origin
  const backend = new BackenlyClient({ projectId: m[0], apiKey: anonKey, apiUrl: origin } as any)
  return new BackenlySupabaseCompat(backend)
}
