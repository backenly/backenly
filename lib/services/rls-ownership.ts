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
 *  1. TWO OR MORE columns naming end-users → party_rows over all of them.
 *     Checked FIRST, because a two-party table also satisfies rule 2 — and that
 *     is exactly how it used to be mis-resolved. `connections(requester_id,
 *     addressee_id)` took the first foreign key and locked the addressee out of
 *     their own row; `conversations(user_a, user_b)` hid each thread from one
 *     participant. A row on a join table between two users belongs to both of
 *     them, and no reading of the schema supports picking a side.
 *  2. ONE FK to the end-user table     → own_rows on that column.
 *     A `customer_id uuid REFERENCES users(id)` IS direct ownership. Naming is
 *     a convention; a foreign key is a declaration. The key wins.
 *  3. Name-matched ownership column    → own_rows on that column.
 *     Covers schemas that never declared the FK.
 *  4. Single FK to a table that itself resolves by (1), (2) or (3)
 *                                      → related_rows through that parent.
 *     This is the case that was silently unprotected. When the PARENT is
 *     multi-party the child inherits every party, so a message is readable by
 *     both participants of its conversation and not only by its sender — this
 *     also OUTRANKS a single direct owner on the child, since the parent's party
 *     set already contains it.
 *  5. Reference/catalog table          → public_read.
 *     World-readable is CORRECT for a product catalog. But "RLS disabled" is
 *     not the same thing as "publicly readable": it also leaves INSERT/UPDATE/
 *     DELETE open to any key. public_read is what the user actually meant —
 *     reads open, writes service-role only.
 *  6. Anything else                    → undecidable.
 *     Reported honestly with the candidates that were checked, so a human or an
 *     agent decides. We do NOT enable RLS with no policy: that turns a data
 *     exposure into an outage (the table reads empty), which is a worse bug
 *     than the one being fixed. The caller can then state the rule itself via
 *     add_rls's `custom` template.
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

export type InferredTemplate = 'own_rows' | 'party_rows' | 'related_rows' | 'public_read'

export interface RelatedRowsVia {
  /** Column on THIS table holding the parent reference (e.g. `order_id`). */
  localColumn: string
  /** Parent table in the same workspace schema (e.g. `orders`). */
  parentTable: string
  /** Column on the parent the local column points at (almost always `id`). */
  parentColumn: string
  /**
   * The parent's ownership column(s).
   *
   * A LIST, not a single column, because the parent may itself be two-party. A
   * `messages` table hanging off `conversations(user_a, user_b)` is owned by
   * whoever is either participant — and with a single column here, only the
   * first participant could read the conversation's messages. That is the same
   * defect as #12, one hop further out, and it is the shape every chat and
   * connection-request schema has.
   */
  parentOwnerColumns: string[]
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
      /**
       * TWO OR MORE parties own the row, and each of them may read it.
       *
       * ── Why this exists ─────────────────────────────────────────────────────
       *
       * `own_rows` picks ONE ownership column. On a two-party table that is not a
       * simplification, it is wrong: for
       *
       *     connections(requester_id → users, addressee_id → users)
       *
       * the inference took the first foreign key it found and installed
       * `requester_id = auth.uid()`, which locks the ADDRESSEE out of the row
       * describing their own connection request. The same happened to
       * `conversations(user_a, user_b)` and `messages(sender_id, recipient_id)`.
       * Reported as defect #12 — and it is what made owner-only RLS unable to
       * express any social, messaging, or marketplace schema.
       *
       * Every two-party table in the report was a case of this. The policy is
       * "you own the row if you are ANY of its parties", which is both correct
       * and the only reading a join table between two users supports.
       */
      kind: 'party_rows'
      template: 'party_rows'
      /** Every column naming a party to the row, in schema order. */
      partyColumns: string[]
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
  const all = directOwnerColumns(catalog, tableName)
  return all ? { column: all.columns[0], basis: all.basis } : null
}

/**
 * EVERY column that names an owning end-user, not just the first.
 *
 * ── Why "the first" was a bug and not a shortcut ──────────────────────────────
 *
 * `Array.find` on the foreign keys returned whichever FK to `users` the catalog
 * happened to list first. On a one-owner table that is the right answer. On a
 * two-party table it silently picks a side:
 *
 *     connections(requester_id → users, addressee_id → users)
 *
 * became `own_rows` on `requester_id`, so the addressee could not read the
 * request addressed to them. Nothing reported that a choice had been made.
 *
 * Foreign keys and names are still ranked in that order — a declared FK is a
 * declaration, a name is a convention — but within a basis, ALL matches are
 * returned so the caller can tell one-party from many-party.
 *
 * Bases are not mixed: if any FK to `users` exists, only FK-declared columns
 * count. Mixing them would let a `created_by` audit column that was never
 * declared as a foreign key become a "party" to a row it merely records, which
 * would widen access rather than describe it.
 */
function directOwnerColumns(
  catalog: OwnershipCatalog,
  tableName: string,
): { columns: string[]; basis: 'foreign_key' | 'column_name' } | null {
  // (1) Declared FKs into `users` are ownership regardless of what they're called.
  const fkCols = catalog.foreignKeys
    .filter((fk) => fk.childTable === tableName && fk.parentTable === END_USER_TABLE)
    .map((fk) => fk.childColumn)
  const distinctFk = [...new Set(fkCols)]
  if (distinctFk.length > 0) return { columns: distinctFk, basis: 'foreign_key' }

  // (2) Fall back to naming convention for schemas that never declared the FK.
  // Ordered by the candidate list so the canonical name leads, which keeps the
  // single-owner answer identical to what it was before.
  const cols = catalog.columns.get(tableName) ?? []
  const byName = new Map(cols.map((c) => [c.toLowerCase(), c]))
  const named: string[] = []
  for (const candidate of OWNERSHIP_COLUMN_CANDIDATES) {
    const actual = byName.get(candidate.toLowerCase())
    if (actual && !named.includes(actual)) named.push(actual)
  }
  if (named.length > 0) return { columns: named, basis: 'column_name' }
  return null
}

/**
 * Column-name pairs that mean "two parties to one row" even without a declared
 * foreign key. A schema that writes `user_a`/`user_b` or `from_user_id`/
 * `to_user_id` is describing a two-party relationship as plainly as one that
 * declares both FKs, and `OWNERSHIP_COLUMN_CANDIDATES` only lists the first
 * member of each pair.
 */
const PARTY_COLUMN_PATTERNS = [
  /^user_[ab]$/i, /^user[12]$/i,
  /^(from|to)_user_id$/i, /^(sender|recipient|receiver)_id$/i,
  /^(requester|addressee|requestee)_id$/i,
  /^(follower|following)_id$/i,
  /^(buyer|seller)_id$/i,
  /^(inviter|invitee)_id$/i,
  /^participant_[ab12]$/i,
]

/** Columns matching a two-party naming pattern. */
function partyNamedColumns(catalog: OwnershipCatalog, tableName: string): string[] {
  const cols = catalog.columns.get(tableName) ?? []
  return cols.filter((c) => PARTY_COLUMN_PATTERNS.some((p) => p.test(c)))
}

/** Every foreign key leaving this table. */
function parentLinksOf(catalog: OwnershipCatalog, tableName: string): ForeignKey[] {
  return catalog.foreignKeys.filter((fk) => fk.childTable === tableName)
}

/**
 * Every column of `tableName` that names an owning end-user — declared or
 * conventionally named. Used to ask "is this table multi-party?" about a PARENT.
 */
function allOwnerColumnsOf(catalog: OwnershipCatalog, tableName: string): string[] {
  const declared = directOwnerColumns(catalog, tableName)
  const named = partyNamedColumns(catalog, tableName)
  return [...new Set([...(declared?.columns ?? []), ...named])]
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

  const direct = directOwnerColumns(catalog, tableName)

  // (1a) TWO OR MORE parties. Checked before the single-owner case, because a
  // two-party table satisfies the single-owner test too — that is precisely how
  // it used to be mis-resolved.
  if (direct && direct.columns.length >= 2) {
    return {
      kind: 'party_rows',
      template: 'party_rows',
      partyColumns: direct.columns,
      basis: direct.basis,
      reason:
        `"${tableName}" names ${direct.columns.length} end-user parties ` +
        `(${direct.columns.join(', ')})` +
        (direct.basis === 'foreign_key' ? ` — each is a foreign key to ${END_USER_TABLE}(id)` : '') +
        `. A row belongs to every party, so each of them can read it and neither can read anyone else's.`,
    }
  }

  // (1b) A single declared owner PLUS a column named like a counterparty. This
  // catches `messages(sender_id, recipient_id)` in a schema that only declared
  // the FK on the sender — where owner-only RLS would let the sender read the
  // message and hide it from the person it was sent to.
  if (direct && direct.columns.length === 1) {
    const partyNamed = partyNamedColumns(catalog, tableName)
    const parties = [...new Set([...direct.columns, ...partyNamed])]
    if (parties.length >= 2) {
      return {
        kind: 'party_rows',
        template: 'party_rows',
        partyColumns: parties,
        basis: direct.basis,
        reason:
          `"${tableName}" is a two-party table: "${direct.columns[0]}" owns the row and ` +
          `${partyNamed.filter((c) => c !== direct.columns[0]).map((c) => `"${c}"`).join(', ')} ` +
          `names the counterparty. Both sides can read the row.`,
      }
    }
  }

  // (1d) A single direct owner, but the row ALSO hangs off a TWO-PARTY parent.
  //
  // `messages(conversation_id → conversations, sender_id → users)` is the case.
  // The sender is a direct owner, so this used to resolve to `own_rows` on
  // `sender_id` — and the OTHER participant could not read a message sent to
  // them. The conversation is the more complete rule: a message belongs to the
  // thread, and both participants of the thread can read it. The sender is
  // always one of those participants, so this never narrows access; it widens it
  // to exactly the set the parent already grants.
  //
  // Only a MULTI-PARTY parent triggers this. When the parent has one owner, the
  // direct owner is already the right answer and nothing changes — so
  // `order_items(order_id → orders, added_by → users)` and
  // `comments(post_id → posts, author_id → users)` behave exactly as before.
  if (direct && direct.columns.length === 1) {
    const partyParents = parentLinksOf(catalog, tableName)
      .map((fk) => {
        if (fk.parentTable === tableName) return null
        const parentOwners = allOwnerColumnsOf(catalog, fk.parentTable)
        return parentOwners.length >= 2 ? { fk, parentOwners } : null
      })
      .filter((x): x is { fk: ForeignKey; parentOwners: string[] } => x !== null)

    if (partyParents.length === 1) {
      const { fk, parentOwners } = partyParents[0]
      return {
        kind: 'related_rows',
        template: 'related_rows',
        via: {
          localColumn: fk.childColumn,
          parentTable: fk.parentTable,
          parentColumn: fk.parentColumn,
          parentOwnerColumns: parentOwners,
        },
        basis: 'fk_chain',
        reason:
          `"${tableName}"."${direct.columns[0]}" names one end-user, but the row belongs to a shared ` +
          `"${fk.parentTable}" with ${parentOwners.length} parties (${parentOwners.join(', ')}). Access ` +
          `follows the parent, so every party to it can read the row — scoping to ` +
          `"${direct.columns[0]}" alone would hide each row from the other side.`,
      }
    }
  }

  if (direct) {
    return {
      kind: 'own_rows',
      template: 'own_rows',
      userIdColumn: direct.columns[0],
      basis: direct.basis,
      reason:
        direct.basis === 'foreign_key'
          ? `"${direct.columns[0]}" is a foreign key to ${END_USER_TABLE}(id), so each row belongs to exactly one end-user.`
          : `"${direct.columns[0]}" names the owning end-user.`,
    }
  }

  // (1c) No declared or canonically-named owner, but two party-named columns —
  // e.g. `follows(follower_id, following_id)` in a schema with no FKs at all.
  const partyOnly = partyNamedColumns(catalog, tableName)
  if (partyOnly.length >= 2) {
    return {
      kind: 'party_rows',
      template: 'party_rows',
      partyColumns: partyOnly,
      basis: 'column_name',
      reason:
        `"${tableName}" names two end-user parties (${partyOnly.join(', ')}) by convention. ` +
        `A row belongs to both, so each can read it.`,
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
      // ALL of the parent's owner columns. A `messages` row hanging off
      // `conversations(user_a, user_b)` is readable by either participant; with
      // only the first column here, the second participant could not read the
      // messages in their own conversation.
      const owners = allOwnerColumnsOf(catalog, fk.parentTable)
      return owners.length > 0 ? { fk, parentOwnerColumns: owners } : null
    })
    .filter((x): x is { fk: ForeignKey; parentOwnerColumns: string[] } => x !== null)

  // De-duplicate by parent table: two FKs to the same parent still describe one
  // ownership path.
  const distinctParents = new Set(ownedParents.map((p) => p.fk.parentTable))

  if (ownedParents.length > 0 && distinctParents.size === 1) {
    const { fk, parentOwnerColumns } = ownedParents[0]
    return {
      kind: 'related_rows',
      template: 'related_rows',
      via: {
        localColumn: fk.childColumn,
        parentTable: fk.parentTable,
        parentColumn: fk.parentColumn,
        parentOwnerColumns,
      },
      basis: 'fk_chain',
      reason:
        `Rows are owned indirectly: "${tableName}"."${fk.childColumn}" → ` +
        `"${fk.parentTable}"."${fk.parentColumn}", and ` +
        (parentOwnerColumns.length === 1
          ? `"${fk.parentTable}"."${parentOwnerColumns[0]}" names the end-user`
          : `"${fk.parentTable}" has ${parentOwnerColumns.length} parties ` +
            `(${parentOwnerColumns.join(', ')}), any of whom owns it`) +
        `. Access follows the parent.`,
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
    case 'party_rows':
      return (
        `Rows in "${tableName}" belong to specific pairs of end-users ` +
        `(${plan.partyColumns.join(' / ')}) but RLS is disabled — every user can read and modify every ` +
        `other pair's rows. On a connections, conversations or messages table that is the whole private ` +
        `social graph.`
      )
    case 'related_rows':
      return (
        `Rows in "${tableName}" belong to individual end-users through ` +
        `${plan.via.parentOwnerColumns.map((c) => `"${plan.via.parentTable}"."${c}"`).join(' / ')}, ` +
        `but RLS is disabled — every row is readable by any API key. Indirectly-owned tables (line items, ` +
        `addresses, saved cards, messages in a conversation) hold the same private data as their parent.`
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
