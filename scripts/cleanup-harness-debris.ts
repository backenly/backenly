/**
 * Remove tables left behind by verification runs.
 *
 * The MCP harness and probe verification create tables and cannot drop them —
 * destructive operations route to the human Review Queue by design. That is
 * correct for agents and inconvenient for maintenance, so this is the deliberate
 * owner-run escape hatch.
 *
 * SAFETY: operates on a strict ALLOWLIST of prefixes this tooling is known to
 * create. It can never drop an application table, because a table it does not
 * recognise is skipped rather than judged. Dry-run is the default; --apply is
 * required to execute, and every statement is printed.
 *
 *   npx tsx scripts/cleanup-harness-debris.ts --project <id>
 *   npx tsx scripts/cleanup-harness-debris.ts --project <id> --apply
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Prefixes created by verification tooling. Anchored with ^ so a real table
 * merely CONTAINING one of these strings is never matched — the substring
 * collisions that produced 'start_date' -> INTEGER and /account/ matching
 * "g_accounts" are the reason this is anchored rather than a `includes`.
 */
const DEBRIS_PATTERNS: RegExp[] = [
  /^hx_[a-z0-9]{6}_/,        // MCP harness runs
  /^pp_\d+_/,                // probe-proof tables
  /^ix_\d+$/,                // add_column index checks
  /^intent_demo_\d+$/,       // intent-ledger demo
  /^probe_proof_\d+$/,       // sensor-health proof
  /^mcp_verify_check$/,      // one-off end-to-end check
]

function isDebris(name: string): boolean {
  return DEBRIS_PATTERNS.some((p) => p.test(name))
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const projectId = arg('--project')
  const apply = process.argv.includes('--apply')

  if (!projectId) {
    console.error('Missing --project <projectId>')
    process.exit(2)
  }

  const schema = `workspace_${projectId}`

  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    schema,
  )

  const all = rows.map((r) => r.table_name)
  const debris = all.filter(isDebris)
  const kept = all.filter((t) => !isDebris(t))

  console.log(`\n  schema   ${schema}`)
  console.log(`  tables   ${all.length} total · ${debris.length} debris · ${kept.length} kept\n`)

  console.log('  KEEPING (not created by verification tooling):')
  for (const t of kept) console.log(`    · ${t}`)

  if (debris.length === 0) {
    console.log('\n  Nothing to remove.\n')
    await prisma.$disconnect()
    return
  }

  console.log(`\n  ${apply ? 'DROPPING' : 'WOULD DROP'} ${debris.length} table(s):`)
  for (const t of debris) console.log(`    × ${t}`)

  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply to execute.\n')
    await prisma.$disconnect()
    return
  }

  let dropped = 0
  for (const table of debris) {
    try {
      // Identifier is allowlist-matched above, never interpolated user input.
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${table}" CASCADE`)
      dropped++
    } catch (err: any) {
      console.error(`    ! ${table}: ${err?.message}`)
    }
  }

  // Platform-side projections must go too, or list_tables and the API-coverage
  // probe keep reporting tables that no longer exist.
  const tableRows = await prisma.table.findMany({
    where: { projectId },
    select: { id: true, name: true },
  })
  const debrisIds = tableRows.filter((t) => isDebris(t.name)).map((t) => t.id)

  const apis = await prisma.apiDefinition.deleteMany({
    where: { projectId, tableId: { in: debrisIds } },
  }).catch(() => ({ count: 0 }))
  const metas = await prisma.table.deleteMany({
    where: { id: { in: debrisIds } },
  }).catch(() => ({ count: 0 }))
  const intents = await prisma.schemaIntent.deleteMany({
    where: { projectId, tableName: { in: debris } },
  }).catch(() => ({ count: 0 }))

  console.log(
    `\n  Dropped ${dropped} table(s); removed ${apis.count} API definition(s), ` +
    `${metas.count} table record(s), ${intents.count} intent row(s).\n`,
  )

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('cleanup failed:', err instanceof Error ? err.message : err)
  await prisma.$disconnect()
  process.exit(1)
})
