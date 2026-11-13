/**
 * The rules Backenly applies from a column's or a table's name when it designs
 * a table itself (lib/ai/minimal-executor.ts: deriveConstraints and
 * executeCreateTable), and the names PostgreSQL gives what they make.
 *
 * The detector that finds what these rules left on tables whose request did
 * not ask for it (lib/autonomy/guessed-constraints.ts) reads the same lists, so
 * the two cannot disagree. A table made under them carries exactly the names
 * and definitions computed below. A rule that changes changes what the
 * detector recognises on tables made before: keep the old list beside the new
 * (StatusRule.before).
 *
 * A rule fills in what a design leaves unsaid, and a design that says it
 * outranks the rule. Per column: `unique: false` (no UNIQUE from the name),
 * `notNull: false` or `nullable: true` (no NOT NULL from the name), `sqlType`
 * (this exact type, nothing from the name), and `check: false` (no CHECK from
 * the table's name), read by lib/ai/minimal-executor.ts and ruleChecksFor
 * below.
 *
 * Pure: no database, safe anywhere.
 */

export interface StatusRule {
  /** Matched against the table's name. */
  pattern: RegExp
  column: string
  /** What the CHECK allows on a table made now. */
  values: readonly string[]
  /**
   * Where a row starts when the design gives the column no default: one of
   * `values`. Stated, so that adding a value Backenly writes does not move it.
   */
  initial: string
  /**
   * The lists the rule made before, newest first. Tables made then still carry
   * them, and the detector still recognises them.
   */
  before?: ReadonlyArray<readonly string[]>
}

/**
 * A CHECK value list per table-name pattern, for the columns named here.
 * Applied when Backenly designs a table and the request carries no CHECK for
 * the column; the first rule whose pattern matches decides, and a request
 * with a CHECK on `status` turns all of them off. It is named
 * `chk_<table>_<column>`.
 *
 * A list holds every value Backenly itself writes into that column, because a
 * value it refuses is a write of Backenly's own that fails. Every list stood
 * unchanged from 2026-07-23, the first commit of this repository, until
 * 2026-11-13, when four of them gained the values on their second line; the
 * list each had until then is its `before`.
 */
export const STATUS_DOMAIN_MAP: readonly StatusRule[] = [
  // Job/async processing tables. `pending`: the job endpoints Backenly
  // generates for these tables create and retry a job as pending
  // (lib/ai/build-runtime/domain-business-logic.ts).
  {
    pattern: /_jobs?$|^(generation|render|video|export|import|process|encode|transcode|clip)_/,
    column: 'status',
    values: ['queued', 'processing', 'completed', 'failed', 'cancelled',
      'pending'],
    initial: 'queued',
    before: [['queued', 'processing', 'completed', 'failed', 'cancelled']],
  },
  // Order / e-commerce tables. `awaiting_payment`, `paid` and `failed`: POST
  // /stripe/session marks an order awaiting_payment, Backenly's Stripe wiring
  // marks it paid, and the build's Stripe handler marks it failed when the
  // payment fails.
  {
    pattern: /^orders?$|^(order_items?|purchase)$/,
    column: 'status',
    values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded',
      'awaiting_payment', 'paid', 'failed'],
    initial: 'pending',
    before: [['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']],
  },
  {
    pattern: /^orders?$|^payments?$|^invoices?$|^checkouts?$/,
    column: 'payment_status',
    values: ['pending', 'paid', 'failed', 'refunded', 'disputed'],
    initial: 'pending',
  },
  // Subscriptions. `incomplete` and `incomplete_expired`: Stripe's subscription
  // statuses, which Backenly's Stripe webhook handling writes into a
  // subscriptions table by its Stripe subscription id. Stripe's `canceled` is
  // the `cancelled` here.
  {
    pattern: /^subscriptions?$/,
    column: 'status',
    values: ['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused',
      'incomplete', 'incomplete_expired'],
    initial: 'active',
    before: [['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused']],
  },
  // User / account tables
  {
    pattern: /^users?$|^accounts?$|^members?$/,
    column: 'status',
    values: ['active', 'suspended', 'deactivated', 'pending_verification'],
    initial: 'active',
  },
  // Content / CMS tables
  {
    pattern: /^(posts?|articles?|pages?)$/,
    column: 'status',
    values: ['draft', 'published', 'archived', 'scheduled'],
    initial: 'draft',
  },
  // Tickets / support
  {
    pattern: /^tickets?$|^support_tickets?$/,
    column: 'status',
    values: ['open', 'in_progress', 'resolved', 'closed', 'on_hold'],
    initial: 'open',
  },
  // Generic tasks. `pending`: Backenly's job endpoints serve a tasks table as
  // a queue, and create and retry its rows as pending.
  {
    pattern: /^tasks?$|^todos?$/,
    column: 'status',
    values: ['todo', 'in_progress', 'done', 'cancelled',
      'pending'],
    initial: 'todo',
    before: [['todo', 'in_progress', 'done', 'cancelled']],
  },
]

/** The rule for this column of a table Backenly designs: the first whose pattern matches. */
function statusRuleFor(table: string, column: string): StatusRule | null {
  for (const rule of STATUS_DOMAIN_MAP) {
    if (rule.column === column && rule.pattern.test(table)) return rule
  }
  return null
}

/**
 * The values Backenly's CHECK allows on this column of a table it designs now,
 * or null when no rule applies: the first rule whose pattern matches the
 * table and whose column is this one, as executeCreateTable picks it.
 */
export function statusValuesFor(table: string, column: string): readonly string[] | null {
  return statusRuleFor(table, column)?.values ?? null
}

/** Every list the rule for this column has made, the current one first; empty when no rule applies. */
export function statusValueListsFor(table: string, column: string): ReadonlyArray<readonly string[]> {
  const rule = statusRuleFor(table, column)
  return rule ? [rule.values, ...(rule.before ?? [])] : []
}

/** A column of a table Backenly designs, as the CHECK rule reads it. */
export interface DesignedColumn {
  name: string
  /** `false`: the design states the column has no CHECK from the table's name. */
  check?: unknown
}

/** A CHECK the rules give a designed table: its column, what it allows, and where a row starts. */
export interface RuleCheck {
  columnName: string
  values: string[]
  initial: string
}

/**
 * The CHECKs the rules give the columns of a table Backenly designs: one per
 * rule whose pattern matches the table, for a column the design has (by name,
 * in any case), the first rule per column. None for a column whose CHECK the
 * design states (`stated`), or that it marks `check: false`: a column whose
 * values another system owns, such as Stripe's subscription statuses, which
 * Stripe adds to.
 */
export function ruleChecksFor(
  table: string,
  columns: readonly DesignedColumn[],
  stated: ReadonlySet<string> = new Set(),
): RuleCheck[] {
  const out: RuleCheck[] = []
  for (const rule of STATUS_DOMAIN_MAP) {
    if (!rule.pattern.test(table)) continue
    const column = columns.find((c) => typeof c?.name === 'string' && c.name.toLowerCase() === rule.column)
    if (!column || column.check === false) continue
    if (stated.has(rule.column) || out.some((c) => c.columnName === rule.column)) continue
    out.push({ columnName: rule.column, values: [...rule.values], initial: rule.initial })
  }
  return out
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
