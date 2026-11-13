/**
 * report-grant-tables.ts — tables whose rows grant access and whose users write them.
 *
 * Read-only. A table whose rows grant access (roles, memberships, permissions,
 * invitations: isGrantTable in lib/services/rls-ownership.ts) now gets
 * owner_read_only when Backenly creates it. Tables created before that kept
 * own_rows or party_rows, which let an end user insert the row that grants
 * them access. Switching them could break an app that writes them from the
 * browser today, so this lists them for their owners.
 *
 *   npx tsx scripts/report-grant-tables.ts                 # every project
 *   npx tsx scripts/report-grant-tables.ts --project <uuid>
 *
 * Prints one line per table: project, owner's email, table, its rule.
 */
import { prisma } from '@/lib/db'
import { isGrantTable } from '@/lib/services/rls-ownership'

const flag = process.argv.indexOf('--project')
const ONLY = flag > -1 ? process.argv[flag + 1] : null

async function main(): Promise<void> {
  const { workspaceRawClient } = await import('@/lib/data-plane/regional')
  const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
  const projects = await prisma.project.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  })
  let found = 0
  let failed = 0
  for (const p of projects) {
    try {
      const schema = await resolveWorkspaceSchema(p.id)
      const db = await workspaceRawClient(p.id)
      const rows = await db.$queryRawUnsafe<Array<{ table: string; rule: string }>>(
        `SELECT DISTINCT tablename AS "table",
                CASE WHEN policyname LIKE 'backenly_party_rows%' THEN 'party_rows' ELSE 'own_rows' END AS rule
           FROM pg_policies
          WHERE schemaname = $1
            AND (policyname LIKE 'backenly_own_rows\\_%' AND policyname NOT LIKE 'backenly_own_rows_read%'
                 OR policyname LIKE 'backenly_party_rows%')
          ORDER BY 1`,
        schema,
      )
      for (const r of rows.filter((r) => isGrantTable(r.table))) {
        found++
        console.log(`${p.id}\t${p.user?.email ?? '-'}\t${r.table}\t${r.rule}`)
      }
    } catch (err) {
      failed++
      console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${found} table(s) whose rows grant access and whose users can write them, across ${projects.length} project(s)` +
      (failed ? `; ${failed} project(s) could not be read` : '') + '.',
  )
  if (failed) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
