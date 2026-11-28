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

const WHOLE_NUMBER_TYPES = new Set(['int2', 'int4', 'int8'])
const TEXT_TYPES = new Set(['text', 'varchar'])

/**
 * Whether PostgreSQL can make a foreign key from a column of one type to a key
 * of another. Both are type names as the catalog gives them (pg_type.typname,
 * information_schema's udt_name): uuid, text, int4, …
 *
 * A column's name says what it points at, never whether a key can be made. An
 * agent that stores the signed-in user as text gets `user_id text`, while
 * `users.id` is a uuid, and PostgreSQL refuses that pair outright ("foreign key
 * constraint cannot be implemented … incompatible types: text and uuid").
 * Backenly offered the key anyway, and approving it answered HTTP 500
 * (production QA, 2026-11-21 and 2026-11-27).
 *
 * The same type always links. Beyond that only the pairs PostgreSQL compares
 * without a cast written out are counted: the whole numbers with each other,
 * and text with varchar. Anything else is answered no, so a key is never
 * offered that the database would refuse.
 */
export function foreignKeyTypesMatch(columnType: string, keyType: string): boolean {
  const column = columnType.toLowerCase()
  const key = keyType.toLowerCase()
  if (column === key) return true
  return (
    (WHOLE_NUMBER_TYPES.has(column) && WHOLE_NUMBER_TYPES.has(key)) ||
    (TEXT_TYPES.has(column) && TEXT_TYPES.has(key))
  )
}
