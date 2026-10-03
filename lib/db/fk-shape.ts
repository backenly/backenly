/**
 * Whether a column name is shaped like a foreign key, and what it points at.
 *
 * Extracted so the browser and the executor answer this the SAME way. The
 * executor refuses a foreign key on a column that is not FK-shaped, and it
 * refuses it after the column has already been created — so a table editor
 * that does not know the rule offers a choice the server will reject, leaving
 * a new column behind and an error that arrives too late to act on.
 *
 * Re-implementing the rule in the UI would be the drift this repository has
 * already paid for once: `docs/mcp-catalog-truth-architecture.md` records what
 * happened when "what exists" lived in four hand-synced places. One definition,
 * imported by both sides.
 *
 * Pure string handling on purpose. No database, no imports, so it is safe in a
 * client component.
 */

/**
 * The base a foreign-key column refers to, or null when the column is not
 * FK-shaped.
 *
 *   user_id   -> 'user'
 *   userId    -> 'user'     (camelCase, only when there is a real uppercase)
 *   id        -> null       (a table's own key, not a reference)
 *   email     -> null
 */
export function deriveFkBase(columnName: string): string | null {
  const lower = columnName.toLowerCase()
  if (lower === 'id') return null
  if (lower.endsWith('_id')) return lower.slice(0, -3)
  // camelCase: userId → user. Guarded on the name actually carrying an
  // uppercase, so a lowercase `userid` is not silently treated as a reference.
  if (/[a-z]id$/.test(lower) && columnName !== columnName.toLowerCase()) return lower.slice(0, -2)
  return null
}

/** Convenience predicate for the UI, so the rule is never restated inline. */
export function isForeignKeyShaped(columnName: string): boolean {
  return deriveFkBase(columnName.trim()) !== null
}

/**
 * The column name that WOULD be accepted for a reference to `table`.
 *
 * Used to suggest a fix rather than only reporting a refusal. Singularises the
 * common plural case only: this is a hint in a form, not a naming authority,
 * and the server remains the thing that decides.
 */
export function suggestForeignKeyColumn(table: string): string {
  const base = table.trim().replace(/s$/i, '')
  return `${base}_id`
}
