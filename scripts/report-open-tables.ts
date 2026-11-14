/**
 * report-open-tables.ts — which projects have tables without row-level security.
 *
 * Read-only. Every workspace table is granted to the REST API's roles (anon
 * reads; authenticated reads and writes: scripts/sql/postgrest-ddl-sync.sql),
 * so a table with row-level security off is readable with the app's
 * publishable key and writable by any signed-in end user. New tables Backenly
 * cannot find an owner for now start closed (lib/services/workspace-rls.ts,
 * autoApplyRlsIfNeeded); tables created before that may still be open. Closing
 * them for their owners could break an app that reads them today, so this
 * lists them, for the owners to be told and to choose each table's rule.
 *
 *   npx tsx scripts/report-open-tables.ts                 # every project
 *   npx tsx scripts/report-open-tables.ts --project <uuid>
 *
 * Prints one line per open table: project, owner's email, table, estimated rows.
 */
import { prisma } from '@/lib/db'

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
  let open = 0
  let affected = 0
  let failed = 0
  for (const p of projects) {
    try {
      const schema = await resolveWorkspaceSchema(p.id)
      const db = await workspaceRawClient(p.id)
      const rows = await db.$queryRawUnsafe<Array<{ table: string; rows: number }>>(
        `SELECT c.relname AS "table", GREATEST(c.reltuples, 0)::float8 AS rows
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
            AND c.relname NOT LIKE '\\_%'
          ORDER BY 1`,
        schema,
      )
      if (rows.length) affected++
      for (const r of rows) {
        open++
        console.log(`${p.id}\t${p.user?.email ?? '-'}\t${r.table}\t~${Math.round(Number(r.rows))} rows`)
      }
    } catch (err) {
      failed++
      console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${open} table(s) without row-level security in ${affected} of ${projects.length} project(s)` +
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
