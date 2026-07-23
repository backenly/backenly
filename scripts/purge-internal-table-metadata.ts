/**
 * One-time cleanup: remove reserved internal tables that leaked into PLATFORM
 * METADATA (prisma.table, api_definitions, permission_policies, app_triggers).
 *
 * WHY THIS EXISTS
 * ---------------
 * The auth runtime creates plumbing tables via raw SQL (_email_verifications,
 * _token_blacklist, _magic_links, _password_resets). A schema-reconciliation
 * back-fill in the executor then registered ANY live table not already in
 * prisma.table — with a filter that only excluded `_backenly_%`. So these
 * leading-underscore auth tables were registered as PRODUCT tables. From there
 * they inflated the dashboard table count, and the autonomy loop generated REST
 * APIs on them ("Backenly fixed missing api on _token_blacklist") — exposing
 * unprotected auth-token tables over HTTP.
 *
 * The source is now fixed (the reconciler + every reader use the canonical
 * `isReservedWorkspaceTable` predicate, and the runtime executor refuses to
 * serve reserved tables). This script clears the historical metadata backlog
 * once, for every project.
 *
 * SAFETY: it only ever touches rows whose table name is reserved
 * (`isReservedWorkspaceTable` — leading underscore / pg_ / information_schema).
 * Real product tables (posts, comments, users, …) are never matched. Deleting a
 * Table row cascades to its ApiDefinition and ApiUsageLog rows (schema FK
 * onDelete: Cascade). It does NOT touch the live workspace_* data tables — only
 * the platform's metadata rows about them.
 *
 * Run (preview):  npx tsx scripts/purge-internal-table-metadata.ts --dry-run
 * Run (execute):  npx tsx scripts/purge-internal-table-metadata.ts
 * (On prod: ssh into the deployment host, cd to the app directory, run it.)
 */

import { prisma } from '@/lib/db'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  console.log(
    `[PurgeInternalMeta] ${DRY_RUN ? 'DRY RUN — no deletes' : 'LIVE — deleting reserved-table metadata'}\n`,
  )

  const projects = await prisma.project.findMany({ select: { id: true, name: true } })
  console.log(`[PurgeInternalMeta] ${projects.length} projects to sweep\n`)

  const totals = { tables: 0, apiDefs: 0, policies: 0, triggers: 0 }
  let touchedProjects = 0

  for (const p of projects) {
    // 1. Reserved Table rows (deleting these cascades to ApiDefinition + ApiUsageLog).
    const tables = await prisma.table.findMany({
      where: { projectId: p.id },
      select: { id: true, name: true, apiDefinition: { select: { id: true, name: true } } },
    })
    const reservedTables = tables.filter((t) => isReservedWorkspaceTable(t.name))

    // 2. RLS policies + triggers that reference a reserved table name.
    const [policies, triggers] = await Promise.all([
      prisma.permissionPolicy.findMany({
        where: { projectId: p.id },
        select: { id: true, tableName: true },
      }),
      prisma.appTrigger.findMany({
        where: { projectId: p.id },
        select: { id: true, sourceTable: true },
      }),
    ])
    const reservedPolicies = policies.filter((r) => isReservedWorkspaceTable(r.tableName))
    const reservedTriggers = triggers.filter((r) => isReservedWorkspaceTable(r.sourceTable))

    const found =
      reservedTables.length + reservedPolicies.length + reservedTriggers.length
    if (found === 0) continue

    touchedProjects++
    const apiDefCount = reservedTables.filter((t) => t.apiDefinition).length
    const names = reservedTables.map((t) => t.name).join(', ') || '—'
    console.log(
      `  ${DRY_RUN ? '·' : '✓'} ${p.name} [${p.id.slice(0, 8)}…] — ` +
        `tables:${reservedTables.length} (apis:${apiDefCount}) ` +
        `policies:${reservedPolicies.length} triggers:${reservedTriggers.length}  {${names}}`,
    )

    totals.tables += reservedTables.length
    totals.apiDefs += apiDefCount
    totals.policies += reservedPolicies.length
    totals.triggers += reservedTriggers.length

    if (DRY_RUN) continue

    // Delete triggers + policies first (independent), then tables (cascades APIs).
    if (reservedTriggers.length > 0)
      await prisma.appTrigger.deleteMany({ where: { id: { in: reservedTriggers.map((r) => r.id) } } })
    if (reservedPolicies.length > 0)
      await prisma.permissionPolicy.deleteMany({ where: { id: { in: reservedPolicies.map((r) => r.id) } } })
    if (reservedTables.length > 0)
      await prisma.table.deleteMany({ where: { id: { in: reservedTables.map((t) => t.id) } } })
  }

  console.log(`\n[PurgeInternalMeta] ${DRY_RUN ? 'Would clean' : 'Cleaned'}: ${touchedProjects}/${projects.length} projects`)
  if (totals.tables + totals.policies + totals.triggers === 0) {
    console.log('[PurgeInternalMeta] No reserved-table metadata found — nothing to remove.')
  } else {
    console.log(`[PurgeInternalMeta]   tables:        ${totals.tables}`)
    console.log(`[PurgeInternalMeta]   api defs:      ${totals.apiDefs} (cascade)`)
    console.log(`[PurgeInternalMeta]   rls policies:  ${totals.policies}`)
    console.log(`[PurgeInternalMeta]   triggers:      ${totals.triggers}`)
    if (DRY_RUN) console.log('\n[PurgeInternalMeta] Re-run without --dry-run to apply.')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[PurgeInternalMeta] Fatal:', err)
    process.exit(1)
  })
