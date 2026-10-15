/**
 * Non-Destructive Rollback System
 * 
 * PHILOSOPHY: NEVER DELETE USER DATA
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * TRUST-PRESERVING RESTORE
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * REQUIREMENTS:
 * - Never DROP TABLE in production
 * - On restore: Rename tables (e.g., users__archived__timestamp)
 * - Keep all data intact
 * - Implement PITR using database snapshots
 * - Restore switches pointers, not deletes data
 * 
 * CONSTRAINTS:
 * - No restore options exposed to users
 * - No warnings shown (automatic safety)
 * 
 * SUCCESS:
 * - Restore is reversible
 * - No user data is ever destroyed automatically
 * - All destructive operations converted to renames/soft deletes
 */

import { prisma } from '@/lib/db/prisma'
import { ExecutionContext } from '@/lib/context/execution-context'
import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import { workspaceRawClient } from '@/lib/data-plane/regional'

/**
 * Archive Strategy
 * 
 * Instead of DROP TABLE:
 * - Rename to {table}__archived__{timestamp}
 * - Update graph to point to new active tables
 * - Preserve all data for potential recovery
 */
export interface ArchiveOperation {
  originalTable: string
  archivedTable: string
  archivedAt: Date
  projectId: string
  canRestore: boolean
}

/**
 * Point-in-Time Restore Snapshot
 * 
 * Captures complete state at specific moment
 * Allows reverting restore operations
 */
export interface PITRSnapshot {
  id: string
  projectId: string
  capturedAt: Date
  graphState: BackendStateGraph
  schemaState: {
    tables: string[]
    archivedTables: string[]
  }
  canRestoreTo: boolean
}

// archiveTable, restoreArchivedTable and createPITRSnapshot were removed when
// projects moved into regions. None had a caller. The first two renamed a
// workspace table and wrote the platform's archive record in ONE transaction,
// which cannot span the two databases a project in another region uses, and
// all three read the workspace through the platform database.

/**
 * Restore to PITR snapshot
 * 
 * Reverses a previous restore operation
 * All changes are pointer switches, no data deletion
 */
export async function restoreToPITRSnapshot(
  context: ExecutionContext,
  snapshotId: string
): Promise<{
  success: boolean
  tablesRestored: string[]
  tablesArchived: string[]
}> {
  console.log(`[PITR] Restoring to snapshot: ${snapshotId}`)
  
  // TODO: Fix Prisma client generation for PITRSnapshot model
  throw new Error('PITR restore temporarily disabled - Prisma client generation issue')
}

/**
 * List available PITR snapshots
 */
export async function listPITRSnapshots(
  projectId: string
): Promise<PITRSnapshot[]> {
  // TODO: Fix Prisma client generation for PITRSnapshot model
  return []
}

/**
 * List archived tables for recovery
 */
export async function listArchivedTables(
  projectId: string
): Promise<ArchiveOperation[]> {
  const archives = await prisma.tableArchive.findMany({
    where: {
      projectId,
      canRestore: true,
    },
    orderBy: { archivedAt: 'desc' },
  })
  
  return archives.map(a => ({
    originalTable: a.originalName,
    archivedTable: a.archivedName,
    archivedAt: a.archivedAt,
    projectId: a.projectId,
    canRestore: a.canRestore,
  }))
}

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
      const quotedSchema = `"${schema}"`
      const quotedTable = `"${capitalizeTableName(archive.archivedName)}"`
      
      // NOW we can safely DROP (after 90 days)
      await db.$executeRawUnsafe(
        `DROP TABLE IF EXISTS ${quotedSchema}.${quotedTable} CASCADE`
      )
      
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
