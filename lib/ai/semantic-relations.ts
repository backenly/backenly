/**
 * SEMANTIC RELATIONS
 * ==================
 * Deterministic FK inference — no LLM, no guessing.
 *
 * When a column name matches a known pattern, the referenced table is resolved
 * here at the code level, not by asking the AI to guess.
 *
 * Rules (applied in order):
 *   1. Explicit FK_MAP entry → use that table directly
 *   2. Column base in USER_ROLE_ID_BASES → users.id
 *   3. Generic *Id/*_id pattern → ${base}s.id (e.g. productId → products.id)
 */

/**
 * Columns whose base (without the Id/_id suffix) always reference the users
 * table rather than a table named after the role.
 *
 * e.g.  sellerId  → base = "seller"  → users.id  (not sellers.id)
 *       buyerId   → base = "buyer"   → users.id  (not buyers.id)
 *       customerId → base = "customer" → users.id (not customers.id)
 */
export const USER_ROLE_ID_BASES = new Set([
  'seller', 'buyer', 'owner', 'creator', 'author', 'host',
  'organizer', 'assignee', 'reviewer', 'approver', 'manager',
  'moderator', 'editor', 'sender', 'recipient', 'poster',
  'commenter', 'follower', 'following', 'friend', 'inviter',
  'invitee', 'requester', 'responder', 'producer', 'consumer',
  'agent', 'vendor', 'merchant', 'driver', 'customer', 'client',
  'member', 'admin', 'operator', 'participant', 'subscriber',
])

/**
 * Explicit column-name → referenced-table map.
 * Takes priority over USER_ROLE_ID_BASES and the generic pattern.
 *
 * Key:   exact column name (camelCase or snake_case, lowercased for lookup)
 * Value: "table.column" reference
 */
export const FK_MAP: Record<string, string> = {
  // User references
  userid:      'users.id',
  user_id:     'users.id',
  buyerid:     'users.id',
  buyer_id:    'users.id',
  sellerid:    'users.id',
  seller_id:   'users.id',
  ownerid:     'users.id',
  owner_id:    'users.id',
  authorid:    'users.id',
  author_id:   'users.id',
  customerid:  'users.id',
  customer_id: 'users.id',
  // Common domain references
  productid:   'products.id',
  product_id:  'products.id',
  orderid:     'orders.id',
  order_id:    'orders.id',
  categoryid:  'categories.id',
  category_id: 'categories.id',
  postid:      'posts.id',
  post_id:     'posts.id',
  commentid:   'comments.id',
  comment_id:  'comments.id',
  articleid:   'articles.id',
  article_id:  'articles.id',
}

/**
 * Resolve the referenced table for a FK column name.
 *
 * @param columnName   Raw column name from the CREATE_TABLE request
 * @param currentTable Name of the table being created (prevents self-references)
 * @param existingTables Set of table names that already exist in the workspace
 * @returns "table.id" reference string, or null if no FK should be inferred
 */
export function resolveFK(
  columnName: string,
  currentTable: string,
  existingTables: Set<string>,
): string | null {
  const lower = columnName.toLowerCase()

  // Rule 1: explicit map
  const explicit = FK_MAP[lower]
  if (explicit) {
    const [tbl] = explicit.split('.')
    if (tbl !== currentTable.toLowerCase() && existingTables.has(tbl)) {
      return explicit
    }
    // Target table doesn't exist yet — return the reference anyway so FK
    // repair can wire it up after the referenced table is created
    if (tbl !== currentTable.toLowerCase()) return explicit
  }

  // Determine base (strip _id or camelCase Id suffix)
  const isSnakeFk = lower.endsWith('_id') && lower !== 'id'
  const isCamelFk = /[a-z]id$/.test(lower) && columnName !== columnName.toLowerCase()
  if (!isSnakeFk && !isCamelFk) return null

  const base = lower.endsWith('_id') ? lower.slice(0, -3) : lower.slice(0, -2)

  // Rule 2: semantic role → users
  if (USER_ROLE_ID_BASES.has(base)) {
    return 'users.id'
  }

  // Rule 3: generic pattern → ${base}s
  const refTable = `${base}s`
  if (refTable !== currentTable.toLowerCase()) {
    return `${refTable}.id`
  }

  return null
}

/**
 * Semantic column names that reference the users table WITHOUT an _id suffix.
 * e.g. a column named "owner" on the tasks table → tasks.owner → users.id
 */
export const USER_SEMANTIC_COLS = new Set([
  'owner', 'creator', 'author', 'assignee', 'reviewer',
  'approver', 'manager', 'moderator', 'editor', 'sender',
  'recipient', 'host', 'organizer',
])
