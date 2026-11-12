/**
 * The rules Backenly applies from a column's or a table's name when it designs
 * a table itself (lib/ai/minimal-executor.ts: deriveConstraints and
 * executeCreateTable), and the names PostgreSQL gives what they make.
 *
 * The detector that finds what these rules left on tables whose request did
 * not ask for it (lib/autonomy/guessed-constraints.ts) reads the same lists, so
 * the two cannot disagree. Every rule here has stood unchanged since
 * 2026-07-23, the first commit of this repository, and a table made under
 * them carries exactly the names and definitions computed below. A rule that
 * changes changes what the detector recognises on tables made before: keep
 * the old one beside the new.
 *
 * Pure: no database, safe anywhere.
 */

export interface StatusRule {
  /** Matched against the table's name. */
  pattern: RegExp
  column: string
  values: readonly string[]
}

/**
 * A CHECK value list per table-name pattern, for the columns named here.
 * Applied when Backenly designs a table and the request carries no CHECK for
 * the column; the first rule whose pattern matches decides, and a request
 * with a CHECK on `status` turns all of them off. It is named
 * `chk_<table>_<column>`.
 */
export const STATUS_DOMAIN_MAP: readonly StatusRule[] = [
  // Job/async processing tables
  {
    pattern: /_jobs?$|^(generation|render|video|export|import|process|encode|transcode|clip)_/,
    column: 'status',
    values: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
  },
  // Order / e-commerce tables
  {
    pattern: /^orders?$|^(order_items?|purchase)$/,
    column: 'status',
    values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
  },
  {
    pattern: /^orders?$|^payments?$|^invoices?$|^checkouts?$/,
    column: 'payment_status',
    values: ['pending', 'paid', 'failed', 'refunded', 'disputed'],
  },
  // Subscriptions
  {
    pattern: /^subscriptions?$/,
    column: 'status',
    values: ['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused'],
  },
  // User / account tables
  {
    pattern: /^users?$|^accounts?$|^members?$/,
    column: 'status',
    values: ['active', 'suspended', 'deactivated', 'pending_verification'],
  },
  // Content / CMS tables
  {
    pattern: /^(posts?|articles?|pages?)$/,
    column: 'status',
    values: ['draft', 'published', 'archived', 'scheduled'],
  },
  // Tickets / support
  {
    pattern: /^tickets?$|^support_tickets?$/,
    column: 'status',
    values: ['open', 'in_progress', 'resolved', 'closed', 'on_hold'],
  },
  // Generic tasks
  {
    pattern: /^tasks?$|^todos?$/,
    column: 'status',
    values: ['todo', 'in_progress', 'done', 'cancelled'],
  },
]

/**
 * The values Backenly's CHECK allows on this column of a table it designed,
 * or null when no rule applies: the first rule whose pattern matches the
 * table and whose column is this one, as executeCreateTable picks it.
 */
export function statusValuesFor(table: string, column: string): readonly string[] | null {
  for (const rule of STATUS_DOMAIN_MAP) {
    if (rule.column === column && rule.pattern.test(table)) return rule.values
  }
  return null
}

/**
 * Whether a column gets UNIQUE from its name alone: "email", "username" or
 * "slug" anywhere in it, in any case (deriveConstraints). So `customer_email`
 * and `notify_email` get it, and `notify_to` does not.
 */
export function uniqueByName(column: string): boolean {
  const lower = column.toLowerCase()
  return lower.includes('email') || lower.includes('username') || lower.includes('slug')
}

/** NAMEDATALEN - 1: the longest name PostgreSQL keeps, in bytes. */
const MAX_NAME_BYTES = 63

/** The longest prefix of `s` that fits in `bytes` UTF-8 bytes, never splitting a character. */
function clip(s: string, bytes: number): string {
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (used + n > bytes) break
    out += ch
    used += n
  }
  return out
}

/** A name as PostgreSQL stores it: cut to 63 bytes. */
export function storedName(name: string): string {
  return clip(name, MAX_NAME_BYTES)
}

/**
 * The name PostgreSQL gives a constraint it names itself, `<table>_<column>_<label>`
 * (makeObjectName in src/backend/commands/indexcmds.c): when that is longer
 * than 63 bytes, the longer of table and column is shortened first, one
 * character at a time. A UNIQUE written on a column is `<table>_<column>_key`.
 * When the name is taken, PostgreSQL tries `_key1`, `_key2`, … instead.
 */
export function postgresConstraintName(table: string, column: string, label: string): string {
  const overhead = 2 + Buffer.byteLength(label, 'utf8') // two underscores and the label
  const available = MAX_NAME_BYTES - overhead
  let tableBytes = Buffer.byteLength(table, 'utf8')
  let columnBytes = Buffer.byteLength(column, 'utf8')
  while (tableBytes + columnBytes > available) {
    if (tableBytes > columnBytes) tableBytes--
    else columnBytes--
  }
  return `${clip(table, tableBytes)}_${clip(column, columnBytes)}_${label}`
}

/** Whether `name` is PostgreSQL's own name for `<table>_<column>_<label>`, or one of its numbered fallbacks. */
export function isPostgresConstraintName(name: string, table: string, column: string, label: string): boolean {
  if (name === postgresConstraintName(table, column, label)) return true
  const numbered = /^(.*?)(\d+)$/.exec(name)
  return !!numbered && name === postgresConstraintName(table, column, `${label}${numbered[2]}`)
}

/** The name of the CHECK Backenly's rules put on `column`: `chk_<table>_<column>`. */
export function checkNameFor(table: string, column: string): string {
  return storedName(`chk_${table}_${column}`)
}
