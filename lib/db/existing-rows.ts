/**
 * WHEN THE ROWS ALREADY IN A TABLE REFUSE A RULE
 * ==============================================
 * A foreign key, a UNIQUE or a CHECK added to a table that has rows is checked
 * against them, and PostgreSQL refuses it when some of them break it:
 *
 *   23503  a key's value matches no row of the table it references
 *   23505  two rows share a value the rule makes unique
 *   23514  a row breaks the CHECK
 *
 * That is the data's answer, not a fault of the server: nothing was changed,
 * and whoever asked for the rule decides what happens to those rows. An
 * approval answers 409 with it rather than 500 (app/api/projects/[id]/health/approve).
 *
 * Prisma wraps PostgreSQL's sentence as "Invalid `prisma.$executeRawUnsafe()`
 * invocation: Raw query failed. Code: `23503`. Message: `…`", and that wrapper
 * reached an approval card verbatim (production QA, 2026-11-16). PostgreSQL's
 * own words name the table and the rule, so they are what a message keeps.
 */

/** The SQLSTATEs of a rule refused by rows already in the table. */
const REFUSED_BY_ROWS = new Set(['23503', '23505', '23514'])

/**
 * Failure codes an executor gives a rule that rows already in the table broke.
 * `EXISTING_ROWS_VIOLATE` and `DUPLICATE_ROWS` were already the executor's
 * words for a CHECK and a unique index; a foreign key and a validation use
 * them too.
 */
export const EXISTING_ROWS_CODES: ReadonlySet<string> = new Set(['EXISTING_ROWS_VIOLATE', 'DUPLICATE_ROWS'])

type ErrorLike = { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } }

/** PostgreSQL's SQLSTATE for an error from Prisma or node-postgres, when it has one. */
export function sqlStateOf(err: unknown): string | null {
  const e = (err ?? {}) as ErrorLike
  if (typeof e.meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.meta.code)) return e.meta.code
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code
  const text = typeof e.message === 'string' ? e.message : ''
  return /Code:\s*`?([0-9A-Z]{5})`?/.exec(text)?.[1] ?? null
}

/** PostgreSQL's own sentence, without the wrapper Prisma puts around it. */
export function postgresWords(err: unknown): string {
  const e = (err ?? {}) as ErrorLike
  if (typeof e.meta?.message === 'string' && e.meta.message.trim()) return e.meta.message.trim()
  const text = typeof e.message === 'string' ? e.message : String(err)
  const inner = /Message:\s*`([\s\S]*?)`\s*$/.exec(text.trim())?.[1]
  return (inner ?? text).replace(/^ERROR:\s*/i, '').trim()
}

/** Whether rows already in the table refused the rule this error is about. */
export function refusedByExistingRows(err: unknown): boolean {
  const state = sqlStateOf(err)
  return state !== null && REFUSED_BY_ROWS.has(state)
}
