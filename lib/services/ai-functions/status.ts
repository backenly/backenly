/**
 * The deliberate OFF states of an AI function — the only statuses that refuse
 * invocation.
 *
 * The console Power toggle and MCP set_active both write 'inactive'; 'disabled'
 * and 'deleted' are older spellings of the same decision. `status: 'error'`
 * records how the LAST run went and never gates the next one (see the longer
 * note in server/routes/dynamic.ts). Every invocation surface must use this
 * predicate: the gates drifted apart once, and the /fn/ endpoint kept serving
 * functions their owner had switched off.
 *
 * Kept in its own module so the Express router can gate without loading the
 * executor (and its worker-thread machinery) at startup.
 */
export const FUNCTION_OFF_STATUSES = ['inactive', 'disabled', 'deleted'] as const

export function isFunctionSwitchedOff(status: string | null | undefined): boolean {
  return status != null && (FUNCTION_OFF_STATUSES as readonly string[]).includes(status)
}
