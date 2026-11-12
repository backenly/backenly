/**
 * FOREIGN KEY REPLICATION — a branch refuses what production refuses
 * ==================================================================
 *
 * `CREATE TABLE ... (LIKE src INCLUDING ALL)` copies types, defaults, NOT NULL,
 * CHECK, UNIQUE and indexes. It copies no foreign key: PostgreSQL's LIKE never
 * does. Branches were first built as a sandbox, "not a runtime", and left them
 * out on purpose. A branch is a runtime now: it is served at its own preview
 * endpoint, and agents test against it before a merge.
 *
 * Production QA (2026-11-09) showed what that cost: an agent inserted orders
 * for a user id that did not exist, the branch accepted them, and production,
 * which has the key, would not have. Passing on a branch has to mean the same
 * as passing on production, so every key main has is created on the branch,
 * pointing at the branch's own tables.
 *
 * ── How each key is copied ───────────────────────────────────────────────────
 *
 * pg_get_constraintdef renders a key exactly as PostgreSQL holds it: columns,
 * the referenced table and columns, MATCH, both referential actions,
 * DEFERRABLE and NOT VALID. It qualifies the referenced table only when it is
 * not on the search path, so the definition is read with main's schema on the
 * path, which leaves main's tables unqualified, and created with the branch's
 * on the path, which points them at the branch's copies.
 *
 * A key main holds NOT VALID (rows that break it were left in place when it was
 * added) stays NOT VALID on the branch, so a copy of those rows does not fail
 * the clone. A key into a table the branch does not copy (another schema, or
 * Backenly's own `_backenly_` tables) is not created, and the result says so.
 */

import type { PoolClient } from 'pg'

export interface ForeignKeyCloneResult {
  /** Keys created on the branch. */
  created: number
  /** Keys main has that the branch does not, and why. */
  skipped: Array<{ table: string; name: string; reason: string }>
}

interface MainForeignKey {
  name: string
  child: string
  parent: string
  parentSchema: string
  definition: string
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`

/** Every foreign key on a table in `schema`, rendered relative to that schema. */
async function foreignKeysOf(client: PoolClient, schema: string): Promise<MainForeignKey[]> {
  await client.query(`SET LOCAL search_path TO ${quote(schema)}`)
  const { rows } = await client.query<MainForeignKey>(
    `SELECT con.conname AS name,
            child.relname AS child,
            parent.relname AS parent,
            parent_ns.nspname AS "parentSchema",
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      WHERE con.contype = 'f' AND child_ns.nspname = $1
      ORDER BY child.relname, con.conname`,
    [schema],
  )
  return rows
}

/**
 * Create on the branch every foreign key main has between tables the branch
 * copied. Runs inside the clone's transaction, after any rows were copied, so
 * each key is checked against the rows the branch starts with.
 */
export async function replicateForeignKeys(
  client: PoolClient,
  mainSchema: string,
  branchSchema: string,
  copiedTables: readonly string[],
): Promise<ForeignKeyCloneResult> {
  const copied = new Set(copiedTables)
  const keys = await foreignKeysOf(client, mainSchema)
  const result: ForeignKeyCloneResult = { created: 0, skipped: [] }

  await client.query(`SET LOCAL search_path TO ${quote(branchSchema)}`)
  for (const key of keys) {
    if (!copied.has(key.child)) continue
    if (key.parentSchema !== mainSchema || !copied.has(key.parent)) {
      result.skipped.push({
        table: key.child,
        name: key.name,
        reason: `it references ${key.parentSchema}.${key.parent}, which a branch does not copy`,
      })
      continue
    }
    await client.query(
      `ALTER TABLE ${quote(branchSchema)}.${quote(key.child)} ADD CONSTRAINT ${quote(key.name)} ${key.definition}`,
    )
    result.created++
  }
  await client.query('SET LOCAL search_path TO DEFAULT')
  return result
}

export interface ForeignKeyParity {
  ok: boolean
  /** `table.constraint` main has and the branch should, but does not. */
  missing: string[]
  reason?: string
}

/**
 * Assert against the live catalog that the branch holds each key it should,
 * with the same definition, rather than trusting the count above.
 */
export async function verifyForeignKeyParity(
  client: PoolClient,
  mainSchema: string,
  branchSchema: string,
  copiedTables: readonly string[],
): Promise<ForeignKeyParity> {
  const copied = new Set(copiedTables)
  const expected = (await foreignKeysOf(client, mainSchema)).filter(
    (k) => copied.has(k.child) && k.parentSchema === mainSchema && copied.has(k.parent),
  )
  const held = new Map(
    (await foreignKeysOf(client, branchSchema))
      .filter((k) => k.parentSchema === branchSchema)
      .map((k) => [`${k.child}.${k.name}`, k.definition]),
  )
  await client.query('SET LOCAL search_path TO DEFAULT')

  const missing = expected
    .filter((k) => held.get(`${k.child}.${k.name}`) !== k.definition)
    .map((k) => `${k.child}.${k.name}`)
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason:
        `${missing.length} foreign key(s) on main are missing on the branch: ${missing.slice(0, 5).join(', ')}. ` +
        'The branch would accept rows production refuses.',
    }
  }
  return { ok: true, missing: [] }
}
