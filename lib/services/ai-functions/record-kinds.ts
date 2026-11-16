/**
 * Rows in a function's run log that are not runs.
 *
 * The run log (ai_function_logs) records each run, and two kinds of record
 * that are about runs without being one:
 *
 *   not_run  runs that did not happen because the month's function runs were
 *            used: row changes the queue did not take, a queue dropped at the
 *            plan's limit, a call the plan refused. Stored as unsuccessful, so
 *            the log shows them among the failures to look at.
 *   notice   a burst of row changes queued more runs than the month has left.
 *
 * Neither says anything about the function's code, so nothing that counts
 * runs or failures counts them: a function at its monthly cap was reported as
 * failing after a few drain batches (lib/autonomy/function-failures.ts), a
 * false alarm about code that never ran. Pure, so the console can read it too.
 */

export const NOT_RUN = 'not_run'
export const NOTICE = 'notice'

/** The triggerType of every record that is not a run. */
export const NOT_A_RUN: readonly string[] = [NOT_RUN, NOTICE]

/** Whether a run-log row records a run, rather than a run that did not happen or a notice. */
export function isRunRecord(triggerType: string | null | undefined): boolean {
  return !triggerType || !NOT_A_RUN.includes(triggerType)
}
