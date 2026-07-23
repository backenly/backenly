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

import { PrismaClient } from '@prisma/client'
import { ExecutionContext } from '@/lib/context/execution-context'
import { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

const prisma = new PrismaClient()

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

/**
 * Non-destructive table "removal"
 * 
 * INSTEAD OF: DROP TABLE users
 * DO THIS: RENAME TABLE users TO users__archived__1234567890
 * 
 * GUARANTEES:
 * - Data preserved
 * - Restore reversible
 * - No data loss
 */
export async function archiveTable(
  context: ExecutionContext,
  tableName: string,
  reason: 'rollback' | 'schema_change' | 'manual'
): Promise<ArchiveOperation> {
  console.log(`[Non-Destructive] Archiving table: ${tableName} (reason: ${reason})`)
  
  // Get workspace schema
  const workspace = await prisma.workspace.findFirst({
    where: { projectId: context.projectId },
  })
  
  if (!workspace || !workspace.postgresSchema) {
    throw new Error('Workspace not found or not provisioned')
  }
  
  const schema = workspace.postgresSchema
  const timestamp = Date.now()
  const archivedTableName = `${tableName}__archived__${timestamp}`
  
  // Rename table instead of dropping
  const quotedSchema = `"${schema}"`
  const quotedOriginal = `"${capitalizeTableName(tableName)}"`
  const quotedArchived = `"${capitalizeTableName(archivedTableName)}"`
  
  try {
    // Execute rename in transaction
    await prisma.$transaction(async (tx) => {
      // RENAME TABLE instead of DROP TABLE
      await tx.$executeRawUnsafe(
        `ALTER TABLE ${quotedSchema}.${quotedOriginal} RENAME TO ${quotedArchived}`
      )
      
      console.log(`[Non-Destructive] ✅ Renamed ${tableName} → ${archivedTableName}`)
      
      // Record archive operation for potential recovery
      await tx.tableArchive.create({
        data: {
          projectId: context.projectId,
          originalName: tableName,
          archivedName: archivedTableName,
          archivedAt: new Date(),
          reason,
          canRestore: true,
          dataPreserved: true,
        },
      })
    })
    
    return {
      originalTable: tableName,
      archivedTable: archivedTableName,
      archivedAt: new Date(),
      projectId: context.projectId,
      canRestore: true,
    }
  } catch (error) {
    console.error(`[Non-Destructive] Failed to archive table ${tableName}:`, error)
    throw new Error(`Failed to archive table: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Restore archived table
 * 
 * Reverses archiveTable operation
 * Renames archived table back to original name
 */
export async function restoreArchivedTable(
  context: ExecutionContext,
  archivedTableName: string,
  originalTableName: string
): Promise<void> {
  console.log(`[Non-Destructive] Restoring table: ${archivedTableName} → ${originalTableName}`)
  
  const workspace = await prisma.workspace.findFirst({
    where: { projectId: context.projectId },
  })
  
  if (!workspace || !workspace.postgresSchema) {
    throw new Error('Workspace not found')
  }
  
  const schema = workspace.postgresSchema
  const quotedSchema = `"${schema}"`
  const quotedArchived = `"${capitalizeTableName(archivedTableName)}"`
  const quotedOriginal = `"${capitalizeTableName(originalTableName)}"`
  
  try {
    await prisma.$transaction(async (tx) => {
      // Check if target name is already taken
      const existing = await tx.$queryRawUnsafe<any[]>(
        `SELECT 1 FROM information_schema.tables 
         WHERE table_schema = $1 AND table_name = $2`,
        schema,
        capitalizeTableName(originalTableName)
      )
      
      if (existing.length > 0) {
        // Archive the current table first
        const tempArchive = `${originalTableName}__replaced__${Date.now()}`
        const quotedTemp = `"${capitalizeTableName(tempArchive)}"`
        
        await tx.$executeRawUnsafe(
          `ALTER TABLE ${quotedSchema}.${quotedOriginal} RENAME TO ${quotedTemp}`
        )
        
        console.log(`[Non-Destructive] Existing table archived: ${originalTableName} → ${tempArchive}`)
      }
      
      // Rename archived table back to original
      await tx.$executeRawUnsafe(
        `ALTER TABLE ${quotedSchema}.${quotedArchived} RENAME TO ${quotedOriginal}`
      )
      
      console.log(`[Non-Destructive] ✅ Restored ${archivedTableName} → ${originalTableName}`)
      
      // Update archive record
      await tx.tableArchive.updateMany({
        where: {
          projectId: context.projectId,
          archivedName: archivedTableName,
        },
        data: {
          restoredAt: new Date(),
          canRestore: false,
        },
      })
    })
  } catch (error) {
    console.error(`[Non-Destructive] Failed to restore table:`, error)
    throw new Error(`Failed to restore table: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Create Point-in-Time Restore Snapshot
 * 
 * Captures complete state before restore operation
 * Allows rolling back the rollback
 */
export async function createPITRSnapshot(
  context: ExecutionContext,
  currentState: BackendStateGraph
): Promise<PITRSnapshot> {
  console.log(`[PITR] Creating snapshot for project ${context.projectId}`)
  
  const workspace = await prisma.workspace.findFirst({
    where: { projectId: context.projectId },
  })
  
  if (!workspace || !workspace.postgresSchema) {
    throw new Error('Workspace not found')
  }
  
  // Get current tables
  const schema = workspace.postgresSchema
  const tables = await prisma.$queryRawUnsafe<any[]>(
    `SELECT table_name FROM information_schema.tables 
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    schema
  )
  
  const tableNames = tables.map(t => t.table_name)
  const archivedTables = tableNames.filter(t => t.includes('__archived__'))
  const activeTables = tableNames.filter(t => !t.includes('__archived__'))
  
  const snapshotId = `pitr_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
  
  // TODO: Fix Prisma client generation for PITRSnapshot model
  console.log(`[PITR] Snapshot creation temporarily disabled`)
  
  return {
    id: snapshotId,
    projectId: context.projectId,
    capturedAt: new Date(),
    graphState: currentState,
    schemaState: {
      tables: activeTables,
      archivedTables: archivedTables,
    },
    canRestoreTo: false, // Disabled
  }
  
  /* Disabled until Prisma model is available
  // Store snapshot
  const snapshot = await prisma.pitrSnapshot.create({
    data: {
      id: snapshotId,
      projectId: context.projectId,
      capturedAt: new Date(),
      graphState: currentState as any, // JSON
      schemaState: {
        tables: activeTables,
        archivedTables: archivedTables,
      },
      canRestoreTo: true,
    },
  })
  
  console.log(`[PITR] ✅ Snapshot created: ${snapshotId}`)
  
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    capturedAt: snapshot.capturedAt,
    graphState: snapshot.graphState as BackendStateGraph,
    schemaState: snapshot.schemaState as any,
    canRestoreTo: snapshot.canRestoreTo,
  }
  */
}

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
  let deletedTables = 0
  
  for (const archive of oldArchives) {
    try {
      const quotedSchema = `"${schema}"`
      const quotedTable = `"${capitalizeTableName(archive.archivedName)}"`
      
      // NOW we can safely DROP (after 90 days)
      await prisma.$executeRawUnsafe(
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
