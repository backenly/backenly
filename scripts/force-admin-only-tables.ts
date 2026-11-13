/**
 * force-admin-only-tables.ts — hold every existing admin_only table to its rule.
 *
 * admin_only ("only service-role API keys can access this table") did not force
 * row-level security, unlike every other template. PostgreSQL exempts a table's
 * owner, and every member of the owning role, from rules that are not forced,
 * and Backenly's own code reads workspace tables as that role with the end
 * user's identity in the session: realtime's per-change visibility check and
 * functions' ctx.db. New admin_only tables are forced
 * (lib/services/workspace-rls.ts); this brings the existing ones in line.
 *
 * Production schemas change as one governed change per project, attributed to
 * Backenly, so each project's history shows it. Active preview branches are
 * forced too. Forcing changes nothing for service-role keys or for the REST
 * API's own roles, which were already held to the rule.
 *
 *   npx tsx scripts/force-admin-only-tables.ts                    # report only
 *   npx tsx scripts/force-admin-only-tables.ts --apply            # every project
 *   npx tsx scripts/force-admin-only-tables.ts --apply --project <uuid>
 */
import { prisma } from '@/lib/db'
import { forceAdminOnlyTables } from '@/lib/services/workspace-rls'

const APPLY = process.argv.includes('--apply')
const flag = process.argv.indexOf('--project')
const ONLY = flag > -1 ? process.argv[flag + 1] : null

async function main(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  let tables = 0
  let failed = 0
  for (const { id } of projects) {
    try {
      const found = await forceAdminOnlyTables(id, { apply: APPLY })
      for (const f of found) {
        tables += f.tables.length
        console.log(`${id} ${f.schema}: ${f.tables.join(', ')}${f.forced ? ' — forced' : ''}`)
      }
    } catch (err) {
      failed++
      console.error(`${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${APPLY ? 'Forced' : 'Found'} ${tables} admin_only table(s) without forced row-level security across ${projects.length} project(s)` +
      (failed ? `; ${failed} project(s) could not be checked` : '') +
      (APPLY ? '.' : '. Run with --apply to force them.'),
  )
  if (failed) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
