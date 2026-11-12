/**
 * How a function is started, as part of a sentence: "runs when a row in orders
 * changes". Pure, so the console's finding panels can use it too.
 */
export function triggerPhrase(trigger: unknown, table: unknown): string {
  const t = typeof table === 'string' && table ? table : null
  switch (trigger) {
    case 'on_db_insert': return t ? `runs when a row is added to ${t}` : 'runs when a row is added'
    case 'on_db_update': return t ? `runs when a row in ${t} changes` : 'runs when a row changes'
    case 'on_db_delete': return t ? `runs when a row is removed from ${t}` : 'runs when a row is removed'
    case 'on_signup': return 'runs when a user signs up'
    case 'cron': return 'runs on a schedule'
    case 'http': return 'answers HTTP requests'
    default: return 'runs when it is called'
  }
}
