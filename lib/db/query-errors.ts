/**
 * Structured, self-correctable database errors.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-19 an agent tried to insert a row and got back:
 *
 *     Type mismatch — a value has the wrong type for its column.
 *
 * It then burned roughly a dozen attempts probing ISO strings, epoch millis,
 * epoch seconds, plain datetimes and date-only spellings, never learning WHICH
 * column was wrong or WHAT the column wanted — and finally "fixed" it by
 * casting the column to integer, corrupting the schema.
 *
 * PostgreSQL had already produced everything needed to recover on the first
 * try. The error layer threw it away. An error an agent cannot act on is not a
 * message, it is a dead end: it converts a one-turn correction into a blind
 * retry loop, which is the single largest driver of agent benchmark failure.
 *
 * THE CONTRACT
 * ------------
 * Every failure returns PostgREST's shape — `code`, `message`, `details`,
 * `hint` — extended with the fields an agent needs to self-correct without
 * guessing: `column`, `expected`, `received`, `example`.
 *
 * The shape is deliberately PostgREST-compatible: when the data plane moves to
 * PostgREST (Phase 3), its native errors already carry code/message/details/
 * hint, and the gateway enriches them with column/expected/example using the
 * same helpers here. This module survives that migration instead of being
 * thrown away.
 *
 * KEY INSIGHT
 * -----------
 * PostgreSQL frequently reports the offending TYPE and VALUE but not the column
 * (SQLSTATE 22007/22P02 say `invalid input syntax for type timestamp:
 * "not-a-date"`). The caller, however, knows exactly which columns it bound and
 * in what order. Correlating the two recovers the column name that PostgreSQL
 * omitted — which is why every entry point passes a QueryContext.
 */

/** What the caller bound, so an error can be traced back to a column. */
export interface QueryContext {
  table: string
  /** Column names in bind order. */
  columns: string[]
  /** Bound values in the same order as `columns`. */
  values: unknown[]
  /** column name → PostgreSQL data_type, from the live catalog. */
  types: Map<string, string>
}

/** PostgREST-compatible superset. `code` is the SQLSTATE when one is available. */
export interface StructuredDbError {
  code: string
  message: string
  details?: string
  hint?: string
  column?: string
  expected?: string
  received?: string
  example?: string
  /** Real column list — supplied when the agent referenced one that isn't there. */
  available?: string[]
}

export class QueryError extends Error {
  readonly structured: StructuredDbError
  constructor(structured: StructuredDbError) {
    super(structured.message)
    this.name = 'QueryError'
    this.structured = structured
  }
}

/** A value of each type that PostgreSQL definitely accepts. */
const EXAMPLE_FOR_TYPE: Record<string, string> = {
  'timestamp with time zone': '2026-07-18T10:00:00Z',
  'timestamp without time zone': '2026-07-18T10:00:00Z',
  timestamptz: '2026-07-18T10:00:00Z',
  timestamp: '2026-07-18T10:00:00Z',
  date: '2026-07-18',
  'time without time zone': '10:00:00',
  'time with time zone': '10:00:00+00',
  time: '10:00:00',
  interval: '1 day',
  uuid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  numeric: '84.32',
  decimal: '84.32',
  'double precision': '84.32',
  real: '84.32',
  integer: '42',
  smallint: '42',
  bigint: '42',
  boolean: 'true',
  json: '{"key":"value"}',
  jsonb: '{"key":"value"}',
  text: 'some text',
  'character varying': 'some text',
}

export function exampleForType(dataType: string | undefined): string | undefined {
  if (!dataType) return undefined
  const key = dataType.toLowerCase().trim()
  return EXAMPLE_FOR_TYPE[key] ?? EXAMPLE_FOR_TYPE[key.replace(/\(.*$/, '')]
}

const SQLSTATE_HINT: Record<string, string> = {
  '23503': 'Insert the parent row first, then reference its id. get_table_schema shows the foreign-key targets.',
  '23505': 'Use a different value, or update the existing row instead of inserting a new one.',
  '23502': 'Supply a value for this column, or make it nullable.',
  '23514': 'Call get_table_schema to see the exact allowed values for this column.',
  '42703': 'Call get_table_schema for the real column list.',
  '42P01': 'Call list_tables to see which tables exist in this project.',
}

// ── parsing helpers ───────────────────────────────────────────────────────────

/** Prisma wraps the driver error; pull out the SQLSTATE and the inner message. */
function parseRaw(raw: string): { code?: string; inner: string; detail?: string } {
  const code = /Code:\s*`?([0-9A-Z]{5})`?/.exec(raw)?.[1]
  const inner =
    /Message:\s*`?(?:ERROR:\s*)?([^`\n]+)`?/.exec(raw)?.[1] ??
    raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] ??
    raw
  const detail = /DETAIL:\s*([^\n]+)/.exec(raw)?.[1]
  return { code, inner: inner.trim(), detail }
}

/**
 * Recover the offending column when PostgreSQL named a type and a value but not
 * the column. Matching the literal value is the strongest signal; falling back
 * to a unique type match handles the case where the value was truncated.
 */
function inferColumn(
  ctx: QueryContext | undefined,
  opts: { value?: string; type?: string },
): string | undefined {
  if (!ctx) return undefined

  if (opts.value !== undefined) {
    const hit = ctx.columns.find((c, i) => String(ctx.values[i]) === opts.value)
    if (hit) return hit
  }

  if (opts.type) {
    const wanted = opts.type.toLowerCase()
    const matches = ctx.columns.filter((c) => {
      const t = (ctx.types.get(c) ?? '').toLowerCase()
      return t === wanted || t.startsWith(wanted) || wanted.startsWith(t)
    })
    // Only trust a type match when it is unambiguous.
    if (matches.length === 1) return matches[0]
  }

  return undefined
}

// ── main entry point ──────────────────────────────────────────────────────────

/**
 * Turn a raw driver error into something an agent can act on in one turn.
 * Never throws; an unrecognised error still yields a usable message.
 */
export function explainDbError(err: unknown, ctx?: QueryContext): QueryError {
  const raw = err instanceof Error ? err.message : String(err)
  const { code, inner, detail } = parseRaw(raw)
  const table = ctx?.table

  const base = (over: Partial<StructuredDbError>): QueryError =>
    new QueryError({
      code: code ?? 'DB_ERROR',
      message: inner,
      ...(detail ? { details: detail } : {}),
      ...(code && SQLSTATE_HINT[code] ? { hint: SQLSTATE_HINT[code] } : {}),
      ...over,
    })

  switch (code) {
    // Bad literal for the column's type. PostgreSQL gives type + value, not column.
    case '22007':
    case '22P02': {
      const m = /invalid input syntax for (?:type )?([a-z ]+):\s*"([^"]*)"/i.exec(inner)
      const pgType = m?.[1]?.trim()
      const value = m?.[2]
      const column = inferColumn(ctx, { value, type: pgType })
      const expected = (column && ctx?.types.get(column)) || pgType
      const example = exampleForType(expected)
      return base({
        column,
        expected,
        received: value !== undefined ? JSON.stringify(value) : undefined,
        example,
        message: column
          ? `Column "${column}" expected ${expected}, received ${JSON.stringify(value ?? '')}.`
          : `A value expected ${expected}, received ${JSON.stringify(value ?? '')}.`,
        hint: example
          ? `Send a value like ${JSON.stringify(example)}.`
          : undefined,
      })
    }

    // Column type vs bound expression type.
    case '42804': {
      const m = /column "([^"]+)" is of type ([a-z ]+) but expression is of type ([a-z ]+)/i.exec(inner)
      const column = m?.[1] ?? inferColumn(ctx, {})
      const expected = m?.[2]?.trim() ?? (column ? ctx?.types.get(column) : undefined)
      const example = exampleForType(expected)
      return base({
        column,
        expected,
        received: m?.[3]?.trim(),
        example,
        message: column
          ? `Column "${column}" expected ${expected}, received ${m?.[3]?.trim() ?? 'a different type'}.`
          : inner,
        hint: example ? `Send a value like ${JSON.stringify(example)}.` : undefined,
      })
    }

    case '23502': {
      const column = /null value in column "([^"]+)"/i.exec(inner)?.[1]
      const expected = column ? ctx?.types.get(column) : undefined
      return base({
        column,
        expected,
        example: exampleForType(expected),
        message: column
          ? `Column "${column}" is NOT NULL and expected a value, received null.`
          : inner,
      })
    }

    case '23505': {
      const m = /Key \(([^)]+)\)=\(([^)]*)\) already exists/i.exec(detail ?? inner)
      const column = m?.[1]
      return base({
        column,
        received: m?.[2] !== undefined ? JSON.stringify(m[2]) : undefined,
        message: column
          ? `Column "${column}" must be unique; the value ${JSON.stringify(m?.[2] ?? '')} already exists.`
          : inner,
      })
    }

    case '23503': {
      const m = /Key \(([^)]+)\)=\(([^)]*)\) is not present in table "([^"]+)"/i.exec(detail ?? inner)
      const column = m?.[1]
      const parent = m?.[3]
      return base({
        column,
        received: m?.[2] !== undefined ? JSON.stringify(m[2]) : undefined,
        message: column && parent
          ? `Column "${column}" expected an existing "${parent}".id, received ${JSON.stringify(m?.[2] ?? '')} which does not exist.`
          : `Foreign key violation — a referenced row does not exist.`,
        hint: parent
          ? `Insert the "${parent}" row first, then use its id here.`
          : SQLSTATE_HINT['23503'],
      })
    }

    case '23514': {
      const constraint = /violates check constraint "([^"]+)"/i.exec(inner)?.[1]
      // Constraints are named chk_<table>_<column> by the executor.
      const column = constraint
        ? ctx?.columns.find((c) => constraint.endsWith(`_${c}`))
        : undefined
      return base({
        column,
        message: column
          ? `Column "${column}" expected one of its allowed values; the value given is not permitted.`
          : inner,
        details: constraint ? `constraint ${constraint}` : detail,
      })
    }

    case '42703': {
      const column = /column "([^"]+)"/i.exec(inner)?.[1]
      const available = ctx ? [...ctx.types.keys()] : undefined
      return base({
        column,
        available,
        message: column
          ? `Column "${column}" does not exist${table ? ` on "${table}"` : ''}.`
          : inner,
        hint: available?.length
          ? `Available columns: ${available.join(', ')}.`
          : SQLSTATE_HINT['42703'],
      })
    }

    case '42P01':
      return base({
        message: `Table ${table ? `"${table}" ` : ''}does not exist in this project.`,
      })

    default:
      return base({})
  }
}

/** Response body for an API route. Keeps `error` for backwards compatibility. */
export function dbErrorBody(err: unknown, fallbackCode: string) {
  const structured =
    err instanceof QueryError
      ? err.structured
      : { code: fallbackCode, message: err instanceof Error ? err.message : String(err) }

  return {
    ok: false as const,
    // Legacy field — existing clients read this.
    error: structured.message,
    code: structured.code || fallbackCode,
    ...structured,
  }
}
