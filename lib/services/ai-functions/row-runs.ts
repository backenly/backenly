/**
 * What a row-event function costs, said where it is deployed and listed.
 *
 * A row function runs once for every row its event touches, as database
 * webhooks and Firestore and Hasura triggers do: one 32,000-row insert queued
 * about 32,000 runs of an on_insert function, three times what Free includes
 * in a month, and nothing had said a bulk write would (production QA re-test,
 * 2026-11-16, #40).
 */

const VERB: Record<string, string> = {
  on_db_insert: 'inserted',
  on_db_update: 'updated',
  on_db_delete: 'deleted',
}

const NOUN: Record<string, string> = {
  on_db_insert: 'insert',
  on_db_update: 'update',
  on_db_delete: 'delete',
}

/** True for the triggers that run once per row. */
export function runsPerRow(triggerType: string | null | undefined): boolean {
  return !!triggerType && triggerType in VERB
}

/**
 * "It runs once for each row inserted, so a bulk insert of 10,000 rows is
 * 10,000 runs, each counted toward the month's function runs", or '' for a
 * trigger that does not run per row.
 */
export function perRowSentence(triggerType: string | null | undefined): string {
  if (!triggerType || !runsPerRow(triggerType)) return ''
  const filtered = triggerType === 'on_db_update'
  return (
    `It runs once for each row ${VERB[triggerType]}, so a bulk ${NOUN[triggerType]} of 10,000 rows ` +
    `${filtered ? 'can be' : 'is'} 10,000 runs, each counted toward the month's function runs`
  )
}
