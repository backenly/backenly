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
 * ── Why this is built on /api/v2 and not /database/* ────────────────────────
 *
 * It used to compose Backenly's own translated filter dialect, and that made the
 * shim STRICTLY LESS CAPABLE than the platform it fronts. It refused `.or()`
 * ("Backenly composes AND filters"), refused `select('*, author(*)')` embeds,
 * never implemented `.overlaps()`, and accepted `upsert(values, { onConflict })`
 * while silently ignoring the conflict target.
 *
 * All four of those work in Postgres, because Backenly's data plane IS PostgREST
 * and `/api/v2/{projectId}/{table}` passes its grammar through untouched. The
 * refusals were not platform limits; they were limits of the translation layer
 * this file happened to be written against. And the two it refused loudest —
 * `.or()` and embeds — are the two a Supabase migrant depends on most.
 *
 * So the builder now emits PostgREST query strings directly. supabase-js is a
 * PostgREST client; so is this. The mapping is mostly the identity function,
 * which is the reason it can be complete.
 *
 * Contract fidelity:
 *   • Every operation resolves { data, error } and NEVER throws — the
 *     supabase-js convention frontends are written against.
 *   • Filters: eq/neq/gt/gte/lt/lte/like/ilike/in/is/or/not/contains/containedBy/
 *     overlaps/rangeGt/rangeLt/textSearch/filter/match — emitted as PostgREST.
 *   • select() column projection and embedded resources pass through verbatim.
 *   • upsert() honours onConflict and ignoreDuplicates via Prefer: resolution=…
 *   • count: 'exact' uses Prefer: count=exact and reads Content-Range.
 *   • auth.signUp / signInWithPassword / signOut / getUser / getSession map
 *     onto Backenly end-user auth (JWT sessions).
 *   • channel().on('postgres_changes', …) maps onto Backenly realtime.
 *   • rpc() is still refused — Backenly exposes no SQL functions by design —
 *     with the Backenly equivalent named. That is a real platform boundary,
 *     which is exactly why it is the only one left.
 */

import { BackenlyClient } from './client.js'

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

/**
 * Serialise a value into a PostgREST filter operand.
 *
 * PostgREST reserves `,` `.` `(` `)` and `"` inside filter values, and the escape
 * is a double-quoted string with backslash-escaped quotes. Getting this wrong is
 * how a value containing a comma silently becomes two filters.
 */
function operand(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const s = String(value)
  return /[,.()"\s]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s
}

/** `{a: 1}` / `[1,2]` → the PostgREST array or JSON literal an operator expects. */
function listOperand(values: unknown[]): string {
  return `(${values.map((v) => operand(v)).join(',')})`
}

/** PostgREST array literal for the array operators: cs / cd / ov. */
function arrayLiteral(values: unknown[]): string {
  return `{${values.map((v) => (typeof v === 'string' && /[,{}"\s]/.test(v) ? `"${v.replace(/(["\\])/g, '\\$1')}"` : String(v))).join(',')}}`
}

/**
 * Thenable filter chain. `await sb.from('posts').select().eq('id', 1)` works
 * because the builder implements then() — same trick supabase-js uses.
 *
 * Filters accumulate as raw PostgREST `key=op.value` pairs, in order, so a
 * chained `.eq().gte()` becomes exactly the query string supabase-js would have
 * sent. `.or()` is a first-class member of that list, not an exception to it.
 */
export class CompatQueryBuilder<T = any> implements PromiseLike<CompatResult<T[] | T>> {
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private filters: Array<[string, string]> = []
  private payload: unknown = null
  private selectColumns = '*'
  private orderParts: string[] = []
  private limitN: number | null = null
  private offsetN: number | null = null
  private wantSingle: 'strict' | 'maybe' | null = null
  private countMode: 'exact' | 'planned' | 'estimated' | null = null
  private returnRows = true
  private upsertPrefer: string[] = []
  private onConflict: string | null = null

  constructor(
    private backend: BackenlyClient,
    private tableName: string,
  ) {}

  // ── verbs ────────────────────────────────────────────────────────────────────

  /**
   * Column projection and embedded resources, passed through verbatim.
   *
   * `select('*, author(*)')` used to be REFUSED with "embeds are not supported by
   * the compat shim". They are supported — by Postgres, through PostgREST, which
   * is what serves this request. Refusing the single most-used PostgREST feature
   * blocked exactly the migration this file exists to enable.
   *
   * Embedding another table is not a security hole here: `anon` and
   * `authenticated` have been REVOKED on `users` and every `_`-prefixed table, so
   * `select=*,users(*)` fails on a missing privilege however it is spelled. The
   * boundary is a grant, never a parser.
   */
  select(columns?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    const c = columns?.trim()
    if (c) this.selectColumns = c
    if (opts?.count) this.countMode = opts.count
    if (opts?.head) this.returnRows = false
    return this
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.mode = 'insert'
    this.payload = values
    return this
  }

  /**
   * A real upsert. `onConflict` names the conflict target and
   * `ignoreDuplicates` chooses between merge and ignore, exactly as supabase-js
   * defines them.
   *
   * The previous implementation took `_opts` and threw it away — so a caller who
   * said "merge on email" got a plain insert that failed on the unique
   * constraint, and nothing in the response mentioned that the instruction had
   * been dropped. Accepting an argument and ignoring it is worse than refusing it.
   */
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean; count?: 'exact' | 'planned' | 'estimated' },
  ): this {
    this.mode = 'insert'
    this.payload = values
    this.upsertPrefer.push(opts?.ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates')
    if (opts?.onConflict) this.onConflict = opts.onConflict
    if (opts?.count) this.countMode = opts.count
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

  // ── filters → PostgREST operators, one to one ───────────────────────────────

  eq(column: string, value: unknown): this  { return this.push(column, `eq.${operand(value)}`) }
  neq(column: string, value: unknown): this { return this.push(column, `neq.${operand(value)}`) }
  gt(column: string, value: unknown): this  { return this.push(column, `gt.${operand(value)}`) }
  gte(column: string, value: unknown): this { return this.push(column, `gte.${operand(value)}`) }
  lt(column: string, value: unknown): this  { return this.push(column, `lt.${operand(value)}`) }
  lte(column: string, value: unknown): this { return this.push(column, `lte.${operand(value)}`) }
  in(column: string, values: unknown[]): this { return this.push(column, `in.${listOperand(values)}`) }

  like(column: string, pattern: string): this  { return this.push(column, `like.${operand(pattern)}`) }
  ilike(column: string, pattern: string): this { return this.push(column, `ilike.${operand(pattern)}`) }
  likeAllOf(column: string, patterns: string[]): this  { return this.push(column, `like(all).${listOperand(patterns)}`) }
  likeAnyOf(column: string, patterns: string[]): this   { return this.push(column, `like(any).${listOperand(patterns)}`) }
  ilikeAllOf(column: string, patterns: string[]): this  { return this.push(column, `ilike(all).${listOperand(patterns)}`) }
  ilikeAnyOf(column: string, patterns: string[]): this  { return this.push(column, `ilike(any).${listOperand(patterns)}`) }

  is(column: string, value: null | boolean): this {
    return this.push(column, `is.${value === null ? 'null' : String(value)}`)
  }

  /** Array / range / jsonb containment — `@>`. */
  contains(column: string, value: unknown[] | Record<string, unknown> | string): this {
    return this.push(column, `cs.${containmentOperand(value)}`)
  }

  /** Contained by — `<@`. */
  containedBy(column: string, value: unknown[] | Record<string, unknown> | string): this {
    return this.push(column, `cd.${containmentOperand(value)}`)
  }

  /**
   * Array / range overlap — `&&`.
   *
   * Previously "not implemented", which cost the array operators that are the
   * whole reason to choose an array column over jsonb.
   */
  overlaps(column: string, value: unknown[] | string): this {
    return this.push(column, `ov.${containmentOperand(value)}`)
  }

  rangeGt(column: string, range: string): this   { return this.push(column, `sr.${range}`) }
  rangeGte(column: string, range: string): this  { return this.push(column, `nxl.${range}`) }
  rangeLt(column: string, range: string): this   { return this.push(column, `sl.${range}`) }
  rangeLte(column: string, range: string): this  { return this.push(column, `nxr.${range}`) }
  rangeAdjacent(column: string, range: string): this { return this.push(column, `adj.${range}`) }

  textSearch(column: string, query: string, opts?: { type?: 'plain' | 'phrase' | 'websearch'; config?: string }): this {
    const op = opts?.type === 'plain' ? 'plfts' : opts?.type === 'phrase' ? 'phfts' : opts?.type === 'websearch' ? 'wfts' : 'fts'
    return this.push(column, `${op}${opts?.config ? `(${opts.config})` : ''}.${operand(query)}`)
  }

  /** Raw escape hatch — `filter('col', 'gte', 5)`, same as supabase-js. */
  filter(column: string, operator: string, value: unknown): this {
    return this.push(column, `${operator}.${operand(value)}`)
  }

  /** Negation — `.not('status', 'eq', 'draft')`. */
  not(column: string, operator: string, value: unknown): this {
    return this.push(column, `not.${operator}.${operand(value)}`)
  }

  /** `.match({ a: 1, b: 2 })` → two equality filters. */
  match(query: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(query)) this.eq(k, v)
    return this
  }

  /**
   * Disjunction. `or('is_public.eq.true,author_id.eq.7')`.
   *
   * This used to hard-refuse with "Backenly composes AND filters" — a statement
   * about the old translation layer, not about the database. PostgREST's `or=(…)`
   * has always been available on this data plane, and a Supabase frontend of any
   * size uses it.
   *
   * `referencedTable` scopes the disjunction to an embedded resource, matching
   * supabase-js's `{ referencedTable }` / legacy `{ foreignTable }` option.
   */
  or(filters: string, opts?: { referencedTable?: string; foreignTable?: string }): this {
    const scope = opts?.referencedTable ?? opts?.foreignTable
    return this.push(scope ? `${scope}.or` : 'or', `(${filters})`, /* raw */ true)
  }

  /** Conjunction, for nesting inside `or(...)` — `and=(a.eq.1,b.eq.2)`. */
  and(filters: string, opts?: { referencedTable?: string }): this {
    return this.push(opts?.referencedTable ? `${opts.referencedTable}.and` : 'and', `(${filters})`, true)
  }

  // ── modifiers ────────────────────────────────────────────────────────────────

  order(
    column: string,
    opts?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string },
  ): this {
    const dir = opts?.ascending === false ? 'desc' : 'asc'
    const nulls = opts?.nullsFirst === undefined ? '' : opts.nullsFirst ? '.nullsfirst' : '.nullslast'
    const scope = opts?.referencedTable ?? opts?.foreignTable
    this.orderParts.push(`${scope ? `${scope}.` : ''}${column}.${dir}${nulls}`)
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

  /** No-op, kept for source compatibility: every response here is already JSON. */
  csv(): this { return this }

  // ── execution ────────────────────────────────────────────────────────────────

  then<R1 = CompatResult<T[] | T>, R2 = never>(
    onfulfilled?: ((value: CompatResult<T[] | T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined)
  }

  private push(key: string, value: string, raw = false): this {
    this.filters.push([key, raw ? value : value])
    return this
  }

  /** Assemble the PostgREST query string in the order the chain was written. */
  private queryString(): string {
    const parts: string[] = []
    if (this.mode === 'select' || this.returnRows) {
      parts.push(`select=${encodeURIComponent(this.selectColumns)}`)
    }
    for (const [k, v] of this.filters) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    }
    if (this.orderParts.length) parts.push(`order=${encodeURIComponent(this.orderParts.join(','))}`)
    // single()/maybeSingle() ask for 2 so "more than one row" stays detectable —
    // returning the first of many silently would be a wrong answer.
    const effectiveLimit = this.wantSingle ? 2 : this.limitN
    if (effectiveLimit !== null && effectiveLimit !== undefined) parts.push(`limit=${effectiveLimit}`)
    if (this.offsetN !== null) parts.push(`offset=${this.offsetN}`)
    if (this.onConflict) parts.push(`on_conflict=${encodeURIComponent(this.onConflict)}`)
    return parts.join('&')
  }

  private preferHeader(): string | null {
    const prefer = [...this.upsertPrefer]
    if (this.countMode) prefer.push(`count=${this.countMode}`)
    if (this.mode !== 'select') {
      prefer.push(this.returnRows ? 'return=representation' : 'return=minimal')
    }
    return prefer.length ? prefer.join(',') : null
  }

  private async execute(): Promise<CompatResult<T[] | T>> {
    const projectId = this.backend.getProjectId()
    const method =
      this.mode === 'select' ? 'GET' :
      this.mode === 'insert' ? 'POST' :
      this.mode === 'update' ? 'PATCH' : 'DELETE'

    // Unfiltered writes stay refused. PostgREST would happily rewrite the whole
    // table, and a client library is the wrong place to make that easy.
    if ((this.mode === 'update' || this.mode === 'delete') && this.filters.length === 0) {
      return {
        data: null,
        error: err(
          `${this.mode}() requires at least one filter (e.g. .eq("id", …)) — unfiltered ${this.mode}s are refused`,
          'NO_FILTER',
        ),
        count: null,
        status: 400,
        statusText: 'Bad Request',
      }
    }

    const qs = this.queryString()
    const path = `/api/v2/${projectId}/${encodeURIComponent(this.tableName)}${qs ? `?${qs}` : ''}`
    const prefer = this.preferHeader()

    try {
      const res = await this.backend.rawRequest(path, {
        method,
        ...(prefer ? { headers: { Prefer: prefer } } : {}),
        ...(this.mode === 'insert' || this.mode === 'update'
          ? { body: JSON.stringify(this.payload) }
          : {}),
      })

      const count = parseContentRange(res.headers.get('content-range'))
      const text = await res.text()
      const parsed = text ? safeJson(text) : null

      if (!res.ok) {
        // PostgREST error bodies are already { message, code, details, hint } —
        // the exact shape supabase-js surfaces. Pass it through rather than
        // flattening it into a string, which is what loses the code a caller
        // branches on.
        const body: any = parsed ?? {}
        return {
          data: null,
          error: {
            message: body.message ?? `Request failed with ${res.status}`,
            code: body.code ?? String(res.status),
            details: body.details ?? null,
            hint: body.hint ?? null,
          },
          count,
          status: res.status,
          statusText: res.statusText,
        }
      }

      const rows: T[] = Array.isArray(parsed) ? parsed : parsed ? [parsed as T] : []

      if (this.wantSingle) {
        if (rows.length === 0) {
          return this.wantSingle === 'strict'
            ? {
                data: null,
                error: err('JSON object requested, multiple (or no) rows returned', 'PGRST116', 'single() found 0 rows'),
                count,
                status: 406,
                statusText: 'Not Acceptable',
              }
            : { data: null, error: null, count, status: 200, statusText: 'OK' }
        }
        if (rows.length > 1) {
          return {
            data: null,
            error: err('JSON object requested, multiple (or no) rows returned', 'PGRST116', 'single() found more than one row'),
            count,
            status: 406,
            statusText: 'Not Acceptable',
          }
        }
        return { data: rows[0], error: null, count, status: res.status, statusText: res.statusText }
      }

      return {
        data: this.returnRows ? rows : null,
        error: null,
        count: this.countMode ? count : null,
        status: res.status,
        statusText: res.statusText,
      }
    } catch (e) {
      return { data: null, error: fromException(e), count: null, status: 400, statusText: 'Bad Request' }
    }
  }
}

/** `cs` / `cd` / `ov` take an array literal for arrays and JSON for objects. */
function containmentOperand(value: unknown[] | Record<string, unknown> | string): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return arrayLiteral(value)
  return JSON.stringify(value)
}

/** PostgREST reports the exact count in `Content-Range: 0-24/573`. */
function parseContentRange(header: string | null): number | null {
  if (!header) return null
  const total = header.split('/')[1]
  if (!total || total === '*') return null
  const n = Number(total)
  return Number.isFinite(n) ? n : null
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
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
