/**
 * repair-overzealous-not-null.ts — make already-built tables insertable again.
 *
 * `deriveConstraints` used to read:
 *
 *     isRequired: !name.includes('optional') && !name.startsWith('is_'/'has_')
 *
 * so every scalar column Backenly generated came out NOT NULL with no default.
 * That is fixed at the source, but the fix only governs tables created from now
 * on. Tables already in production stay un-insertable, and they fail at INSERT
 * time — the worst place to find out.
 *
 * The live case this was written for: `profiles` had display_name, avatar_url,
 * role, bio, website and location all mandatory, while Backenly's own generated
 * signup handler passed `avatar_url: null` for a user with no avatar. It failed
 * 23502 once a minute for days, swallowed by the handler's try/catch, with the
 * table at zero rows.
 *
 * ── What it will and will not touch ─────────────────────────────────────────
 *
 * Drops NOT NULL only where ALL of these hold:
 *   • the column has NO default        (NOT NULL DEFAULT x is satisfiable, keep)
 *   • it is not the primary key
 *   • it is not `email` / `username`   (identity anchors stay required)
 *   • it is not in a UNIQUE constraint (same reasoning)
 *   • it is not a foreign key, UNLESS it is a forward pointer
 *     (current_/latest_/active_/…), which cannot be satisfied at insert time
 *   • it is not a reserved platform column
 *
 * Widening NOT NULL to nullable can never invalidate an existing row, so this is
 * safe to run against live data and safe to run twice. It is deliberately NOT
 * the inverse of the inference: it does not try to re-guess which columns SHOULD
 * be required. Requiredness is the owner's call, stated per column.
 *
 *   npx tsx scripts/repair-overzealous-not-null.ts            # report only
 *   npx tsx scripts/repair-overzealous-not-null.ts --apply    # execute
 *   npx tsx scripts/repair-overzealous-not-null.ts --apply --project <uuid>
 */

import { Pool } from 'pg'

const APPLY = process.argv.includes('--apply')
const projectFlag = process.argv.indexOf('--project')
const ONLY_PROJECT = projectFlag > -1 ? process.argv[projectFlag + 1] : null

const FORWARD_POINTER = /^(current|latest|active|primary|default|featured|selected|preferred|pinned|winning)_/

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
async function sql<T = any>(q: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect()
  try {
    return (await c.query(q, params)).rows
  } finally {
    c.release()
  }
}

interface Candidate {
  schema: string
  table: string
  column: string
  dataType: string
  isFk: boolean
}

async function findCandidates(): Promise<Candidate[]> {
  return sql<Candidate>(
    `
    SELECT c.table_schema      AS "schema",
           c.table_name        AS "table",
           c.column_name       AS "column",
           c.data_type         AS "dataType",
           EXISTS (
             SELECT 1
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema    = kcu.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema    = c.table_schema
               AND tc.table_name      = c.table_name
               AND kcu.column_name    = c.column_name
           )                   AS "isFk"
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name   = c.table_name
     AND t.table_type   = 'BASE TABLE'
    WHERE c.table_schema LIKE 'workspace\\_%'
      AND ($1::text IS NULL OR c.table_schema = 'workspace_' || $1)
      AND c.is_nullable    = 'NO'
      AND c.column_default IS NULL
      -- Reserved platform columns and internal tables are not the owner's schema.
      AND c.column_name NOT IN ('id', 'createdAt', 'updatedAt', 'deleted_at')
      AND c.table_name NOT LIKE '\\_%'
      -- Identity anchors stay required.
      AND lower(c.column_name) NOT IN ('email', 'username')
      -- Primary keys.
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema    = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema    = c.table_schema
          AND tc.table_name      = c.table_name
          AND kcu.column_name    = c.column_name
      )
      -- Anything the schema declares UNIQUE is load-bearing identity.
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema    = kcu.table_schema
        WHERE tc.constraint_type = 'UNIQUE'
          AND tc.table_schema    = c.table_schema
          AND tc.table_name      = c.table_name
          AND kcu.column_name    = c.column_name
      )
    ORDER BY c.table_schema, c.table_name, c.column_name
    `,
    [ONLY_PROJECT],
  )
}

async function main() {
  const all = await findCandidates()

  // A real FK is a deliberate relational choice with matching ON DELETE
  // semantics, so it keeps its NOT NULL — except forward pointers, which name a
  // row that does not exist yet and therefore can never be satisfied.
  const targets = all.filter((c) => !c.isFk || FORWARD_POINTER.test(c.column.toLowerCase()))
  const keptFks = all.length - targets.length

  if (targets.length === 0) {
    console.log('Nothing to repair: no over-strict NOT NULL columns found.')
    await pool.end()
    return
  }

  const bySchema = new Map<string, Candidate[]>()
  for (const c of targets) {
    const list = bySchema.get(c.schema) ?? []
    list.push(c)
    bySchema.set(c.schema, list)
  }

  console.log(
    `${targets.length} column(s) across ${bySchema.size} workspace schema(s) are NOT NULL ` +
    `with no default and no reason to be.` +
    (keptFks > 0 ? ` (${keptFks} foreign-key column(s) left alone.)` : ''),
  )
  console.log(APPLY ? 'Applying.\n' : 'Dry run. Re-run with --apply to execute.\n')

  let done = 0
  let failed = 0
  for (const [schema, cols] of bySchema) {
    console.log(`── ${schema}`)
    for (const c of cols) {
      const stmt = `ALTER TABLE "${c.schema}"."${c.table}" ALTER COLUMN "${c.column}" DROP NOT NULL`
      if (!APPLY) {
        console.log(`   would drop NOT NULL: ${c.table}.${c.column} (${c.dataType})`)
        continue
      }
      try {
        await sql(stmt)
        done++
        console.log(`   ✔ ${c.table}.${c.column}`)
      } catch (err: any) {
        failed++
        console.error(`   ✘ ${c.table}.${c.column}: ${err.message}`)
      }
    }
  }

  if (APPLY) {
    console.log(`\nRepaired ${done} column(s)${failed ? `, ${failed} failed` : ''}.`)
  }
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
