/**
 * Expiring the table archives the old rollback system left behind.
 *
 * That system renamed a dropped table to <name>__archived__<time> and wrote a
 * TableArchive row; restoring meant renaming it back or asking for a
 * point-in-time snapshot, which was never implemented. Nothing archives tables
 * that way now: data a change removes is kept in that change's vault and comes
 * back by restoring the state before the change (lib/changes). What is left is
 * the cron that drops archives once their retention has passed.
 */

import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'

/**
 * Permanently delete old archives (>90 days)
 * 
 * ONLY AFTER LONG RETENTION PERIOD
 * User data preserved for 90 days minimum
 */
export async function cleanupOldArchives(
  projectId: string,
  retentionDays: number = 90
): Promise<{
  deletedTables: number
  bytesFreed: number
}> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  
  const oldArchives = await prisma.tableArchive.findMany({
    where: {
      projectId,
      archivedAt: { lt: cutoff },
      canRestore: true,
    },
  })
  
  console.log(`[Cleanup] Found ${oldArchives.length} archives older than ${retentionDays} days`)
  
  if (oldArchives.length === 0) {
    return { deletedTables: 0, bytesFreed: 0 }
  }
  
  const workspace = await prisma.workspace.findFirst({
    where: { projectId },
  })
  
  if (!workspace || !workspace.postgresSchema) {
    throw new Error('Workspace not found')
  }
  
  const schema = workspace.postgresSchema
  // The archived tables are in the project's region; their records are platform
  // rows. Dropped through the platform database, the DROP ... IF EXISTS found
  // nothing, succeeded, and the archive was marked deleted while its table and
  // data stayed in the region past their retention.
  const db = await workspaceRawClient(projectId)
  let deletedTables = 0
  
  for (const archive of oldArchives) {
    try {
      // The retired writer quoted the name capitalised when it renamed the
      // table (capitalizeTableName), so that is normally the table's name; the
      // name as recorded is the other candidate. Whichever is there is dropped.
      const candidates = [...new Set([capitalizeTableName(archive.archivedName), archive.archivedName])]
      const present = await db.$queryRawUnsafe<Array<{ relname: string }>>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')`,
        schema,
        candidates,
      )
      for (const { relname } of present) {
        // Without CASCADE: a view or a foreign key that still reads the table
        // makes the DROP fail, and the archive stays, named in the log below,
        // instead of taking the reader with it (lib/changes/dependents.ts).
        await db.$executeRawUnsafe(`DROP TABLE "${schema}"."${relname}"`)
      }
      
      // Mark as deleted
      await prisma.tableArchive.update({
        where: { id: archive.id },
        data: {
          canRestore: false,
          deletedAt: new Date(),
        },
      })
      
      deletedTables++
      console.log(`[Cleanup] Deleted old archive: ${archive.archivedName}`)
    } catch (error) {
      console.error(`[Cleanup] Failed to delete ${archive.archivedName}:`, error)
    }
  }
  
  return {
    deletedTables,
    bytesFreed: 0, // Would calculate from table sizes
  }
}

/**
 * Helper: Capitalize table name (PostgreSQL convention)
 */
function capitalizeTableName(name: string): string {
  if (!name) return name
  return name.charAt(0).toUpperCase() + name.slice(1)
}
