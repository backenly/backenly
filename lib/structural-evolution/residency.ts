/**
 * WHAT AN EXTRACTION'S RECORDS AT HOME MAY QUOTE
 * ==============================================
 *
 * For a project kept outside the home region, the platform's rows at home (the
 * approval request, the step ledger, architecture memory, job rows) keep names,
 * kinds, counts and ids. Never the SQL that runs or a definition it carries
 * (CHECK, policy, function bodies), never a row's own value (a reconciliation's
 * sample keys, a backfill's cursor), never the database's own words, which can
 * quote rows (lib/data-plane/residency.ts). The extraction writes its words that
 * way where it writes them, from the workspace handle's `quote`
 * (./workspace.ts): the rehearsal names "a row" instead of its key, the
 * reconciliation keeps its counts without sample keys, and a failure is the
 * platform's sentence instead of the database's. Nothing downstream has to know.
 *
 * The SQL is not lost. It is rendered from the plan, whose version consent
 * binds to, and a person who asks to see it is shown it rendered from the
 * project's own tables, in its region (lib/evolution-engine/engine.ts
 * liveStatements); it is never stored outside that region.
 */

import { quotedError } from '@/lib/data-plane/residency'

/** The database's words about a failure, as a record at home may keep them. */
export function dbWords(err: unknown, quote: boolean): string {
  return quotedError(err instanceof Error ? err.message : String(err), quote)
}

/** A row of `table` in a sentence a record at home may keep: by its key, or as "a row of" it where keys stay in the region. */
export function rowOf(table: string, key: string, quote: boolean): string {
  return quote ? `${table} row ${key}` : `a row of ${table}`
}

/** Up to three keys in parentheses, after a count, where a record may quote them; nothing otherwise. */
export function someKeys(keys: string[], quote: boolean): string {
  return quote && keys.length > 0 ? ` (${keys.slice(0, 3).join(', ')})` : ''
}

/** A step's statements as a record at home may keep them: all of them, or none. */
export function keptStatements(sql: string[], quote: boolean): string[] {
  return quote ? sql : []
}
