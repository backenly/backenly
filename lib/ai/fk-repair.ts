/**
 * GLOBAL FOREIGN KEY REPAIR
 * =========================
 * After a batch of tables is created, scans every table in the workspace for
 * columns that look like FK references (userId, postId, order_id, etc.) and
 * adds actual FOREIGN KEY constraints if the referenced table exists but the
 * constraint is missing.
 *
 * Uses ON DELETE CASCADE ON UPDATE CASCADE as the default rule.
 * Uses ON DELETE SET NULL for optional assignment columns (assigned_to, actor_id).
 */

const SET_NULL_COLUMNS = ['assigned_to', 'assignee_id', 'updated_by', 'deleted_by', 'approved_by', 'actor_id']

/**
 * Semantic-role columns that don't match a table by name but conventionally
 * reference the users table (e.g. sellerId, buyerId, authorId).
 * Key: the inferred base from the column name (lower-case, no "id" suffix).
 * Value: the canonical table it references.
 */
const ROLE_TO_TABLE: Record<string, string> = {
  seller: 'users',
  buyer: 'users',
  author: 'users',
  creator: 'users',
  owner: 'users',
  reviewer: 'users',
  approver: 'users',
  sender: 'users',
  recipient: 'users',
  requester: 'users',
  follower: 'users',
  following: 'users',
  publisher: 'users',
  moderator: 'users',
  operator: 'users',
}

/**
 * Qualifier prefixes that describe a *role* the referenced row plays, not a
 * different table. `parent_post_id` still points at `posts`; `reply_message_id`
 * still points at `messages`. Stripping the qualifier lets the resolver find the
 * real target — which for threaded / hierarchical data is the column's OWN table
 * (a self-reference). Without this, every `parent_*_id` / `child_*_id` column
 * fell through unresolved and got dumped into the human review queue.
 */
const SELF_REF_QUALIFIERS = [
  'parent', 'child', 'reply', 'original', 'source', 'target',
  'related', 'ref', 'root', 'sub', 'next', 'prev', 'previous',
]

/**
 * Directional qualifiers (from_user_id, to_account_id) describe which end of
 * an edge the referenced row sits on, never a different table. Unlike
 * SELF_REF_QUALIFIERS they are only meaningful with a remainder — a bare
 * `from_id` / `to_id` names no target table, so it stays unresolved (human
 * review) rather than guessing a self-reference that is usually wrong for
 * edge tables (follows.from_id points at users, not follows).
 */
const DIRECTIONAL_QUALIFIERS = ['from', 'to']

/**
 * Strip a leading role qualifier from an FK base. Returns:
 *   • the remaining base   (`parent_post` → `post`)
 *   • ''                   for a bare qualifier (`parent` → self-ref to host table)
 *   • null                 when there is no qualifier to strip
 */
function stripLeadingQualifier(base: string): string | null {
  for (const q of SELF_REF_QUALIFIERS) {
    if (base === q) return ''
    if (base.startsWith(`${q}_`)) return base.slice(q.length + 1)
  }
  for (const q of DIRECTIONAL_QUALIFIERS) {
    // No bare form: `from_id` alone resolves to nothing (see the const's doc).
    if (base.startsWith(`${q}_`)) return base.slice(q.length + 1)
  }
  return null
}

/**
 * Which cascade rule the repair WOULD apply, without applying anything.
 *
 * Exported so the detector can state it in the finding, and that matters more
 * than it looks. `missing_fk` used to be classified `auto`, so this heuristic
 * ran unattended — and its default branch is ON DELETE CASCADE. The autonomous
 * repair was therefore deciding, from a column name, that deleting a user row
 * should silently delete every row that references it. That is a destructive
 * change to application semantics chosen by inference, which is exactly the
 * class of change that has to be proposed rather than performed.
 *
 * The type is now approval-gated and the approval names the target table AND
 * this rule, so the owner approves the actual behaviour rather than the word
 * "constraint". Same function on both sides, so the preview cannot drift from
 * what runs.
 */
export function plannedCascadeRule(
  columnName: string,
  tableName: string,
  opts?: { selfRef?: boolean; nullable?: boolean },
): { onDelete: string; onUpdate: string } {
  return getCascadeRule(columnName, tableName, opts)
}

function getCascadeRule(
  columnName: string,
  tableName: string,
  opts?: { selfRef?: boolean; nullable?: boolean },
): { onDelete: string; onUpdate: string } {
  const colLower = columnName.toLowerCase()
  const tableLower = tableName.toLowerCase()

  // Self-referential FK (parent_post_id → posts): a CASCADE here means deleting
  // one row silently wipes its entire subtree (delete a post → lose the whole
  // reply thread). Prefer SET NULL (orphan the children, fully reversible) when
  // the column is nullable — which self-reference columns virtually always are,
  // since root rows have no parent. Fall back to CASCADE only when the column is
  // NOT NULL and SET NULL is physically impossible.
  if (opts?.selfRef) {
    return opts.nullable === false
      ? { onDelete: 'CASCADE', onUpdate: 'CASCADE' }
      : { onDelete: 'SET NULL', onUpdate: 'CASCADE' }
  }

  // Audit/log tables: SET NULL (preserve history)
  if (tableLower.includes('log') || tableLower.includes('audit') || tableLower.includes('history')) {
    if (colLower.includes('actor') || colLower.includes('user_id')) {
      return { onDelete: 'SET NULL', onUpdate: 'CASCADE' }
    }
  }

  // Optional assignment columns: SET NULL
  if (SET_NULL_COLUMNS.some(c => colLower === c || colLower.endsWith(c))) {
    return { onDelete: 'SET NULL', onUpdate: 'CASCADE' }
  }

  // Default: CASCADE (child records cascade with parent)
  return { onDelete: 'CASCADE', onUpdate: 'CASCADE' }
}

export interface FKRepairResult {
  repaired: number
  failed: number
  details: Array<{ table: string; column: string; refTable: string; cascadeRule: string; success: boolean }>
  summaryMessage: string
}

export async function repairForeignKeysGlobally(projectId: string): Promise<number> {
  const result = await repairForeignKeysWithDetails(projectId)
  return result.repaired
}

/**
 * Derive the FK "base" name from a column: user_id → user, postId → post,
 * sellerId → seller. Returns null when the column is not FK-shaped (or is the
 * primary key `id`). Shared by the autonomy drift-detector and the single-column
 * repair so both infer the referenced table with identical rules.
 */
export function deriveFkBase(columnName: string): string | null {
  const lower = columnName.toLowerCase()
  if (lower === 'id') return null
  if (lower.endsWith('_id')) return lower.slice(0, -3)
  // camelCase: userId → user (only when the column actually has an uppercase)
  if (/[a-z]id$/.test(lower) && columnName !== columnName.toLowerCase()) return lower.slice(0, -2)
  return null
}

/**
 * Build a case-insensitive map (lowercase → actual DB name) of every base table
 * in a workspace schema. Used to resolve a column's referenced table.
 */
export async function buildWorkspaceTableNameMap(projectId: string): Promise<Map<string, string>> {
  const { prisma } = await import('@/lib/db')
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    postgresSchema,
  )
  const map = new Map<string, string>()
  for (const { table_name } of rows) map.set(table_name.toLowerCase(), table_name)
  return map
}

/**
 * Resolve the table a FK-shaped column references, using the same precedence as
 * the global repair: plural match → exact match → semantic-role map (sellerId →
 * users). Returns the actual (correctly-cased) table name, or null.
 *
 * `hostTable` is the table the column lives on. It lets bare qualifier columns
 * (`parent_id`, `child_id`) resolve to a self-reference, and lets qualified
 * columns (`parent_post_id`) resolve to their real target even when that target
 * is their own table. Optional so existing callers keep working.
 */
export function resolveReferencedTable(
  columnName: string,
  tableNameMap: Map<string, string>,
  hostTable?: string,
): string | null {
  const base = deriveFkBase(columnName)
  if (!base) return null

  const lookup = (b: string): string | null =>
    tableNameMap.get(`${b}s`) ??
    tableNameMap.get(b) ??
    (ROLE_TO_TABLE[b] ? tableNameMap.get(ROLE_TO_TABLE[b]) ?? null : null) ??
    null

  // 1) Direct resolution (unchanged behaviour): parent_post → parent_posts?
  const direct = lookup(base)
  if (direct) return direct

  // 2) Role-qualifier resolution: parent_post → post → posts (a self-reference
  //    when it lands back on the host table); parent_category on products →
  //    categories (a normal cross-table FK).
  const stripped = stripLeadingQualifier(base)
  if (stripped === '') {
    // Bare qualifier (parent_id / child_id) → references the host table itself.
    if (!hostTable) return null
    return tableNameMap.get(hostTable.toLowerCase()) ?? hostTable
  }
  if (stripped) {
    const viaQualifier = lookup(stripped)
    if (viaQualifier) return viaQualifier
  }

  // 3) `<anything>_user` (blocked_user, invited_user, mentioned_user, …)
  //    conventionally references the auth users table — AI-built social/
  //    messaging schemas produce these constantly. `external_*` is excluded:
  //    external_user_id is an identifier from another system, not a row here.
  if (base.endsWith('_user') && !base.startsWith('external')) {
    return tableNameMap.get('users') ?? tableNameMap.get('user') ?? null
  }

  return null
}

/**
 * Add a FOREIGN KEY constraint for a SINGLE column — the per-finding repair the
 * autonomy auto-fix engine calls (via the ADD_CONSTRAINT executor) when it
 * detects a `*_id` column with no FK constraint.
 *
 * Reuses the global repair's cascade rules and `fk_<table>_<base>` naming so a
 * column fixed here is identical to one fixed in a batch pass. Idempotent: a
 * column that already has the FK reports success without re-applying.
 */
export async function repairForeignKeyColumn(
  projectId: string,
  tableName: string,
  columnName: string,
  referencedTable?: string,
): Promise<{ success: boolean; message: string; referencedTable?: string }> {
  const { prisma } = await import('@/lib/db')
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const base = deriveFkBase(columnName)
  if (!base) {
    return { success: false, message: `Column "${columnName}" is not a foreign-key-shaped column — nothing to constrain.` }
  }

  // Resolve the referenced table when the caller did not supply one. Pass the
  // host table so self-referential columns (parent_post_id → posts) resolve
  // instead of falling through as "unknown target".
  let refTable = referencedTable
  if (!refTable) {
    const map = await buildWorkspaceTableNameMap(projectId)
    refTable = resolveReferencedTable(columnName, map, tableName) ?? undefined
  }
  if (!refTable) {
    return {
      success: false,
      message: `Could not determine which table "${tableName}.${columnName}" should reference — no matching table found. Leave it, or add the relation explicitly in the AI chat.`,
    }
  }
  // Self-references (parent_post_id → posts) are a legitimate, common shape for
  // threaded / hierarchical data — no longer skipped. The cascade rule below is
  // chosen to keep them non-destructive.
  const isSelfRef = refTable.toLowerCase() === tableName.toLowerCase()

  // Idempotency: skip if a FK already exists on this column.
  const existing = await prisma.$queryRawUnsafe<{ one: number }[]>(
    `SELECT 1 AS one
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1 AND tc.table_name = $2 AND kcu.column_name = $3
      LIMIT 1`,
    postgresSchema, tableName, columnName,
  ).catch(() => [])
  if (existing.length > 0) {
    return { success: true, message: `Foreign key on "${tableName}.${columnName}" already exists.`, referencedTable: refTable }
  }

  // A self-referential SET NULL rule needs a nullable column; check before choosing.
  let nullable = true
  if (isSelfRef) {
    const nn = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3 LIMIT 1`,
      postgresSchema, tableName, columnName,
    ).catch(() => [])
    nullable = nn[0]?.is_nullable !== 'NO'
  }

  const cascade = getCascadeRule(columnName, tableName, { selfRef: isSelfRef, nullable })
  const cascadeStr = `ON DELETE ${cascade.onDelete} ON UPDATE ${cascade.onUpdate}`
  const constraintName = `fk_${tableName}_${base}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 63)

  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${postgresSchema}"."${tableName}"
       ADD CONSTRAINT "${constraintName}"
       FOREIGN KEY ("${columnName}") REFERENCES "${postgresSchema}"."${refTable}"(id) ${cascadeStr}`,
    )
    return {
      success: true,
      message: `Foreign key added: ${tableName}.${columnName} → ${refTable}.id (${cascadeStr})`,
      referencedTable: refTable,
    }
  } catch (err: any) {
    if (err?.message?.includes('already exists')) {
      return { success: true, message: `Foreign key on "${tableName}.${columnName}" already exists.`, referencedTable: refTable }
    }
    return { success: false, message: `Could not add foreign key on "${tableName}.${columnName}": ${err?.message}` }
  }
}

export async function repairForeignKeysWithDetails(projectId: string): Promise<FKRepairResult> {
  const { prisma } = await import('@/lib/db')
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const details: FKRepairResult['details'] = []
  let repaired = 0
  let failed = 0

  try {
    // Get all tables in this workspace
    const tableRows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      postgresSchema
    )
    // Use case-insensitive Map: lowercase key → actual quoted table name in DB
    // This fixes the silent bug where tables created as "Tasks" (PascalCase) were
    // never matched by lookups for "tasks" (lowercase), producing 0 FK constraints.
    const tableNameMap = new Map<string, string>() // lowercase → actual name
    for (const { table_name } of tableRows) {
      tableNameMap.set(table_name.toLowerCase(), table_name)
    }

    // Get all columns across all tables (is_nullable drives the self-ref rule)
    const allCols = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string; is_nullable: string }[]>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND column_name != 'id'`,
      postgresSchema
    )

    // Get all existing FK constraints
    const existingFKs = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      postgresSchema
    )
    const fkSet = new Set(existingFKs.map(r => `${r.table_name}.${r.column_name}`))

    for (const { table_name, column_name, is_nullable } of allCols) {
      const base = deriveFkBase(column_name)
      if (!base) continue

      // Single source of resolution (shared with the per-column repair and the
      // drift detector): plural/exact/role match, plus role-qualifier stripping
      // so parent_post_id → posts resolves as a self-reference.
      const refTable = resolveReferencedTable(column_name, tableNameMap, table_name)
      if (!refTable) continue

      // Skip if FK already exists (checked by table.column, not constraint name)
      if (fkSet.has(`${table_name}.${column_name}`)) continue

      const isSelfRef = refTable.toLowerCase() === table_name.toLowerCase()
      const cascadeRule = getCascadeRule(column_name, table_name, {
        selfRef: isSelfRef,
        nullable: is_nullable !== 'NO',
      })
      const cascadeStr = `ON DELETE ${cascadeRule.onDelete} ON UPDATE ${cascadeRule.onUpdate}`

      try {
        // Use fk_<table>_<base> naming to preserve semantic role and avoid conflicts
        // e.g. orders.sellerId → fk_orders_seller, orders.buyerId → fk_orders_buyer
        const constraintName = `fk_${table_name}_${base}`
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "${postgresSchema}"."${table_name}"
           ADD CONSTRAINT "${constraintName}"
           FOREIGN KEY ("${column_name}") REFERENCES "${postgresSchema}"."${refTable}"(id) ${cascadeStr}`
        )
        console.log(`[FK Repair] ✅ ${table_name}.${column_name} → ${refTable}.id [${cascadeStr}]`)
        fkSet.add(`${table_name}.${column_name}`) // Prevent duplicates in same pass
        repaired++
        details.push({ table: table_name, column: column_name, refTable, cascadeRule: cascadeStr, success: true })
      } catch (err: any) {
        // Non-fatal: column type mismatch, constraint already exists, etc.
        console.warn(`[FK Repair] ⚠️ ${table_name}.${column_name}: ${err?.message?.slice(0, 100)}`)
        failed++
        details.push({ table: table_name, column: column_name, refTable, cascadeRule: cascadeStr, success: false })
      }
    }
  } catch (err: any) {
    console.warn(`[FK Repair] Error during scan:`, err?.message)
  }

  const summaryParts: string[] = []
  if (repaired > 0) summaryParts.push(`${repaired} FK constraint(s) auto-applied with CASCADE rules`)
  if (failed > 0) summaryParts.push(`${failed} constraint(s) could not be applied`)

  return {
    repaired,
    failed,
    details,
    summaryMessage: summaryParts.join('; ') || 'All FK constraints already in place',
  }
}
