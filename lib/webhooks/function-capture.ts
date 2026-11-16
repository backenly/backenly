/**
 * Whether the project's row-event functions can fire: the Functions page's
 * capture health (GET /api/projects/[id]/ai-functions, `capture`).
 *
 * on_db_insert / on_db_update / on_db_delete functions fire from the same
 * database-level capture trigger as row webhooks (lib/webhooks/capture.ts).
 * The webhooks list already says when that trigger is missing; the functions
 * list said nothing, so a function like on-review-created could stop firing
 * with every row of the page still green. The answer is read from the
 * database catalog (listCapturedTables), never from a flag this app set.
 *
 * Pure: the route reads the catalog and passes the tables in.
 */

/** The function triggers that fire from row capture. */
export const ROW_EVENT_FUNCTION_TRIGGERS: ReadonlySet<string> = new Set(['on_db_insert', 'on_db_update', 'on_db_delete'])

export interface FunctionCaptureHealth {
  /** An active function fires on row events, so capture has to be on. */
  required: boolean
  /** Every such function's table carries the capture trigger. */
  healthy: boolean
  /** Tables carrying the capture trigger right now. */
  tables: string[]
  /** The active row-event functions whose table is not captured: they will not fire. */
  uncaptured: Array<{ id: string; name: string; table: string | null }>
}

export function functionCaptureHealth(
  functions: ReadonlyArray<{ id: string; name: string; status: string; triggerType: string; triggerTable: string | null }>,
  capturedTables: readonly string[],
): FunctionCaptureHealth {
  const watching = functions.filter((f) => f.status !== 'inactive' && ROW_EVENT_FUNCTION_TRIGGERS.has(f.triggerType))
  const captured = new Set(capturedTables)
  const uncaptured = watching
    .filter((f) => !f.triggerTable || !captured.has(f.triggerTable))
    .map((f) => ({ id: f.id, name: f.name, table: f.triggerTable }))
  return { required: watching.length > 0, healthy: uncaptured.length === 0, tables: [...capturedTables], uncaptured }
}
