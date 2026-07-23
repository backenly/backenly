/**
 * Strict body parsing for the MCP data plane.
 *
 * Every /api/mcp/db/* route declared a non-strict `z.object()`, so Zod silently
 * STRIPPED any key it did not declare. An agent that asked db_query for an
 * aggregate — `{ table, select: 'count(*)', groupBy: 'name' }` — got HTTP 200,
 * `ok: true`, and a page of raw rows. The request that ran was not the request
 * that was sent, and nothing said so.
 *
 * That is strictly worse than the blind-error class the reliability harness was
 * built to catch. A blind error at least fails, so an agent knows to try again.
 * A silent strip returns a plausible wrong answer under a success code, which an
 * agent will believe and then build on.
 *
 * So unknown keys are rejected and named. And when they express set-based intent
 * the filter DSL genuinely cannot serve, the error routes to the surface that
 * CAN serve it instead of dead-ending: a READ_ONLY connection string, which
 * provisions instantly and is SELECT-only. Naming the way forward is the whole
 * difference between an error an agent recovers from in one turn and one it
 * retries blindly.
 */

import { z } from 'zod'

/**
 * Keys that express set-based work: aggregation, joins, projection, raw SQL.
 * These are not typos to be corrected — they are a capability request the
 * filter DSL cannot express at any spelling, so they get a route, not a list.
 */
const SET_BASED_KEYS = new Set([
  'select', 'columns', 'projection',
  'groupby', 'group_by', 'group',
  'having',
  'join', 'joins', 'include', 'includes', 'embed', 'expand', 'relations',
  'aggregate', 'aggregates', 'aggregation',
  'distinct', 'count', 'sum', 'avg', 'average', 'min', 'max',
  'window', 'over', 'partition', 'partitionby',
  'cte', 'with', 'union',
  'sql', 'rawsql', 'query', 'where',
])

export interface McpBodyError {
  ok: false
  error: string
  code: 'BAD_BODY' | 'UNKNOWN_PARAMS' | 'UNSUPPORTED_PARAMS'
  /** The offending keys, so the agent does not have to diff its own payload. */
  unsupported?: string[]
  /** Every key this endpoint does accept — the 42703 `available` pattern. */
  supported?: string[]
  hint?: string
}

/**
 * The complementary `?: undefined` members are load-bearing: `z.infer<S>` is a
 * deferred conditional type while S is generic, and TypeScript will not narrow
 * a union whose members reference one. Spelling both sides of each field makes
 * the discriminant sufficient on its own.
 */
export type McpBodyResult<T> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; data?: undefined; error: McpBodyError }

/**
 * Parse a request body against a schema, rejecting unknown top-level keys.
 *
 * `schema` must be a `z.object`; it is made strict here so no route can forget.
 * Only the TOP level is strict — `row`, `patch`, `filter` and `orderBy` stay
 * free-form records, because their keys are user column names.
 */
export function parseMcpBody<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
  json: unknown,
  tool: string,
): McpBodyResult<z.infer<S>> {
  const supported = Object.keys(schema.shape)
  const parsed = schema.strict().safeParse(json)

  if (parsed.success) return { ok: true, data: parsed.data }

  const unrecognized = parsed.error.issues
    .filter((i) => i.code === 'unrecognized_keys')
    .flatMap((i) => (i as z.ZodIssue & { keys: string[] }).keys)

  if (unrecognized.length > 0) {
    const setBased = unrecognized.filter((k) => SET_BASED_KEYS.has(k.toLowerCase()))

    if (setBased.length > 0) {
      return {
        ok: false,
        error: {
          ok: false,
          code: 'UNSUPPORTED_PARAMS',
          error:
            `${tool} does not support: ${setBased.join(', ')}. ` +
            `It filters rows and returns them whole — it cannot aggregate, join, or project columns.`,
          unsupported: setBased,
          supported,
          // This used to route to get_database_credentials + "run SQL over the
          // returned connection string" — correct before `run_query` existed,
          // and never updated when it shipped. It sent the agent to provision a
          // Postgres role for a question one tool call answers. A stale hint is
          // worse than none: it is confidently wrong and costs a whole turn.
          hint:
            'Use run_query — it executes full read-only PostgreSQL against this project, ' +
            'including joins, GROUP BY, aggregates, window functions, CTEs and EXPLAIN. ' +
            'e.g. run_query({ sql: "SELECT status, count(*) FROM orders GROUP BY status" }).',
        },
      }
    }

    return {
      ok: false,
      error: {
        ok: false,
        code: 'UNKNOWN_PARAMS',
        error: `${tool} received unknown parameter(s): ${unrecognized.join(', ')}.`,
        unsupported: unrecognized,
        supported,
      },
    }
  }

  return {
    ok: false,
    error: {
      ok: false,
      code: 'BAD_BODY',
      error: parsed.error.issues[0]?.message ?? 'Invalid body.',
      supported,
    },
  }
}
