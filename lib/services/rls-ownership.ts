/**
 * RLS OWNERSHIP INFERENCE
 * =======================
 * One answer to the question every RLS path needs and each used to answer for
 * itself: **who owns a row in this table?**
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Auto-RLS used to fire on exactly one signal: a column literally named
 * `user_id` (or a short list of synonyms). Everything else was left with RLS
 * disabled, and the auto-fix for the resulting `missing_rls` finding hardcoded
 * `template: 'own_rows', userIdColumn: 'user_id'` — so on a table that does not
 * have that column the repair failed with a raw Postgres error
 * (`column "user_id" does not exist`) and escalated to a human.
 *
 * That is not a rare edge. In any real schema the tables holding the most
 * sensitive rows are owned INDIRECTLY:
 *
 *     users ← orders(user_id) ← order_items(order_id)
 *     users ← orders(user_id) ← shipping_addresses(order_id)
 *     users ← accounts(user_id) ← saved_cards(account_id)
 *
 * `order_items` has no `user_id`, so the heuristic skipped it and every line
 * item — what each customer bought, for how much — was readable by any API key.
 * The heuristic failed exactly where the schema needed it most.
 *
 * ── The rules, in priority order ─────────────────────────────────────────────
 *
 *  1. FK to the end-user table         → own_rows on that column.
 *     A `customer_id uuid REFERENCES users(id)` IS direct ownership. Naming is
 *     a convention; a foreign key is a declaration. The key wins.
 *  2. Name-matched ownership column    → own_rows on that column.
 *     Covers schemas that never declared the FK.
 *  3. Single FK to a table that itself resolves by (1) or (2)
 *                                      → related_rows through that parent.
 *     This is the case that was silently unprotected.
 *  4. Reference/catalog table          → public_read.
 *     World-readable is CORRECT for a product catalog. But "RLS disabled" is
 *     not the same thing as "publicly readable": it also leaves INSERT/UPDATE/
 *     DELETE open to any key. public_read is what the user actually meant —
 *     reads open, writes service-role only.
 *  5. Anything else                    → undecidable.
 *     Reported honestly with the candidates that were checked, so a human or an
 *     agent decides. We do NOT enable RLS with no policy: that turns a data
 *     exposure into an outage (the table reads empty), which is a worse bug
 *     than the one being fixed.
 *
 * Depth is capped at ONE hop on purpose. Two hops produces policies whose cost
 * and semantics are hard to predict, and an ambiguous inference installed
 * silently is worse than an honest "I could not tell".
 */

import { prisma } from '@/lib/db'

/** The end-user identity table in every workspace schema. */
const END_USER_TABLE = 'users'

/**
 * Column names that mean "this row belongs to a user" when no foreign key
 * declares it. Order matters — the first match wins, so canonical names come
 * before domain-specific ones.
 */
export const OWNERSHIP_COLUMN_CANDIDATES = [
  'user_id', 'userId',
  'author_id', 'authorId',
  'owner_id', 'ownerId',
  'created_by', 'createdBy',
  'creator_id', 'creatorId',
  'sender_id', 'senderId',
  'from_user_id', 'fromUserId',
  'actor_id', 'actorId',
  'posted_by', 'postedBy',
  'by_user_id', 'byUserId',
  'customer_id', 'customerId',
  'account_id', 'accountId',
  'member_id', 'memberId',
  'profile_id', 'profileId',
]

/**
 * Tables that are reference data by nature: every user is supposed to read
 * them, nobody is supposed to write them from a client. Matched on the whole
 * name or a leading/trailing segment (`product_categories`, `app_settings`).
 *
 * This list decides SEVERITY and the default TEMPLATE, never whether the table
 * is checked at all — a catalog with RLS off still has unrestricted writes and
 * is still a finding, just not a critical data-exposure one.
 */
const REFERENCE_TABLE_PATTERNS = [
  'settings', 'config', 'configs', 'plans', 'products', 'product',
  'categories', 'category', 'tags', 'tag', 'countries', 'country',
  'currencies', 'currency', 'languages', 'language', 'locales',
  'timezones', 'brands', 'collections', 'catalog', 'catalogs',
  'faqs', 'features', 'pages', 'posts_categories', 'shipping_zones',
  'tax_rates', 'coupons', 'promotions', 'banners', 'announcements',
]

export type InferredTemplate = 'own_rows' | 'related_rows' | 'public_read'

export interface RelatedRowsVia {
  /** Column on THIS table holding the parent reference (e.g. `order_id`). */
  localColumn: string
  /** Parent table in the same workspace schema (e.g. `orders`). */
  parentTable: string
  /** Column on the parent the local column points at (almost always `id`). */
  parentColumn: string
  /** The parent's own ownership column (e.g. `user_id`). */
  parentOwnerColumn: string
}

/**
 * `kind` is the discriminant, not `template`.
 *
 * This project compiles with `strict: false`, so `null` is assignable to every
 * type and a `template: null` member cannot narrow a union — every branch would
 * still see the undecidable case and `plan.userIdColumn` would not typecheck.
 * A string discriminant narrows regardless of strictness.
 */
export type RlsPlan =
  | {
      kind: 'own_rows'
      template: 'own_rows'
      userIdColumn: string
      basis: 'foreign_key' | 'column_name'
      reason: string
    }
  | {
      kind: 'related_rows'
      template: 'related_rows'
      via: RelatedRowsVia
      basis: 'fk_chain'
      reason: string
    }
  | {
      kind: 'public_read'
      template: 'public_read'
      basis: 'reference_table'
      reason: string
    }
  | {
      kind: 'undecidable'
      template: null
      basis: 'undecidable'
      reason: string
      /** Tables this one references — the hints a human needs to decide. */
      relatedTables: string[]
    }

// ── Catalog ───────────────────────────────────────────────────────────────────

interface ForeignKey {
  childTable: string
  childColumn: string
  parentTable: string
  parentColumn: string
}

export interface OwnershipCatalog {
  schemaName: string
  /** table → its column names (as stored, case preserved). */
  columns: Map<string, string[]>
  /** Every single-column foreign key in the schema. */
  foreignKeys: ForeignKey[]
}

/**
 * Read the whole schema's columns + foreign keys in two queries.
 *
 * Batched deliberately: the missing-RLS detector inspects every table on every
 * autonomy tick, and per-table introspection would multiply that by the table
 * count for information that is identical across the loop.
 */
export async function loadOwnershipCatalog(projectId: string): Promise<OwnershipCatalog> {
  const schemaName = `workspace_${projectId}`

  const columnRows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    schemaName,
  ).catch(() => [])

  const columns = new Map<string, string[]>()
  for (const r of columnRows) {
    const list = columns.get(r.table_name)
    if (list) list.push(r.column_name)
    else columns.set(r.table_name, [r.column_name])
  }

  // Single-column foreign keys only. A composite FK cannot be expressed as a
  // one-column ownership hop, and guessing which part carries ownership is the
  // kind of silent inference this module exists to avoid.
  const fkRows = await prisma.$queryRawUnsafe<Array<{
    child_table: string
    child_column: string
    parent_table: string
    parent_column: string
  }>>(
    `SELECT ch.relname  AS child_table,
            ca.attname  AS child_column,
            pr.relname  AS parent_table,
            pa.attname  AS parent_column
       FROM pg_constraint con
       JOIN pg_class     ch ON ch.oid = con.conrelid
       JOIN pg_class     pr ON pr.oid = con.confrelid
       JOIN pg_namespace n  ON n.oid  = ch.relnamespace
       JOIN pg_attribute ca ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
      WHERE con.contype = 'f'
        AND n.nspname = $1
        AND array_length(con.conkey, 1) = 1`,
    schemaName,
  ).catch(() => [])

  return {
    schemaName,
    columns,
    foreignKeys: fkRows.map((r) => ({
      childTable: r.child_table,
      childColumn: r.child_column,
      parentTable: r.parent_table,
      parentColumn: r.parent_column,
    })),
  }
}

// ── Inference ─────────────────────────────────────────────────────────────────

function isReferenceTable(tableName: string): boolean {
  const n = tableName.toLowerCase()
  return REFERENCE_TABLE_PATTERNS.some(
    (pat) => n === pat || n.endsWith(`_${pat}`) || n.startsWith(`${pat}_`),
  )
}

/**
 * The ownership column of `tableName` if it is owned DIRECTLY — either because
 * a column foreign-keys into the end-user table, or because a column is named
 * like an owner. Returns null when neither holds.
 *
 * This is the primitive rules 1, 2 and 3 are all built from: rule 3 is just
 * this function applied to the parent instead of the child.
 */
function directOwnerColumn(
  catalog: OwnershipCatalog,
  tableName: string,
): { column: string; basis: 'foreign_key' | 'column_name' } | null {
  // (1) A declared FK into `users` is ownership regardless of what it's called.
  const fkToUsers = catalog.foreignKeys.find(
    (fk) => fk.childTable === tableName && fk.parentTable === END_USER_TABLE,
  )
  if (fkToUsers) return { column: fkToUsers.childColumn, basis: 'foreign_key' }

  // (2) Fall back to naming convention for schemas that never declared the FK.
  const cols = catalog.columns.get(tableName) ?? []
  const byName = new Map(cols.map((c) => [c.toLowerCase(), c]))
  for (const candidate of OWNERSHIP_COLUMN_CANDIDATES) {
    const actual = byName.get(candidate.toLowerCase())
    if (actual) return { column: actual, basis: 'column_name' }
  }
  return null
}

/**
 * Decide the RLS policy shape for one table. Pure — pass a catalog loaded once.
 */
export function inferRlsPlanFromCatalog(
  catalog: OwnershipCatalog,
  tableName: string,
): RlsPlan {
  // The end-user table owns itself: a row IS the user.
  if (tableName === END_USER_TABLE) {
    return {
      kind: 'own_rows',
      template: 'own_rows',
      userIdColumn: 'id',
      basis: 'column_name',
      reason: 'The end-user identity table — each row is owned by the user it describes.',
    }
  }

  const direct = directOwnerColumn(catalog, tableName)
  if (direct) {
    return {
      kind: 'own_rows',
      template: 'own_rows',
      userIdColumn: direct.column,
      basis: direct.basis,
      reason:
        direct.basis === 'foreign_key'
          ? `"${direct.column}" is a foreign key to ${END_USER_TABLE}(id), so each row belongs to exactly one end-user.`
          : `"${direct.column}" names the owning end-user.`,
    }
  }

  // (3) Indirect ownership — exactly one hop to a directly-owned parent.
  //
  // "Exactly one" is a requirement, not an optimisation. A table with two
  // owned parents (e.g. a join table between two user-owned rows) has two
  // defensible policies and no basis to choose between them; installing one
  // silently would be a guess with security consequences.
  const parentLinks = catalog.foreignKeys.filter((fk) => fk.childTable === tableName)
  const ownedParents = parentLinks
    .map((fk) => {
      // Self-references cannot carry ownership downward and would make the
      // policy subquery re-enter the very table being protected.
      if (fk.parentTable === tableName) return null
      const parentOwner = directOwnerColumn(catalog, fk.parentTable)
      return parentOwner ? { fk, parentOwnerColumn: parentOwner.column } : null
    })
    .filter((x): x is { fk: ForeignKey; parentOwnerColumn: string } => x !== null)

  // De-duplicate by parent table: two FKs to the same parent still describe one
  // ownership path.
  const distinctParents = new Set(ownedParents.map((p) => p.fk.parentTable))

  if (ownedParents.length > 0 && distinctParents.size === 1) {
    const { fk, parentOwnerColumn } = ownedParents[0]
    return {
      kind: 'related_rows',
      template: 'related_rows',
      via: {
        localColumn: fk.childColumn,
        parentTable: fk.parentTable,
        parentColumn: fk.parentColumn,
        parentOwnerColumn,
      },
      basis: 'fk_chain',
      reason:
        `Rows are owned indirectly: "${tableName}"."${fk.childColumn}" → ` +
        `"${fk.parentTable}"."${fk.parentColumn}", and "${fk.parentTable}"."${parentOwnerColumn}" ` +
        `names the end-user. Access follows the parent.`,
    }
  }

  // (4) Reference data — readable by everyone, writable by nobody but the
  // service role.
  if (isReferenceTable(tableName)) {
    return {
      kind: 'public_read',
      template: 'public_read',
      basis: 'reference_table',
      reason:
        `"${tableName}" is reference data that every client is meant to read. ` +
        `Reads stay open; writes are restricted to service-role keys.`,
    }
  }

  // (5) Honest failure. Note we do NOT fall back to admin_only or own_rows:
  // guessing here either breaks the app or leaves it exposed, and the caller
  // has a queue for exactly this.
  return {
    kind: 'undecidable',
    template: null,
    basis: 'undecidable',
    reason:
      `Backenly cannot tell who owns a row in "${tableName}": no column references ` +
      `${END_USER_TABLE}(id), no column is named like an owner ` +
      `(${OWNERSHIP_COLUMN_CANDIDATES.slice(0, 6).join(', ')}, …), and it does not reference ` +
      `exactly one user-owned table. Say what the rule is and Backenly will enforce it.`,
    relatedTables: Array.from(new Set(parentLinks.map((fk) => fk.parentTable))),
  }
}

/** Convenience wrapper for single-table callers. */
export async function inferRlsPlan(projectId: string, tableName: string): Promise<RlsPlan> {
  const catalog = await loadOwnershipCatalog(projectId)
  return inferRlsPlanFromCatalog(catalog, tableName)
}

/**
 * How bad is it that this table has RLS disabled?
 *
 * A product catalog with RLS off is a real finding — its writes are open — but
 * calling it `critical | missing_rls` next to a table leaking customer orders
 * is how a queue trains its reader to ignore it. Severity follows what is
 * actually exposed:
 *
 *   own_rows / related_rows → critical  (per-user rows readable by any key)
 *   undecidable             → critical  (unknown, therefore assumed sensitive)
 *   public_read             → warning   (reads are meant to be open; writes are not)
 */
export function severityForPlan(plan: RlsPlan): 'critical' | 'warning' {
  return plan.kind === 'public_read' ? 'warning' : 'critical'
}

/**
 * One sentence naming what is exposed, written from the inferred plan so the
 * finding says something true about THIS table instead of a generic template.
 */
export function exposureReason(tableName: string, plan: RlsPlan): string {
  switch (plan.kind) {
    case 'own_rows':
      return (
        `Rows in "${tableName}" belong to individual end-users (via "${plan.userIdColumn}") but RLS is ` +
        `disabled — every user can read and modify every other user's rows.`
      )
    case 'related_rows':
      return (
        `Rows in "${tableName}" belong to individual end-users through ` +
        `"${plan.via.parentTable}"."${plan.via.parentOwnerColumn}", but RLS is disabled — every row is ` +
        `readable by any API key. Indirectly-owned tables (line items, addresses, saved cards) hold the ` +
        `same private data as their parent.`
      )
    case 'public_read':
      return (
        `"${tableName}" is reference data, so open reads are correct — but with RLS disabled its ` +
        `INSERT/UPDATE/DELETE are open too. Any API key can rewrite it.`
      )
    default:
      return (
        `"${tableName}" is reachable by API clients with RLS disabled — every row is readable by any ` +
        `API key — and Backenly cannot infer who owns a row, so it will not guess a policy. ${plan.reason}`
      )
  }
}
