/**
 * PHASE 3 — wire-contract translation between Backenly's public REST API and
 * PostgREST's grammar.
 *
 * PostgREST is the new EXECUTION engine. It is not the new public contract.
 * Those are different things, and conflating them is how a migration silently
 * breaks every client that already exists.
 *
 * The two grammars disagree on essentially everything a caller touches:
 *
 *   filter    ?status=paid                 →  ?status=eq.paid
 *   sort      ?sort=created_at&order=desc  →  ?order=created_at.desc
 *   list body {data,pagination:{…}}        →  bare array + Content-Range header
 *   soft del  implicit deleted_at IS NULL  →  no such concept
 *
 * That last row is the dangerous one. Backenly's executor appends
 * `deleted_at IS NULL` to every list query, so "deleted" rows stay hidden.
 * PostgREST knows nothing about that convention, so a transparent proxy would
 * begin serving soft-deleted records to every caller — a disclosure of data the
 * user believes is gone, produced by a change that looks like plumbing. The
 * predicate is therefore re-added HERE, on every read, and can only be lifted
 * by the same explicit `include_deleted=true` the old executor honoured.
 *
 * Everything in this module is a pure function so the contract can be tested
 * without a database, a network, or a running PostgREST.
 */

/** Query params the old executor treated as controls rather than column filters. */
export const RESERVED_QUERY_PARAMS = new Set([
  'limit', 'offset', 'sort', 'order', 'cursor', 'include_deleted', 'page', 'include', 'select',
])

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * PostgREST reads `,` as a value separator and `.` as the operator delimiter, so
 * a raw value containing either would be reparsed as syntax. Double-quoting is
 * PostgREST's own escape hatch; inner quotes and backslashes are escaped so a
 * crafted value cannot terminate the quoted region early and inject an operator.
 */
export function encodeFilterValue(value: string): string {
  const raw = String(value ?? '')
  if (/^[a-zA-Z0-9_\-+:@ ]*$/.test(raw)) return raw
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface TranslateReadOptions {
  /** Column filters + controls exactly as the caller sent them. */
  query: Record<string, string | string[] | undefined>
  /** True when the target table actually has a deleted_at column. */
  hasSoftDelete: boolean
  /** Single-record fetch by primary key, e.g. GET /db/posts/{id}. */
  recordId?: string
  /** Primary key column name; defaults to id. */
  primaryKey?: string
}

export interface TranslatedQuery {
  /** Query string for PostgREST, WITHOUT a leading `?`. */
  search: string
  /** Whether the caller asked for a bounded page (drives Content-Range use). */
  limit: number
  offset: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1000

function firstValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

/** Backenly REST query params → PostgREST query string. */
export function translateReadQuery(opts: TranslateReadOptions): TranslatedQuery {
  const { query, hasSoftDelete, recordId } = opts
  const pk = opts.primaryKey && IDENT.test(opts.primaryKey) ? opts.primaryKey : 'id'
  const parts: string[] = []

  // Column filters. Unknown-shaped keys are DROPPED rather than passed through:
  // the old executor applied the same allowlist, and forwarding a key it would
  // have ignored could turn a previously-ignored param into a live predicate.
  for (const [key, rawValue] of Object.entries(query)) {
    if (RESERVED_QUERY_PARAMS.has(key)) continue
    if (!IDENT.test(key)) continue
    const value = firstValue(rawValue)
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=eq.${encodeURIComponent(encodeFilterValue(value))}`)
  }

  if (recordId !== undefined) {
    parts.push(`${pk}=eq.${encodeURIComponent(encodeFilterValue(recordId))}`)
  }

  // Soft-delete predicate — re-added because PostgREST has no notion of it.
  // Only an explicit include_deleted=true lifts it, matching the old behaviour.
  const includeDeleted = firstValue(query.include_deleted) === 'true'
  if (hasSoftDelete && !includeDeleted) {
    parts.push('deleted_at=is.null')
  }

  // Projection.
  const select = firstValue(query.select)
  if (select) {
    const cols = select.split(',').map(c => c.trim()).filter(c => IDENT.test(c))
    if (cols.length > 0) parts.push(`select=${encodeURIComponent(cols.join(','))}`)
  }

  // Ordering: two params collapse into one.
  const sort = firstValue(query.sort)
  if (sort && IDENT.test(sort)) {
    const dir = firstValue(query.order)?.toLowerCase() === 'desc' ? 'desc' : 'asc'
    parts.push(`order=${encodeURIComponent(`${sort}.${dir}`)}`)
  }

  // Pagination. Clamped: an unbounded limit lets one request pull an entire
  // table into memory, which the old executor also refused to do.
  const rawLimit = Number.parseInt(firstValue(query.limit) ?? '', 10)
  const rawOffset = Number.parseInt(firstValue(query.offset) ?? '', 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0

  if (recordId === undefined) {
    parts.push(`limit=${limit}`)
    if (offset > 0) parts.push(`offset=${offset}`)
  }

  return { search: parts.join('&'), limit, offset }
}

/**
 * PostgREST reports totals in `Content-Range: 0-24/573` (requested via
 * `Prefer: count=exact`). `*` means "not counted".
 */
export function parseContentRange(header: string | null | undefined): number | null {
  if (!header) return null
  const total = header.split('/')[1]
  if (!total || total === '*') return null
  const n = Number.parseInt(total, 10)
  return Number.isFinite(n) ? n : null
}

export interface ListEnvelope {
  data: unknown[]
  pagination: {
    total: number
    limit: number
    offset: number
    hasMore: boolean
    /**
     * Last row's id when more pages remain, else null.
     *
     * Present because the legacy executor emits it and a client reading
     * `pagination.nextCursor` would otherwise see `undefined` instead of `null`
     * the moment its project was cut over. Caught by the parity verifier against
     * a live cutover — every unit test passed while this was missing, because
     * the tests asserted the fields I remembered rather than the fields the old
     * engine actually returns.
     */
    nextCursor: string | number | null
  }
}

/**
 * Bare PostgREST array → the `{data, pagination}` envelope clients already parse.
 *
 * When the total is unknown, hasMore is inferred from a full page rather than
 * reported as false: claiming "no more rows" on missing information would stop
 * paginating clients early and silently truncate their results.
 */
export function toListEnvelope(
  rows: unknown[],
  contentRange: string | null | undefined,
  limit: number,
  offset: number,
): ListEnvelope {
  const total = parseContentRange(contentRange)
  const hasMore = total === null ? rows.length >= limit : offset + rows.length < total

  // Mirrors the legacy executor: the last row's id when more pages remain,
  // otherwise null. Reading it off the row rather than computing it keeps the
  // two engines agreeing even when the id is not sequential.
  const last = rows.length > 0 ? (rows[rows.length - 1] as Record<string, unknown>) : undefined
  const lastId = last && (typeof last.id === 'string' || typeof last.id === 'number') ? last.id : null
  const nextCursor = hasMore ? lastId : null

  return {
    data: rows,
    pagination: { total: total ?? offset + rows.length, limit, offset, hasMore, nextCursor },
  }
}

export interface StructuredApiError {
  error: string
  code: string
  details?: string
  hint?: string
}

/** PostgREST error SQLSTATE → HTTP status, matching the old executor's mapping. */
const PG_STATUS: Record<string, number> = {
  '23502': 400, // not null violation
  '23503': 409, // foreign key violation
  '23505': 409, // unique violation
  '23514': 400, // check violation
  '22001': 400, // string too long
  '22007': 400, // invalid datetime format
  '22P02': 400, // invalid text representation
  '42703': 400, // undefined column
  '42P01': 404, // undefined table
  // 42501 (insufficient privilege) is deliberately ABSENT. Entries in this map
  // keep PostgREST's own wording, which for a privilege error reads
  // "permission denied for table users" — naming a table the caller was not
  // supposed to learn exists. It is handled below as a plain FORBIDDEN instead.
}

/**
 * PostgREST's error body → Backenly's `{error, code}` shape.
 *
 * PostgREST echoes the failing SQL construct in `message`/`details`, which can
 * carry column names, constraint definitions and row values. That is fine for a
 * trusted operator and wrong for a public API, so only recognised
 * constraint-class errors keep their text; anything else is reduced to a
 * generic message and the real detail is left to the server log.
 */
export function toApiError(
  status: number,
  body: unknown,
): { status: number; body: StructuredApiError } {
  const b = (body ?? {}) as Record<string, unknown>
  const pgCode = typeof b.code === 'string' ? b.code : undefined
  const message = typeof b.message === 'string' ? b.message : ''

  // Checked before the constraint map so a privilege error can never take the
  // message-echoing path.
  if (pgCode === '42501' || status === 401 || status === 403) {
    return {
      status: status === 401 ? 401 : 403,
      body: { error: 'Not authorized to perform this operation', code: 'FORBIDDEN' },
    }
  }

  // ── PGRST106: the schema is not in PostgREST's exposed list ─────────────────
  //
  // Two separate things were wrong with how this used to be answered, and both
  // were reported from a real build.
  //
  // 1. STATUS. It fell through to the generic branch, where PostgREST's own 406
  //    was passed straight through and labelled `BAD_REQUEST`. Nothing about the
  //    request was bad: the same call succeeds the instant the server registers
  //    the schema. Reporting a server-side provisioning gap as a 4xx sends every
  //    reader — human and agent — to debug the caller, which is exactly what
  //    happened. It also tells retry logic and uptime monitors not to care.
  //    503 + Retry-After is what this is: temporarily unavailable, server's
  //    fault, worth retrying.
  //
  // 2. DISCLOSURE. PostgREST's message for this error is
  //      "Invalid schema: workspace_<id>. Only the following schemas are
  //       exposed: workspace_<other>, workspace_<other>, ..."
  //    — i.e. it enumerates the identifiers of every other tenant on the
  //    instance. That body was echoed to whoever asked. Any holder of any valid
  //    key could list the platform's projects by requesting a table before their
  //    own schema was registered. `message` is therefore never read here; the
  //    branch keys off the code alone and writes its own text.
  //
  // The runtime repairs this before it is ever reached (see the self-heal in
  // server/routes/postgrest-handler.ts). This is what the caller sees if the
  // repair itself failed.
  if (pgCode === 'PGRST106') {
    return {
      status: 503,
      body: {
        error: 'This project\'s data plane is still being provisioned. Retry shortly.',
        code: 'DATA_PLANE_PROVISIONING',
        hint: 'The server is registering this project with the data plane. This is not a problem with your request or your key.',
      },
    }
  }

  // PGRST002 — the schema cache failed to build. Instance-wide, not caller's
  // fault, and clears only on a restart (see lib/postgrest/health.ts).
  if (pgCode === 'PGRST002') {
    return {
      status: 503,
      body: {
        error: 'The data plane is temporarily unavailable.',
        code: 'DATA_PLANE_UNAVAILABLE',
      },
    }
  }

  if (pgCode && PG_STATUS[pgCode]) {
    return {
      status: PG_STATUS[pgCode],
      body: {
        error: message || 'Request could not be completed',
        code: pgCode === '42P01' ? 'TABLE_NOT_FOUND' : 'DB_CONSTRAINT_ERROR',
        details: typeof b.details === 'string' ? b.details : undefined,
        hint: typeof b.hint === 'string' ? b.hint : undefined,
      },
    }
  }

  if (status === 404) {
    return { status: 404, body: { error: 'Resource not found', code: 'NOT_FOUND' } }
  }

  // 406 from PostgREST is content negotiation, and this gateway sets every
  // negotiation header itself — the caller cannot cause one. Passing it through
  // as a 4xx blamed the client for a server-side condition, and `BAD_REQUEST`
  // alongside a 406 was internally contradictory besides: the status says the
  // representation was unacceptable, the code says the request was malformed.
  if (status === 406) {
    return {
      status: 503,
      body: {
        error: 'The data plane could not serve this request.',
        code: 'DATA_PLANE_UNAVAILABLE',
      },
    }
  }

  return {
    status: status >= 400 && status < 500 ? status : 500,
    body: {
      error: status >= 500 ? 'Internal server error' : 'Request could not be completed',
      code: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
    },
  }
}

/**
 * Sanitise a PostgREST error body for the /api/v2 passthrough.
 *
 * v2's contract is that PostgREST's own response comes back untouched — that is
 * the whole reason it exists, and for SUCCESS bodies it stays true. Error bodies
 * are different, because PostgREST writes them for an operator with full access
 * to the instance, not for one tenant among many:
 *
 *   PGRST106 enumerates every exposed schema, which on a shared instance is a
 *   list of every other customer's project id. That body reached a real user
 *   holding an unrelated key, and it named four other tenants.
 *
 * So the SHAPE is preserved — `{code, message, details, hint}`, so PostgREST
 * clients keep parsing it — while the content of anything that can describe the
 * instance rather than the request is replaced. Constraint-class errors (23xxx,
 * 22xxx, 42703) keep their real text: those describe the caller's own data and
 * are the ones worth reading.
 */
export function stripUpstreamError(
  status: number,
  body: unknown,
): { status: number; body: Record<string, unknown> } {
  const b = (body ?? {}) as Record<string, unknown>
  const pgCode = typeof b.code === 'string' ? b.code : undefined

  if (pgCode === 'PGRST106' || pgCode === 'PGRST002') {
    return {
      status: 503,
      body: {
        code: pgCode === 'PGRST106' ? 'DATA_PLANE_PROVISIONING' : 'DATA_PLANE_UNAVAILABLE',
        message:
          pgCode === 'PGRST106'
            ? 'This project\'s data plane is still being provisioned. Retry shortly.'
            : 'The data plane is temporarily unavailable.',
      },
    }
  }

  // Caller-facing constraint errors: real text, because it is about their row.
  const SAFE_PREFIXES = ['23', '22', '42703', '42P01', 'PGRST100', 'PGRST116', 'PGRST118', 'PGRST200']
  if (pgCode && SAFE_PREFIXES.some(p => pgCode.startsWith(p))) {
    return {
      status,
      body: {
        code: pgCode,
        message: b.message,
        ...(b.details !== undefined ? { details: b.details } : {}),
        ...(b.hint !== undefined ? { hint: b.hint } : {}),
      },
    }
  }

  if (pgCode === '42501' || status === 401 || status === 403) {
    return {
      status: status === 401 ? 401 : 403,
      body: { code: 'FORBIDDEN', message: 'Not authorized to perform this operation' },
    }
  }

  return {
    status: status >= 400 && status < 500 ? status : 500,
    body: {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
      message: status >= 500 ? 'Internal server error' : 'Request could not be completed',
    },
  }
}

/** Envelope for a single-record response, matching the old executor's wording. */
export function toRecordEnvelope(
  row: unknown,
  kind: 'created' | 'updated' | 'fetched',
): { data: unknown; message?: string } {
  if (kind === 'created') return { data: row, message: 'Record created successfully' }
  if (kind === 'updated') return { data: row, message: 'Record updated successfully' }
  return { data: row }
}
