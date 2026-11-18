/**
 * report-tables-opened-by-name.ts — tables readable by everyone that Backenly's
 * catalog rule would no longer open.
 *
 * Read-only. Backenly gives a table with no owner it can find public reads
 * (backenly_public_read_*: reads open, writes service-role only) when the
 * table is reference data. It used to decide that from the FIRST word of the
 * name as well as the last, so `product_views` (sessions and referrers of
 * product views) was opened like `products`. New tables now follow the last
 * word, and never open by name when a column records people or visits
 * (lib/services/rls-ownership.ts). Tables opened before that keep their
 * policies. Closing them for their owners could break an app that reads them
 * today, and some may have been opened on purpose, so this lists them, for the
 * owners to be told and to choose each table's rule.
 *
 *   npx tsx scripts/report-tables-opened-by-name.ts                 # every project
 *   npx tsx scripts/report-tables-opened-by-name.ts --project <uuid>
 *
 * Prints one line per table: project, owner's email, table, estimated rows,
 * and why the rule would not open it now.
 */
import { prisma } from '@/lib/db'

const flag = process.argv.indexOf('--project')
const ONLY = flag > -1 ? process.argv[flag + 1] : null

async function main(): Promise<void> {
  const { workspaceRawClient } = await import('@/lib/data-plane/regional')
  const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
  const { loadOwnershipCatalog, inferRlsPlanFromCatalog } = await import('@/lib/services/rls-ownership')
  const projects = await prisma.project.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  })
  let listed = 0
  let affected = 0
  let failed = 0
  for (const p of projects) {
    try {
      const schema = await resolveWorkspaceSchema(p.id)
      const db = await workspaceRawClient(p.id)
      const open = await db.$queryRawUnsafe<Array<{ table: string; rows: number }>>(
        `SELECT c.relname AS "table", GREATEST(c.reltuples, 0)::float8 AS rows
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
            AND EXISTS (SELECT 1 FROM pg_policies pol
                         WHERE pol.schemaname = n.nspname AND pol.tablename = c.relname
                           AND pol.policyname = 'backenly_public_read_select')
          ORDER BY 1`,
        schema,
      )
      if (!open.length) continue
      const catalog = await loadOwnershipCatalog(p.id, schema)
      let here = 0
      for (const t of open) {
        const plan = inferRlsPlanFromCatalog(catalog, t.table)
        if (plan.kind === 'public_read') continue
        here++
        listed++
        console.log(`${p.id}\t${p.user?.email ?? '-'}\t${t.table}\t~${Math.round(Number(t.rows))} rows\t${plan.reason}`)
      }
      if (here) affected++
    } catch (err) {
      failed++
      console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${listed} table(s) readable by everyone that the catalog rule would not open now, in ${affected} of ${projects.length} project(s)` +
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
