/**
 * STRIPE'S BUILT-IN SYNC: VERIFIED EVENTS APPLIED TO THE PROJECT'S OWN TABLES
 * ==========================================================================
 * The receiver (app/api/v1/[projectId]/webhooks/[integration]/route.ts) runs
 * this for every verified Stripe event, before any on_webhook function.
 *
 * It used to write column names Backenly's own tables do not have:
 * `updated_at` and `cancel_at_period_end` on a `subscriptions` table made by
 * create_table (which has "updatedAt" and neither of those), `message` and
 * `created_at` on `notifications` (which has `body` and "createdAt"), and
 * `"stripeSessionId"` on the blueprint's `orders` (which has
 * `stripe_session_id`). It wrote values their CHECKs refuse: `inactive` and
 * Stripe's `canceled` where create_table allows `cancelled`, and `paid` in an
 * `orders.status` whose values are fulfilment states. Every statement failed
 * into a `.catch(() => {})`, Stripe got a 200, and a cancelled customer stayed
 * `active`.
 *
 * Now each write is built from the table as it is: the catalog says which
 * columns exist, their types (every value is cast to its column's type) and
 * the values a CHECK or an enum allows, so the row is matched by whichever
 * link column the table has and a status is written in the spelling the
 * column takes. What cannot be applied (a table that exists but has no column
 * to match the row by or to hold the value, a value the column refuses, a
 * write the database refuses) is reported, never swallowed:
 *
 *   - in the project's logs (Monitoring → Logs), with names, ids and SQLSTATE
 *     codes only, since that row is kept at home even for a project in another
 *     region (lib/data-plane/regional-bodies.ts);
 *   - in `payment_events`, when it exists: `processed` says whether the event
 *     was applied in full, and `error` what was not and why;
 *   - in the reply Stripe shows for the event.
 *
 * A table that does not exist is passed over: the project simply does not keep
 * that record.
 *
 * Stripe moved fields in API version 2025-03-31.basil: a subscription's
 * current period is on its items, and an invoice's subscription is under
 * `parent.subscription_details`. Both shapes are read, so an endpoint on either
 * side of that version works.
 *
 * Every statement runs with the service-role claims: workspace tables carry
 * FORCE ROW LEVEL SECURITY, and these are Backenly's own writes.
 */

import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { createLog } from '@/lib/services/logging'

// ── What the sync reports ───────────────────────────────────────────────────

/** Something the sync could not apply. */
export interface SyncProblem {
  /** The table it was for. */
  table: string
  /**
   * Why, in names, Stripe's own words and SQLSTATE codes only: this is what
   * the project's logs keep, which stay at home whatever the project's region.
   */
  why: string
  /** The rest: the values a column allows, or the database's own words. Kept in the region and sent to Stripe. */
  detail?: string
}

export interface SyncOutcome {
  eventId: string | null
  eventType: string
  /** The event id was already in payment_events, so nothing was applied again. */
  duplicate: boolean
  /** Whether the event has a row in payment_events (which then records this outcome). */
  recorded: boolean
  /** What landed. */
  applied: string[]
  /** What had nothing to apply to: no such table, no matching row. */
  notes: string[]
  /** What could not be applied. Empty when the event was applied in full. */
  problems: SyncProblem[]
}

/** The tables the sync reads and writes. */
const TABLES = [
  'payment_events',
  'orders',
  'payments',
  'subscriptions',
  'notifications',
  'credit_wallets',
  'credit_transactions',
  'products',
  'order_items',
]

/** Columns that may hold the row's updated-at time: create_table's, then the snake_case spelling. */
const UPDATED_AT = ['updatedAt', 'updated_at']
const CREATED_AT = ['createdAt', 'created_at']

// ── Stripe's payloads, before and after 2025-03-31.basil ────────────────────

/**
 * A subscription's current period, in ISO time. From 2025-03-31.basil it is on
 * each subscription item (items.data[].current_period_*), and the top-level
 * fields are gone; before, it was on the subscription. The latest end and the
 * earliest start across items cover every item's period.
 */
export function subscriptionPeriod(sub: any): { start: string | null; end: string | null } {
  const items: any[] = Array.isArray(sub?.items?.data) ? sub.items.data : []
  const starts = items.map((i) => i?.current_period_start).filter(isSeconds)
  const ends = items.map((i) => i?.current_period_end).filter(isSeconds)
  const start = isSeconds(sub?.current_period_start) ? sub.current_period_start : starts.length ? Math.min(...starts) : null
  const end = isSeconds(sub?.current_period_end) ? sub.current_period_end : ends.length ? Math.max(...ends) : null
  return { start: start === null ? null : isoFromSeconds(start), end: end === null ? null : isoFromSeconds(end) }
}

/**
 * The subscription an invoice is for, or null. From 2025-03-31.basil it is
 * parent.subscription_details.subscription (an id, or an object when
 * expanded), and the top-level `subscription` is gone; before, it was
 * top-level.
 */
export function invoiceSubscriptionId(invoice: any): string | null {
  const from = (v: unknown): string | null =>
    typeof v === 'string' && v ? v : v && typeof (v as any).id === 'string' ? (v as any).id : null
  return from(invoice?.parent?.subscription_details?.subscription) ?? from(invoice?.subscription)
}

function isSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

/**
 * The status words to try for a Stripe subscription status, most faithful
 * first. Stripe spells it `canceled`; create_table's CHECK, and Backenly's own
 * code, spell it `cancelled`.
 */
export function statusCandidates(stripeStatus: string): string[] {
  const s = String(stripeStatus || '').trim()
  if (!s) return []
  if (s === 'canceled') return ['canceled', 'cancelled']
  if (s === 'cancelled') return ['cancelled', 'canceled']
  return [s]
}

// ── The tables as they are ──────────────────────────────────────────────────

export interface ColumnInfo {
  name: string
  /** The type as format_type renders it: every value is cast to it. */
  type: string
  /** The values the column's CHECK or enum allows, or null when nothing lists them. */
  allowed: string[] | null
}

export type TableInfo = Map<string, ColumnInfo>
export type Catalog = Map<string, TableInfo>

/**
 * The values a single-column CHECK lists, or null when it is not a plain list.
 * PostgreSQL renders `status IN ('a', 'b')` as
 *   CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))
 * and, on a varchar column,
 *   CHECK (((status)::text = ANY ((ARRAY['a'::character varying, ...])::text[])))
 * Only those shapes (each optionally `OR status IS NULL`) are read: a CHECK
 * such as `status <> 'deleted'` also names values, which are not what it allows.
 */
export function checkListValues(definition: string, column: string): string[] | null {
  const col = `(?:"${escapeRegExp(column.replace(/"/g, '""'))}"|${escapeRegExp(column)})`
  const literals = `((?:'(?:[^']|'')*'::[a-z ]+(?:\\([0-9]+\\))?(?:, )?)+)`
  const list =
    `(?:${col}|\\(${col}\\)::text) = ANY ` +
    `\\((?:ARRAY\\[${literals}\\]|\\(ARRAY\\[${literals}\\]\\)::text\\[\\])\\)`
  const shapes = [
    new RegExp(`^CHECK \\(\\(${list}\\)\\)$`),
    new RegExp(`^CHECK \\(\\(\\(${list}\\) OR \\(${col} IS NULL\\)\\)\\)$`),
  ]
  for (const shape of shapes) {
    const m = definition.match(shape)
    if (!m) continue
    const values: string[] = []
    const literal = /'((?:[^']|'')*)'::/g
    let lm: RegExpExecArray | null
    while ((lm = literal.exec(m[1] ?? m[2]))) values.push(lm[1].replace(/''/g, "'"))
    return values
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The first candidate the column takes, or null. A column nothing constrains takes the first. */
export function chooseValue(column: Pick<ColumnInfo, 'allowed'>, candidates: string[]): string | null {
  if (candidates.length === 0) return null
  if (!column.allowed) return candidates[0]
  return candidates.find((c) => column.allowed!.includes(c)) ?? null
}

type Run = <T = any>(sql: string, ...values: unknown[]) => Promise<T[]>

async function readCatalog(run: Run, schema: string): Promise<Catalog> {
  const columns = await run<{ table: string; column: string; type: string; enumValues: string[] | null }>(
    `SELECT c.relname AS "table", a.attname AS "column",
            format_type(a.atttypid, a.atttypmod) AS "type",
            CASE WHEN t.typtype = 'e'
                 THEN ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder)
            END AS "enumValues"
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped`,
    schema,
    TABLES,
  )
  const checks = await run<{ table: string; column: string; definition: string }>(
    `SELECT c.relname AS "table", a.attname AS "column", pg_get_constraintdef(k.oid) AS "definition"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'c' AND n.nspname = $1 AND c.relname = ANY($2::text[])
        AND array_length(k.conkey, 1) = 1`,
    schema,
    TABLES,
  )

  const catalog: Catalog = new Map()
  for (const row of columns) {
    if (!catalog.has(row.table)) catalog.set(row.table, new Map())
    const allowed = Array.isArray(row.enumValues) ? row.enumValues : null
    catalog.get(row.table)!.set(row.column, { name: row.column, type: row.type, allowed })
  }
  for (const row of checks) {
    const column = catalog.get(row.table)?.get(row.column)
    if (!column) continue
    const values = checkListValues(row.definition, row.column)
    // Two lists on one column: a value must be in both.
    if (values) column.allowed = column.allowed ? column.allowed.filter((v) => values.includes(v)) : values
  }
  return catalog
}

// ── Writes built from the table as it is ────────────────────────────────────

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

/** One value to write: into the first of `columns` the table has (or every one, with `every`). */
interface SetSpec {
  columns: string[]
  /** A value, cast to the column's type. */
  value?: unknown
  /** Values to choose from, most faithful first: the first one the column allows. */
  candidates?: string[]
  /** What the candidates mean, for a report: "Stripe's status canceled". */
  meaning?: string
  /** A SQL expression instead of a value. */
  sql?: 'now()'
  /** Add to the column's current value. */
  increment?: number
  /** Write every one of `columns` the table has, not just the first. */
  every?: boolean
  /** The write is incomplete without it, so its absence is a problem. */
  required?: boolean
}

interface MatchSpec {
  /** Columns that may identify the row, any of which may match. */
  columns: string[]
  value: string
  /** What the value is, for a note: "Stripe subscription". */
  label: string
  /** When the table has none of these columns: a problem (the table is the event's own), or a note. */
  unlinked: 'problem' | 'note'
}

class Sync {
  readonly outcome: SyncOutcome

  constructor(
    readonly schema: string,
    private readonly catalog: Catalog,
    private readonly run: Run,
    eventId: string | null,
    eventType: string,
  ) {
    this.outcome = { eventId, eventType, duplicate: false, recorded: false, applied: [], notes: [], problems: [] }
  }

  table(name: string): TableInfo | null {
    return this.catalog.get(name) ?? null
  }

  has(table: string, column: string): boolean {
    return this.table(table)?.has(column) ?? false
  }

  note(text: string) {
    this.outcome.notes.push(text)
  }

  problem(table: string, why: string, detail?: string) {
    this.outcome.problems.push(detail ? { table, why, detail } : { table, why })
  }

  /** Run a statement; a failure becomes a problem, and null. */
  async exec<T = any>(table: string, doing: string, sql: string, values: unknown[]): Promise<T[] | null> {
    try {
      return await this.run<T>(sql, ...values)
    } catch (err) {
      const { code, message } = databaseError(err)
      this.problem(table, `${doing} failed${code ? ` (SQLSTATE ${code})` : ''}`, message)
      return null
    }
  }

  /**
   * Resolve the SET list against the table. A required value with no column
   * to hold it, or no value its column allows, is a problem; the rest of the
   * row is still written.
   */
  private resolveSets(table: string, info: TableInfo, sets: SetSpec[], params: unknown[]): string[] {
    const clauses: string[] = []
    for (const set of sets) {
      const present = set.columns.filter((c) => info.has(c))
      if (present.length === 0) {
        if (set.required) this.problem(table, `\`${table}\` has no ${orList(set.columns)} column`)
        continue
      }
      if (set.candidates) {
        // The first present column that takes one of the candidates.
        let placed = false
        for (const name of present) {
          const column = info.get(name)!
          const value = chooseValue(column, set.candidates)
          if (value === null) continue
          params.push(value)
          clauses.push(`${ident(name)} = $${params.length}::${column.type}`)
          placed = true
          break
        }
        if (!placed && set.required) {
          const lists = present
            .map((name) => `${name} allows ${(info.get(name)!.allowed ?? []).join(', ')}`)
            .join('; ')
          this.problem(table, `no column of \`${table}\` takes ${set.meaning ?? orList(set.candidates)}`, lists)
        }
        continue
      }
      for (const name of set.every ? present : present.slice(0, 1)) {
        const column = info.get(name)!
        if (set.sql) {
          clauses.push(`${ident(name)} = ${set.sql}`)
        } else if (set.increment !== undefined) {
          params.push(set.increment)
          clauses.push(`${ident(name)} = COALESCE(${ident(name)}, 0) + $${params.length}::${column.type}`)
        } else {
          params.push(set.value)
          clauses.push(`${ident(name)} = $${params.length}::${column.type}`)
        }
      }
    }
    return clauses
  }

  /**
   * UPDATE the rows the match identifies. Returns the number of rows updated,
   * or null when nothing could be run.
   */
  async update(
    table: string,
    match: MatchSpec,
    sets: SetSpec[],
    only?: { column: string; candidates: string[] },
  ): Promise<number | null> {
    const info = this.table(table)
    if (!info) {
      // The event's own table is worth a word; an optional one is not.
      if (match.unlinked === 'problem') this.note(`no \`${table}\` table`)
      return null
    }
    const links = match.columns.filter((c) => info.has(c))
    if (links.length === 0) {
      const why = `\`${table}\` has no ${orList(match.columns)} column to find the row for the ${match.label} by`
      if (match.unlinked === 'problem') this.problem(table, why)
      else this.note(why)
      return null
    }

    const params: unknown[] = []
    const clauses = this.resolveSets(table, info, sets, params)
    // The updated-at stamp alone is not a change worth making.
    const meaningful = clauses.filter((c) => !UPDATED_AT.some((u) => c.startsWith(`${ident(u)} =`)))
    if (meaningful.length === 0) return null

    params.push(match.value)
    const at = params.length
    const where = [`(${links.map((c) => `${ident(c)} = $${at}::${info.get(c)!.type}`).join(' OR ')})`]
    if (only) {
      const column = info.get(only.column)
      const value = column ? chooseValue(column, only.candidates) : null
      if (!column || value === null) {
        this.note(`no \`${table}\` row can be ${only.candidates.join(' or ')}`)
        return null
      }
      params.push(value)
      where.push(`${ident(only.column)} = $${params.length}::${column.type}`)
    }

    const rows = await this.exec(
      table,
      `the update of \`${table}\``,
      `UPDATE ${ident(this.schema)}.${ident(table)} SET ${clauses.join(', ')} WHERE ${where.join(' AND ')} RETURNING 1 AS updated`,
      params,
    )
    if (rows === null) return null
    const written = clauses.map((c) => c.slice(0, c.indexOf(' =')).replace(/"/g, ''))
    if (rows.length === 0) {
      this.note(`no \`${table}\` row has ${links.join(' or ')} = ${match.value}${only ? ` and ${only.column} ${only.candidates.join(' or ')}` : ''}`)
    } else {
      this.outcome.applied.push(`\`${table}\`: ${rows.length} row${rows.length === 1 ? '' : 's'} updated (${written.join(', ')})`)
    }
    return rows.length
  }

  /** INSERT one row. Returns whether it was added. */
  async insert(table: string, values: SetSpec[], unfit: 'problem' | 'note'): Promise<boolean> {
    const info = this.table(table)
    if (!info) {
      this.note(`no \`${table}\` table`)
      return false
    }
    const missing = values.filter((v) => v.required && !v.columns.some((c) => info.has(c)))
    if (missing.length > 0) {
      const why = `\`${table}\` has no ${missing.map((m) => orList(m.columns)).join(' or ')} column`
      if (unfit === 'problem') this.problem(table, why)
      else this.note(why)
      return false
    }
    const names: string[] = []
    const exprs: string[] = []
    const params: unknown[] = []
    for (const v of values) {
      const present = v.columns.filter((c) => info.has(c))
      for (const name of v.every ? present : present.slice(0, 1)) {
        names.push(ident(name))
        if (v.sql) {
          exprs.push(v.sql)
        } else {
          params.push(v.value)
          exprs.push(`$${params.length}::${info.get(name)!.type}`)
        }
      }
    }
    const rows = await this.exec(
      table,
      `adding a row to \`${table}\``,
      `INSERT INTO ${ident(this.schema)}.${ident(table)} (${names.join(', ')}) VALUES (${exprs.join(', ')}) ON CONFLICT DO NOTHING RETURNING 1 AS added`,
      params,
    )
    if (rows === null) return false
    if (rows.length > 0) this.outcome.applied.push(`\`${table}\`: 1 row added`)
    return rows.length > 0
  }

  /** The user (and id) of the row a match identifies, for a notification. */
  async rowOf(table: string, match: MatchSpec): Promise<{ userId: string | null; id: string | null }> {
    const info = this.table(table)
    const none = { userId: null, id: null }
    if (!info || !info.has('user_id')) return none
    const links = match.columns.filter((c) => info.has(c))
    if (links.length === 0) return none
    const rows = await this.exec<{ user_id: string | null; id: string | null }>(
      table,
      `reading the user of the \`${table}\` row`,
      `SELECT user_id::text AS user_id, ${info.has('id') ? 'id::text' : 'NULL::text'} AS id FROM ${ident(this.schema)}.${ident(table)}
        WHERE ${links.map((c) => `${ident(c)} = $1::${info.get(c)!.type}`).join(' OR ')} LIMIT 1`,
      [match.value],
    )
    return { userId: rows?.[0]?.user_id ?? null, id: rows?.[0]?.id ?? null }
  }

  /** Tell a user something, in `notifications` as the table is. */
  async notify(userId: string | null, type: string, title: string, text: string) {
    if (!this.table('notifications')) return
    if (!userId) {
      this.note('no user to notify')
      return
    }
    await this.insert(
      'notifications',
      [
        { columns: ['user_id'], value: userId, required: true },
        { columns: ['body', 'message'], value: text, every: true, required: true },
        { columns: ['title'], value: title },
        { columns: ['type'], value: type },
        { columns: CREATED_AT, sql: 'now()', every: true },
      ],
      'problem',
    )
  }
}

function orList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** A database error's SQLSTATE and its own words, from a Prisma raw-query error. */
export function databaseError(err: unknown): { code: string | null; message: string } {
  const e = err as any
  const text = String(e?.message ?? e ?? '')
  const meta = e?.meta ?? {}
  // A SQLSTATE is five digits or capitals; Prisma's own codes (P1000-P6999)
  // look like one and are not, while PL/pgSQL's P0001-P0004 are.
  const sqlstate = (v: unknown): string | null =>
    typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v) && !/^P[1-9][0-9]{3}$/.test(v) ? v : null
  const code = sqlstate(meta.code) ?? sqlstate(e?.code) ?? sqlstate(text.match(/Code: `([0-9A-Z]{5})`/)?.[1]) ?? null
  const message =
    (typeof meta.message === 'string' && meta.message) ||
    text.match(/Message: `([\s\S]*?)`(?:\s|$)/)?.[1] ||
    text.trim().split('\n').pop() ||
    'unknown error'
  return { code, message: message.trim() }
}

// ── The events ──────────────────────────────────────────────────────────────

const PAID = ['paid']
const PAYMENT_STATE = ['payment_status', 'status']
const SESSION = ['stripe_session_id', 'stripeSessionId']
const SUBSCRIPTION = ['stripe_subscription_id', 'provider_subscription_id']
const STAMP: SetSpec = { columns: UPDATED_AT, sql: 'now()', every: true }

async function checkoutSessionCompleted(sync: Sync, session: any) {
  const sessionId: string | undefined = session?.id
  if (!sessionId) return
  const paymentIntent: string | null = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null
  const sets: SetSpec[] = [
    { columns: PAYMENT_STATE, candidates: PAID, meaning: 'paid', required: true },
    ...(paymentIntent ? [{ columns: ['stripe_payment_intent_id'], value: paymentIntent }] : []),
    STAMP,
  ]
  // A one-time payment is an order's to record; a subscription's or a setup's
  // Checkout need not have one, so there an orders table without the session
  // column is only noted.
  const oneTime = !session.mode || session.mode === 'payment'
  await sync.update('orders', { columns: SESSION, value: sessionId, label: 'checkout session', unlinked: oneTime ? 'problem' : 'note' }, sets)
  await sync.update('payments', { columns: SESSION, value: sessionId, label: 'checkout session', unlinked: 'note' }, sets)
}

async function paymentIntentSucceeded(sync: Sync, intent: any) {
  const paymentIntentId: string | undefined = intent?.id
  if (!paymentIntentId) return
  const amountReceived: number = intent.amount_received ?? intent.amount ?? 0
  const currency: string = intent.currency ?? 'usd'
  const metadata: Record<string, string> = intent.metadata ?? {}
  const paid: SetSpec[] = [{ columns: PAYMENT_STATE, candidates: PAID, meaning: 'paid', required: true }, STAMP]

  // An order or payment carries the payment intent when the app stamped it;
  // a Checkout order is matched by its session instead, so neither is required.
  const orders = await sync.update(
    'orders',
    { columns: ['stripe_payment_intent_id'], value: paymentIntentId, label: 'payment intent', unlinked: 'note' },
    paid,
  )
  await sync.update(
    'payments',
    { columns: ['stripe_payment_intent_id', 'provider_payment_id'], value: paymentIntentId, label: 'payment intent', unlinked: 'note' },
    paid,
  )

  // A credit purchase: metadata.credits_amount for metadata.user_id, into a
  // wallet's balance, or else as a ledger row.
  const credits = metadata.credits_amount ? parseInt(metadata.credits_amount, 10) : 0
  const userId = metadata.user_id ?? metadata.userId ?? null
  if (credits > 0 && userId) {
    const wallet = sync.table('credit_wallets')
      ? await sync.update(
          'credit_wallets',
          { columns: ['user_id'], value: userId, label: 'user', unlinked: 'problem' },
          [{ columns: ['balance'], increment: credits, required: true }, STAMP],
        )
      : null
    if (!wallet) {
      await sync.insert(
        'credit_transactions',
        [
          { columns: ['user_id'], value: userId, required: true },
          { columns: ['amount'], value: credits, required: true },
          // `reason` before; create_table's credit_transactions names it `type`.
          { columns: ['reason', 'type'], value: 'purchase' },
          { columns: ['stripe_payment_intent_id'], value: paymentIntentId },
          { columns: CREATED_AT, sql: 'now()', every: true },
        ],
        'problem',
      )
    }
  }

  if (!orders) return

  // The paid order's items come off stock, never below zero.
  const stock = [
    ['products', 'id'],
    ['products', 'stock_quantity'],
    ['order_items', 'order_id'],
    ['order_items', 'product_id'],
    ['order_items', 'quantity'],
    ['orders', 'id'],
  ]
  if (stock.every(([t, c]) => sync.has(t, c))) {
    const schema = sync.schema
    const intentType = sync.table('orders')!.get('stripe_payment_intent_id')!.type
    const stamp = UPDATED_AT.filter((c) => sync.has('products', c)).map((c) => `, ${ident(c)} = now()`).join('')
    const rows = await sync.exec(
      'products',
      'taking the order’s items off `products` stock',
      `UPDATE ${ident(schema)}."products" p
          SET stock_quantity = GREATEST(0, p.stock_quantity - oi.quantity)${stamp}
         FROM ${ident(schema)}."order_items" oi
         JOIN ${ident(schema)}."orders" o ON oi.order_id = o.id
        WHERE p.id = oi.product_id
          AND o.stripe_payment_intent_id = $1::${intentType}
        RETURNING 1 AS updated`,
      [paymentIntentId],
    )
    if (rows && rows.length > 0) sync.outcome.applied.push(`\`products\`: stock taken off ${rows.length} row${rows.length === 1 ? '' : 's'}`)
  }

  const order = await sync.rowOf('orders', { columns: ['stripe_payment_intent_id'], value: paymentIntentId, label: 'payment intent', unlinked: 'note' })
  await sync.notify(
    order.userId,
    'payment_succeeded',
    'Payment Confirmed',
    `Your payment of ${(amountReceived / 100).toFixed(2)} ${currency.toUpperCase()} was successful. Order ${order.id ?? paymentIntentId} is confirmed.`,
  )
}

function subscriptionSets(sub: any, statuses: string[]): SetSpec[] {
  const period = subscriptionPeriod(sub)
  const sets: SetSpec[] = [{ columns: ['status'], candidates: statuses, meaning: `Stripe's status ${statuses[0]}`, required: true }]
  if (period.start) sets.push({ columns: ['current_period_start'], value: period.start })
  if (period.end) sets.push({ columns: ['current_period_end'], value: period.end })
  if (typeof sub?.cancel_at_period_end === 'boolean') sets.push({ columns: ['cancel_at_period_end'], value: sub.cancel_at_period_end })
  sets.push(STAMP)
  return sets
}

async function subscriptionUpdated(sync: Sync, sub: any) {
  if (!sub?.id) return
  const statuses = statusCandidates(sub.status)
  if (statuses.length === 0) return
  await sync.update('subscriptions', { columns: SUBSCRIPTION, value: sub.id, label: 'Stripe subscription', unlinked: 'problem' }, subscriptionSets(sub, statuses))
}

async function subscriptionDeleted(sync: Sync, sub: any) {
  if (!sub?.id) return
  // Stripe's own status for an ended subscription, as the column spells it,
  // and `inactive` (what this sync wrote before) for a table that lists that.
  const statuses = [...statusCandidates(sub.status || 'canceled'), ...statusCandidates('canceled'), 'inactive'].filter(
    (s, i, all) => all.indexOf(s) === i,
  )
  const match: MatchSpec = { columns: SUBSCRIPTION, value: sub.id, label: 'Stripe subscription', unlinked: 'problem' }
  const updated = await sync.update('subscriptions', match, subscriptionSets(sub, statuses))
  if (!updated) return
  // It used to add "You have been downgraded to the free tier": the sync
  // changes no plan, and an app may have none.
  await sync.notify(
    (await sync.rowOf('subscriptions', match)).userId,
    'subscription_canceled',
    'Subscription Canceled',
    'Your subscription has been canceled.',
  )
}

async function invoicePaymentFailed(sync: Sync, invoice: any) {
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId) {
    sync.note('the invoice is not for a subscription')
    return
  }
  const match: MatchSpec = { columns: SUBSCRIPTION, value: subscriptionId, label: 'Stripe subscription', unlinked: 'problem' }
  const updated = await sync.update('subscriptions', match, [
    { columns: ['status'], candidates: ['past_due'], meaning: 'past_due', required: true },
    STAMP,
  ])
  if (!updated) return
  await sync.notify(
    (await sync.rowOf('subscriptions', match)).userId,
    'payment_failed',
    'Payment Failed',
    'Your most recent payment failed. Please update your payment method to keep your subscription active.',
  )
}

async function invoicePaid(sync: Sync, invoice: any) {
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId) {
    sync.note('the invoice is not for a subscription')
    return
  }
  await sync.update(
    'subscriptions',
    { columns: SUBSCRIPTION, value: subscriptionId, label: 'Stripe subscription', unlinked: 'problem' },
    [{ columns: ['status'], candidates: ['active'], meaning: 'active', required: true }, STAMP],
    { column: 'status', candidates: ['past_due'] },
  )
}

const HANDLERS: Record<string, (sync: Sync, object: any) => Promise<void>> = {
  'checkout.session.completed': checkoutSessionCompleted,
  'payment_intent.succeeded': paymentIntentSucceeded,
  'customer.subscription.updated': subscriptionUpdated,
  'customer.subscription.deleted': subscriptionDeleted,
  'invoice.payment_failed': invoicePaymentFailed,
  'invoice.paid': invoicePaid,
}

/** The events the sync applies; every other verified event is only recorded. */
export const SYNCED_EVENTS = Object.keys(HANDLERS)

// ── payment_events: once per event, and what happened ───────────────────────

/**
 * Record the event before applying it, so a redelivery is not applied twice.
 * Returns false when the event is already recorded.
 */
async function claim(sync: Sync, eventId: string, eventType: string, payload: unknown): Promise<boolean> {
  const info = sync.table('payment_events')
  if (!info) return true
  if (!info.has('stripe_event_id')) {
    sync.problem('payment_events', '`payment_events` has no stripe_event_id column, so Stripe events are not recorded there')
    return true
  }
  const schema = sync.schema
  const idType = info.get('stripe_event_id')!.type
  const seen = await sync.exec(
    'payment_events',
    'reading `payment_events`',
    `SELECT 1 AS seen FROM ${ident(schema)}."payment_events" WHERE stripe_event_id = $1::${idType} LIMIT 1`,
    [eventId],
  )
  if (seen && seen.length > 0) return false

  const names = ['stripe_event_id']
  const exprs = [`$1::${idType}`]
  const params: unknown[] = [eventId]
  const add = (column: string, value: unknown) => {
    if (!info.has(column)) return
    params.push(value)
    names.push(ident(column))
    exprs.push(`$${params.length}::${info.get(column)!.type}`)
  }
  add('event_type', eventType)
  add('payload', JSON.stringify(payload))
  add('processed', false)
  const rows = await sync.exec(
    'payment_events',
    'recording the event in `payment_events`',
    `INSERT INTO ${ident(schema)}."payment_events" (${names.join(', ')}) VALUES (${exprs.join(', ')})
     ON CONFLICT DO NOTHING RETURNING 1 AS added`,
    params,
  )
  if (rows === null) return true // not recorded; applied anyway, and the problem says so
  if (rows.length === 0) return false // a concurrent delivery recorded it first
  sync.outcome.recorded = true
  return true
}

/** Write the outcome onto the event's payment_events row. */
async function settle(sync: Sync, eventId: string) {
  const info = sync.table('payment_events')
  if (!info || !sync.outcome.recorded) return
  const schema = sync.schema
  const sets: string[] = []
  const params: unknown[] = []
  const problems = sync.outcome.problems
  if (info.has('processed')) {
    params.push(problems.length === 0)
    sets.push(`processed = $${params.length}::${info.get('processed')!.type}`)
  }
  if (info.has('processed_at')) sets.push('processed_at = now()')
  if (info.has('error')) {
    params.push(problems.length === 0 ? null : problems.map(problemText).join('; '))
    sets.push(`error = $${params.length}::${info.get('error')!.type}`)
  }
  if (sets.length === 0) return
  params.push(eventId)
  await sync.exec(
    'payment_events',
    'recording the outcome in `payment_events`',
    `UPDATE ${ident(schema)}."payment_events" SET ${sets.join(', ')} WHERE stripe_event_id = $${params.length}::${info.get('stripe_event_id')!.type}`,
    params,
  )
}

/** A problem with its detail: for the project's own region and for Stripe. */
export function problemText(p: SyncProblem): string {
  return p.detail ? `${p.why}: ${p.detail}` : p.why
}

/**
 * The line in the project's logs. Names, Stripe's words, ids and SQLSTATE
 * codes only: the row is kept at home whatever the project's region.
 */
export function logMessage(outcome: SyncOutcome): string {
  const id = outcome.eventId ? ` ${outcome.eventId}` : ''
  const where = outcome.recorded
    ? 'Its row in payment_events and the reply Stripe shows for it give the details.'
    : 'The reply Stripe shows for it gives the details.'
  return `Stripe ${outcome.eventType}${id} was not fully applied: ${outcome.problems.map((p) => p.why).join('; ')}. ${where}`
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Apply a verified Stripe event to the project's tables, record what happened,
 * and report it. Never throws for what the tables are or what the database
 * refuses; those are the outcome's problems.
 */
export async function applyStripeEvent(projectId: string, payload: Record<string, any>): Promise<SyncOutcome> {
  const eventType = String(payload?.type ?? '')
  const eventId: string | null = typeof payload?.id === 'string' && payload.id ? payload.id : null
  const object = payload?.data?.object ?? {}
  const schema = `workspace_${projectId}`
  const run: Run = (sql, ...values) => executeWithUserContext(projectId, '', true, sql, values)

  let catalog: Catalog
  try {
    catalog = await readCatalog(run, schema)
  } catch (err) {
    const { code, message } = databaseError(err)
    const sync = new Sync(schema, new Map(), run, eventId, eventType)
    sync.problem('workspace', `reading the project's tables failed${code ? ` (SQLSTATE ${code})` : ''}`, message)
    await report(projectId, sync.outcome)
    return sync.outcome
  }

  const sync = new Sync(schema, catalog, run, eventId, eventType)
  if (eventId && !(await claim(sync, eventId, eventType, payload))) {
    sync.outcome.duplicate = true
    return sync.outcome
  }

  const handler = HANDLERS[eventType]
  if (handler) await handler(sync, object)

  if (eventId) await settle(sync, eventId)
  await report(projectId, sync.outcome)
  return sync.outcome
}

/** Say what was not applied where the developer looks: the project's logs. */
async function report(projectId: string, outcome: SyncOutcome) {
  if (outcome.problems.length === 0) return
  const message = logMessage(outcome)
  console.error(`[Webhook] ${message} (project ${projectId})`)
  await createLog({
    type: 'api',
    severity: 'error',
    service: 'stripe',
    method: 'POST',
    endpoint: `/api/v1/${projectId}/webhooks/stripe`,
    projectId,
    message,
    metadata: { eventId: outcome.eventId, eventType: outcome.eventType, tables: Array.from(new Set(outcome.problems.map((p) => p.table))) },
  })
}

/** What the reply to Stripe says about the sync, shown with the event in Stripe's dashboard. */
export function syncReply(outcome: SyncOutcome) {
  const result = outcome.duplicate
    ? 'already recorded in payment_events, so not applied again'
    : outcome.problems.length > 0
      ? outcome.applied.length > 0 ? 'partly applied' : 'not applied'
      : SYNCED_EVENTS.includes(outcome.eventType) ? 'applied' : 'recorded only: the sync does not apply this event type'
  return { result, changes: outcome.applied, notApplied: outcome.problems.map(problemText), notes: outcome.notes }
}
