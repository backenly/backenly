/**
 * The arguments of the four row tools, defined once.
 *
 * db_query, db_insert, db_update and db_delete are served two ways: by their
 * own routes (/api/mcp/db/*), which the reliability harness and stdio packages
 * before 0.4.0 call, and by /api/mcp/tool, which the remote MCP endpoint and
 * the stdio package from 0.4.0 call. Only the routes validated. /api/mcp/tool
 * handed its args to the helper as they came, so the same call that one surface
 * refused with the offending keys named (`select`, `groupBy`: use run_query)
 * ran on the other with those keys ignored, or failed with whatever the helper
 * happened to throw.
 *
 * Both surfaces now parse with these schemas, through parseMcpBody, and fall
 * back to the same failure code, so a call is refused, or runs, the same way
 * whichever surface it reached. The catalog's advertised inputSchema for each
 * tool is checked against these keys in tests/unit/mcp-db-tool-requests.spec.ts.
 *
 * The empty-filter refusals are kept here as well as in lib/mcp/runtime-db.ts:
 * here they are refused before anything runs, with the rest of the argument
 * errors; there they stay the last guard for any caller that skips parsing.
 */

import { z } from 'zod'

const table = z.string().trim().min(1).max(63)
const nonEmpty = (message: string) => z.record(z.unknown()).refine((r) => Object.keys(r).length > 0, message)

export const DB_TOOL_REQUESTS = {
  db_query: z.object({
    table,
    filter: z.record(z.unknown()).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    orderBy: z.record(z.unknown()).optional(),
  }),
  db_insert: z.object({
    table,
    row: nonEmpty('row must include at least one column'),
  }),
  db_update: z.object({
    table,
    filter: nonEmpty('filter must be non-empty (refusing table-wide UPDATE)'),
    patch: nonEmpty('patch must include at least one column'),
  }),
  db_delete: z.object({
    table,
    filter: nonEmpty('filter must be non-empty (refusing table-wide DELETE)'),
  }),
}

export type DbToolName = keyof typeof DB_TOOL_REQUESTS

export function isDbTool(name: string): name is DbToolName {
  return Object.prototype.hasOwnProperty.call(DB_TOOL_REQUESTS, name)
}

/** The code a helper failure carries when it is not a classified QueryError. */
export const DB_TOOL_FAILURE_CODE: Record<DbToolName, string> = {
  db_query: 'QUERY_FAILED',
  db_insert: 'INSERT_FAILED',
  db_update: 'UPDATE_FAILED',
  db_delete: 'DELETE_FAILED',
}
