/**
 * Register every workspace schema PostgREST was never told about.
 *
 * ── What this repairs ───────────────────────────────────────────────────────
 *
 * `backenly_pgrst_register_schema()` shipped with the Phase 3 cutover and was
 * called by the migration script and by no application code whatsoever. Every
 * project created after the cutover therefore has a schema PostgREST does not
 * serve, and its entire `/db/*` plane answers
 *
 *   PGRST106  Invalid schema: workspace_<id>
 *
 * on every table. `/auth/*` and `/fn/*` run on the Express runtime and keep
 * working, so the project looks alive and the failure gets attributed to the
 * caller's code.
 *
 * The code fix is threefold — registration on every creation path, an event
 * trigger on CREATE SCHEMA, and a runtime self-heal on PGRST106 — but none of
 * those retroactively fix a project that already exists and is already broken.
 * This does.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * Idempotent and additive. It registers schemas that exist and are missing from
 * the list; it never unregisters, never drops, never touches rows. Registration
 * itself grants the data-plane roles, re-revokes `users` and `_`-prefixed
 * tables, and applies the soft-delete and owner-default policies — so a
 * repaired project lands in exactly the state a freshly created one would.
 *
 *   npx tsx scripts/repair-postgrest-registrations.ts          # report only
 *   npx tsx scripts/repair-postgrest-registrations.ts --apply  # repair
 */

import { prisma } from '../lib/db'
import {
  unregisteredSchemas,
  reconcileAllSchemas,
  registeredOrphans,
  unregisterSchema,
} from '../lib/postgrest/registration'
import { probePostgrest } from '../lib/postgrest/health'

/**
 * Say what a deleted project is still holding, and stop short of deleting it.
 *
 * Unregistering is reversible and touches no row, so this script does it.
 * DROPPING the schema destroys real end-user records — on production one of
 * these held 10 accounts with their password hashes — and that is a retention
 * decision with legal weight: those people signed up to a product that no
 * longer exists. A repair script whose job is registration must not make it.
 */
function reportRetainedData(
  orphans: Array<{ schema: string; projectId: string; tables: string[]; rows: number }>,
): void {
  if (orphans.length === 0) return
  const withData = orphans.filter(o => o.rows > 0)

  console.log(
    `\n${orphans.length} schema(s) outlived their project. No longer exposed, but they still ` +
    `exist and still hold data:`,
  )
  for (const o of orphans) {
    console.log(`  ${o.schema} — ${o.rows} row(s) across ${o.tables.length} table(s)`)
  }
  if (withData.length > 0) {
    console.log(
      `\n  ${withData.length} of them contain END-USER RECORDS (emails, password hashes) for a\n` +
      `  project that no longer exists — personal data with no owner and no retention policy.\n` +
      `  Dropping it is destructive and irreversible, so it is left to you:\n\n` +
      `    DROP SCHEMA "<schema>" CASCADE;\n`,
    )
  }
}

async function main() {
  const apply = process.argv.includes('--apply')

  const status = await probePostgrest()
  console.log(`PostgREST: ${status.state}`)
  if (status.state === 'schema_cache_failed') {
    // Registering into a wedged cache accomplishes nothing and the reload it
    // issues will not clear the wedge — that needs a process restart. Say so
    // rather than reporting a repair that cannot have taken effect.
    console.error(
      '\nThe schema cache is wedged. Prune dangling registrations and restart ' +
      'PostgREST first:\n  pm2 restart backenly-postgrest\n',
    )
    process.exit(1)
  }

  // ── Registered schemas whose project is gone ───────────────────────────────
  //
  // Checked FIRST, because it is the one state neither existing probe covers:
  // the schema exists (so the dangling probe is satisfied) and it is registered
  // (so the unregistered probe is satisfied) — but the project row is gone, and
  // PostgREST is serving a deleted project's schema.
  const orphans = await registeredOrphans()
  if (orphans.length > 0) {
    console.log(
      `\n${orphans.length} REGISTERED schema(s) have no project — PostgREST is exposing ` +
      `a deleted project's schema.\n`,
    )
    for (const o of orphans) {
      console.log(`  ${o.schema}`)
      console.log(`    tables: ${o.tables.join(', ') || 'none'} · rows retained: ${o.rows}`)
    }
    if (apply) {
      // Unregistering only. It is fully reversible and touches no row. DROPPING
      // the schema is destructive and stays a human decision — see the note at
      // the end of this run.
      for (const o of orphans) {
        await unregisterSchema(o.schema)
        console.log(`  ✅ unregistered ${o.schema}`)
      }
    } else {
      console.log('\n  (--apply will unregister these. It does NOT drop them or touch any row.)')
    }
  }

  const missing = await unregisteredSchemas()

  if (missing.length === 0) {
    console.log(
      orphans.length === 0
        ? '\nEvery workspace schema is registered. Nothing to repair.'
        : '\nEvery live project\'s schema is registered.',
    )
    reportRetainedData(orphans)
    await prisma.$disconnect()
    return
  }

  // Name the owners: an operator needs to know whose backend has been down,
  // not just how many.
  const projectIds = missing
    .map(s => s.replace(/^workspace_/, ''))
    .filter(id => /^[0-9a-f-]{36}$/i.test(id))
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true, createdAt: true },
      })
    : []
  const byId = new Map(projects.map(p => [p.id, p]))

  console.log(`\n${missing.length} workspace schema(s) are NOT registered with PostgREST.`)
  console.log('Their /db/* data plane is returning PGRST106 for every table.\n')
  for (const schema of missing) {
    const id = schema.replace(/^workspace_/, '')
    const p = byId.get(id)
    console.log(
      `  ${schema}` +
      (p ? `  — "${p.name}" (created ${p.createdAt.toISOString().slice(0, 10)})` : '  — no project row'),
    )
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to register these.')
    await prisma.$disconnect()
    return
  }

  console.log('\nRegistering…')
  const result = await reconcileAllSchemas()

  for (const schema of result.repaired) console.log(`  ✅ ${schema}`)
  for (const f of result.failed) console.log(`  ❌ ${f.schema}: ${f.error}`)
  for (const o of result.orphaned) console.log(`  ⏭  ${o} — SKIPPED, no project row`)

  console.log(
    `\nRegistered ${result.repaired.length}/${result.checked}.` +
    (result.failed.length ? ` ${result.failed.length} failed.` : '') +
    (result.orphaned.length ? ` ${result.orphaned.length} skipped as orphaned.` : ''),
  )

  if (result.orphaned.length) {
    // Named, not silently ignored. A schema outliving its project is a real
    // cleanup task and a real cost — it holds tenant data indefinitely. But
    // dropping it is destructive and belongs to a human, not to a repair run
    // whose job is registration.
    console.log(
      `\n${result.orphaned.length} schema(s) have no Project row — their projects were ` +
      `deleted without the schema being dropped. They are deliberately NOT registered: ` +
      `that would publish a deleted project's tables through the data plane. Review and ` +
      `drop them as a separate, considered step.`,
    )
  }

  // Verify rather than assume: the whole class of bug being repaired here is
  // "the call was never made and nobody checked".
  const stillMissing = (await unregisteredSchemas()).filter(s => !result.orphaned.includes(s))
  if (stillMissing.length > 0) {
    console.error(`\n${stillMissing.length} still unregistered: ${stillMissing.join(', ')}`)
    await prisma.$disconnect()
    process.exit(1)
  }
  console.log('Verified: every live project\'s schema is now registered.')
  reportRetainedData(orphans)

  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
