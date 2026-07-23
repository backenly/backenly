/**
 * Repair columns whose DEFAULT violates their own CHECK constraint.
 *
 * ── What this repairs ───────────────────────────────────────────────────────
 *
 * Two unaware code paths in lib/ai/minimal-executor.ts picked these separately:
 * any column named `*status*` was given `DEFAULT 'active'`, while a table keyed
 * on the TABLE's name decided the CHECK values. For `orders` that produced
 *
 *   status         text DEFAULT 'active'
 *     CHECK (status IN ('pending','processing','shipped','delivered','cancelled','refunded'))
 *   payment_status text DEFAULT 'active'
 *     CHECK (payment_status IN ('pending','paid','failed','refunded','disputed'))
 *
 * 'active' is in neither list, so any INSERT omitting the column is rejected
 * with SQLSTATE 23514 — the table is un-insertable through its own defaults.
 * Confirmed live on 2026-07-22 in a customer's e-commerce project.
 *
 * The code fix derives the default from the CHECK's value list, so this cannot
 * be created again. It does not repair tables that already exist. This does.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * `ALTER COLUMN ... SET DEFAULT` only affects rows inserted AFTER it. No
 * existing row is read, written or re-validated, and the CHECK constraint is not
 * touched — a column that already holds an out-of-range value keeps it (and was
 * only able to get there by being written explicitly). The replacement is always
 * a value the CHECK already permits, so this can only move a column from
 * "default is rejected" to "default is accepted".
 *
 *   npx tsx scripts/repair-default-check-conflicts.ts          # report only
 *   npx tsx scripts/repair-default-check-conflicts.ts --apply  # repair
 */

import { prisma } from '../lib/db'
import { initialStateFor } from '../lib/ai/minimal-executor'

interface Conflict {
  schema: string
  table: string
  column: string
  currentDefault: string
  allowed: string[]
  replacement: string
}

/**
 * Every `col IN ('a','b',...)` CHECK across every workspace schema, paired with
 * the column's current default.
 *
 * Read from pg_get_constraintdef rather than a stored definition so it reflects
 * the constraint as Postgres actually holds it.
 */
async function findConflicts(): Promise<Conflict[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    schema: string
    table: string
    column: string
    coldefault: string | null
    condef: string
  }>>(`
    SELECT n.nspname          AS schema,
           c.relname          AS table,
           a.attname          AS column,
           pg_get_expr(d.adbin, d.adrelid) AS coldefault,
           pg_get_constraintdef(con.oid)   AS condef
      FROM pg_constraint con
      JOIN pg_class      c   ON c.oid = con.conrelid
      JOIN pg_namespace  n   ON n.oid = c.relnamespace
      JOIN pg_attribute  a   ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE con.contype = 'c'
       AND n.nspname LIKE 'workspace\\_%'
       AND array_length(con.conkey, 1) = 1
       AND d.adbin IS NOT NULL
  `)

  const conflicts: Conflict[] = []

  for (const r of rows) {
    // `CHECK ((status)::text = ANY ((ARRAY['pending'::character varying, ...])::text[]))`
    // is how Postgres renders `IN (...)`. Pull every quoted literal out of the
    // constraint body — that is the permitted set regardless of which rendering
    // this server produced.
    const literals = [...r.condef.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"))
    if (literals.length < 2) continue

    // The default, if it is a plain string literal. Anything else (a function
    // call, an expression) is not a state value and is out of scope.
    const defMatch = /^'((?:[^']|'')*)'(::[a-z ]+)?$/i.exec((r.coldefault ?? '').trim())
    if (!defMatch) continue
    const currentDefault = defMatch[1].replace(/''/g, "'")

    if (literals.includes(currentDefault)) continue // already consistent

    const replacement = initialStateFor(literals)
    if (!replacement) continue

    conflicts.push({
      schema: r.schema,
      table: r.table,
      column: r.column,
      currentDefault,
      allowed: literals,
      replacement,
    })
  }

  return conflicts
}

async function main() {
  const apply = process.argv.includes('--apply')

  const conflicts = await findConflicts()

  if (conflicts.length === 0) {
    console.log('No column defaults conflict with their CHECK constraints.')
    await prisma.$disconnect()
    return
  }

  console.log(
    `\n${conflicts.length} column(s) have a DEFAULT their own CHECK rejects.\n` +
    `Any INSERT omitting these columns fails with SQLSTATE 23514.\n`,
  )
  for (const c of conflicts) {
    console.log(`  ${c.schema}.${c.table}.${c.column}`)
    console.log(`    default:  '${c.currentDefault}'   ← rejected by its own CHECK`)
    console.log(`    allowed:  ${c.allowed.map(v => `'${v}'`).join(', ')}`)
    console.log(`    → set to: '${c.replacement}'\n`)
  }

  if (!apply) {
    console.log('Dry run. Re-run with --apply to fix these.')
    await prisma.$disconnect()
    return
  }

  let fixed = 0
  const failed: string[] = []
  for (const c of conflicts) {
    const target = `${c.schema}.${c.table}.${c.column}`
    try {
      // Identifiers come from the catalog, not from input, and the replacement
      // is a literal the CHECK already contains — but it is still quoted rather
      // than concatenated raw.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${c.schema}"."${c.table}" ALTER COLUMN "${c.column}" SET DEFAULT '${c.replacement.replace(/'/g, "''")}'`,
      )
      console.log(`  ✅ ${target} → '${c.replacement}'`)
      fixed++
    } catch (err) {
      console.log(`  ❌ ${target}: ${err instanceof Error ? err.message : String(err)}`)
      failed.push(target)
    }
  }

  console.log(`\nFixed ${fixed}/${conflicts.length}.`)

  // Re-read rather than trust the ALTERs: the bug being repaired is one that
  // reported success while producing a table that rejected its own inserts.
  const remaining = await findConflicts()
  if (remaining.length > 0) {
    console.error(`\n${remaining.length} still conflicting.`)
    await prisma.$disconnect()
    process.exit(1)
  }
  console.log('Verified: every column default now satisfies its CHECK constraint.')

  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
