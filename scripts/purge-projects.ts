/**
 * Delete projects properly — Prisma rows AND the workspace schema.
 *
 *   npx tsx scripts/purge-projects.ts                 # dry run
 *   npx tsx scripts/purge-projects.ts --apply
 *
 * scripts/delete-projects.ts (the older one) deletes only the Prisma row. That
 * leaves the `workspace_<id>` schema behind, and an orphaned schema is not a
 * cosmetic leftover: if it is still in PostgREST's `db-schemas`, the cache
 * rebuild fails and EVERY project — not just this one — starts answering
 *
 *   503 {"code":"PGRST002","message":"Could not query the database for the
 *        schema cache. Retrying."}
 *
 * So the schema goes too. Dropping it also fires `backenly_pgrst_on_schema_drop`,
 * which prunes the registry automatically, so the two can never disagree.
 *
 * The list below is an explicit DELETE list, not a keep-list. A typo in a
 * delete-list means something survives that should have gone — annoying. A typo
 * in a keep-list means something is destroyed that should have survived. Only
 * one of those is recoverable.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * 2026-07-21: QA debris + empty shells, cleared so the legacy data plane has no
 * remaining users and can be deleted. The four real projects (social media app,
 * AI App Generator, Founder Outreach Backend, Movie Review Platform) are
 * migrated to PostgREST instead — migrating real schemas of 12-23 tables is
 * evidence the cutover works; deleting them would have destroyed that evidence.
 */
const DELETE_IDS = [
  // Empty shells (0 tables)
  '53d03559-32bd-4171-9167-b159c6bed1b8', // Expense Tracker
  '438f5540-3c5f-4278-b3f9-f713ccdf2ce6', // Expense Tracker
  '74437050-eaf8-46fa-9ba9-53cf1a673538', // E-commerce Store
  // QA harness debris
  '1a6e1e83-dbc8-4ceb-af71-5637385be734',
  'c70c8e4f-229f-47fc-8f6d-afc3ec81c3ec',
  'f3621663-c71a-410a-8eb2-d6753c398cee',
  'f9c67fcc-f967-4a04-8b7e-ae2fcaaeec3d',
  '4c19c4b7-a40e-4722-bb66-26e669dc20fe',
  '5b76d9c5-ee76-4d83-aa65-ae1bc485dd2e',
  'a37fdb61-541f-4812-8af9-24234f6bbd28',
  '611aa216-93f2-479e-98b3-aaf83c3ec645',
  'c4a7b653-e5c6-4600-b571-1bbcc10eb3a2',
  'c15fcc0c-1b32-4486-90c9-65fe4f4f487e',
  '1865b215-471c-4e23-90d9-7d68bb770436',
  'b78b2c5a-dccd-4fc5-ac3d-b96bc7b2d3aa',
  'df9038fb-540b-45fd-a207-9c648d10a476', // QA Test Project
]

async function main() {
  const apply = process.argv.includes('--apply')

  const found = await prisma.project.findMany({
    where: { id: { in: DELETE_IDS } },
    select: { id: true, name: true },
  })
  const missing = DELETE_IDS.filter(id => !found.some(p => p.id === id))

  console.log(`\n  targeted   ${DELETE_IDS.length}`)
  console.log(`  found      ${found.length}`)
  if (missing.length) console.log(`  not found  ${missing.length} (already gone)`)
  for (const p of found) console.log(`    - ${p.name} (${p.id})`)

  const survivors = await prisma.project.count({ where: { id: { notIn: DELETE_IDS } } })
  console.log(`\n  will survive: ${survivors} project(s)`)

  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply.\n')
    await prisma.$disconnect()
    return
  }

  let ok = 0
  for (const p of found) {
    const schema = `workspace_${p.id}`
    try {
      // Schema first. If the row went first and this failed, the schema would be
      // orphaned with nothing left pointing at it to retry from.
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await prisma.project.delete({ where: { id: p.id } })
      ok++
      console.log(`  ✓ ${p.name}`)
    } catch (err) {
      console.error(`  ✗ ${p.name}: ${err instanceof Error ? err.message : err}`)
    }
  }

  const left = await prisma.project.count()
  console.log(`\n  deleted ${ok}/${found.length} · ${left} project(s) remain\n`)
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
