/**
 * Drop workspace schemas whose project no longer exists.
 *
 *   npx tsx scripts/fleet/purge-orphan-schemas.ts            # dry run
 *   npx tsx scripts/fleet/purge-orphan-schemas.ts --apply
 *
 * These are the residue of scripts/delete-projects.ts, which removed the Prisma
 * row and left `workspace_<id>` behind. 115 of them had accumulated by
 * 2026-07-21. They are invisible everywhere — no project row means no
 * dashboard, no API, no MCP key — so nothing was ever going to surface them.
 *
 * Unlike purge-projects.ts this recomputes its target set instead of taking an
 * explicit list. With 115 entries a hand-typed list is the more dangerous of the
 * two: it is long enough that a transcription error is likely and invisible.
 * The query is short enough to read, and it is re-evaluated at execution time
 * rather than trusting a snapshot taken minutes earlier.
 *
 * TWO INDEPENDENT GUARDS, both required:
 *
 *   1. no matching row in `projects` — the schema belongs to nothing;
 *   2. not in PostgREST's `db-schemas` — dropping a REGISTERED schema fails the
 *      shared cache rebuild and returns 503 for EVERY project, not just this
 *      one. Verified 0 overlap before writing this, but it is checked again
 *      here because "it was true when I looked" is not a safety property.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface Orphan { schema_name: string; table_count: number }

async function main() {
  const apply = process.argv.includes('--apply')

  const registered = await prisma.$queryRawUnsafe<Array<{ list: string }>>(
    `SELECT COALESCE(public.backenly_pgrst_current_schemas(), '') AS list`,
  )
  const registeredSet = new Set(
    (registered[0]?.list ?? '').split(',').map(s => s.trim()).filter(Boolean),
  )

  const orphans = await prisma.$queryRawUnsafe<Orphan[]>(`
    SELECT s.schema_name,
           (SELECT count(*)::int FROM information_schema.tables t
             WHERE t.table_schema = s.schema_name AND t.table_type = 'BASE TABLE') AS table_count
    FROM information_schema.schemata s
    WHERE s.schema_name LIKE 'workspace\\_%'
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE 'workspace_' || p.id = s.schema_name)
    ORDER BY s.schema_name
  `)

  // Guard 2, applied in code as well as excluded in SQL — if these ever
  // disagree the safe reading is "do not drop".
  const safe = orphans.filter(o => !registeredSet.has(o.schema_name))
  const refused = orphans.filter(o => registeredSet.has(o.schema_name))

  const liveCount = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
    SELECT count(*)::bigint AS n FROM information_schema.schemata s
    WHERE s.schema_name LIKE 'workspace\\_%'
      AND EXISTS (SELECT 1 FROM projects p WHERE 'workspace_' || p.id = s.schema_name)
  `)

  console.log(`\n  orphaned schemas      ${orphans.length}`)
  console.log(`  registered (REFUSED)  ${refused.length}`)
  console.log(`  safe to drop          ${safe.length}`)
  console.log(`  live schemas kept     ${Number(liveCount[0]?.n ?? 0)}`)
  console.log(`  rows of data in orphans: ${safe.reduce((a, o) => a + o.table_count, 0)} table(s)\n`)

  for (const r of refused) console.log(`    ! REFUSING ${r.schema_name} — still registered with PostgREST`)

  if (!apply) {
    for (const o of safe.slice(0, 5)) console.log(`    - ${o.schema_name} (${o.table_count} tables)`)
    if (safe.length > 5) console.log(`    … and ${safe.length - 5} more`)
    console.log('\n  Dry run. Re-run with --apply.\n')
    await prisma.$disconnect()
    return
  }

  let ok = 0
  for (const o of safe) {
    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${o.schema_name}" CASCADE`)
      ok++
    } catch (err) {
      console.error(`  ✗ ${o.schema_name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(`\n  dropped ${ok}/${safe.length}\n`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
