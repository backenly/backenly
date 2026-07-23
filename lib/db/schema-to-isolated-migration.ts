/**
 * Schema-to-Isolated Database Migration
 * 
 * CRITICAL: Migration strategy for existing projects
 * 
 * This handles the transition from schema-per-project to physically isolated databases.
 * 
 * SAFETY PRINCIPLES:
 * - Non-destructive by default
 * - Shadow copy for verification
 * - Data integrity checks
 * - Rollback capability
 * - Zero downtime cutover
 * - Opt-in or background execution
 * 
 * DOES NOT AFFECT:
 * - New projects (get isolated databases automatically)
 * - Current operations (backward compatible)
 * 
 * DOES NOT BLOCK:
 * - Platform launch
 * - New features
 * - Production deployment
 */

import { PrismaClient } from '@prisma/client'
import { provisionIsolatedDatabase, getIsolatedPrismaClient } from './isolated-database-manager'
import { prisma } from './postgres'

export interface MigrationStatus {
  projectId: string
  status: 'pending' | 'in_progress' | 'verifying' | 'completed' | 'failed' | 'rolled_back'
  startedAt?: Date
  completedAt?: Date
  schemaName: string
  isolatedDatabaseUrl?: string
  dataVerified: boolean
  error?: string
}

export interface MigrationResult {
  success: boolean
  projectId: string
  dataIntegrityVerified: boolean
  tablesCreated: number
  rowsMigrated: number
  isolatedDatabaseUrl?: string
  error?: string
}

/**
 * Check if project needs migration
 * 
 * Projects with schema-based isolation need migration to physical isolation
 */
export async function needsMigration(projectId: string): Promise<boolean> {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
      select: {
        postgresSchema: true,
        databaseProvisioned: true,
      },
    })
    
    if (!workspace || !workspace.databaseProvisioned) {
      return false // New project or not provisioned yet
    }
    
    // If postgresSchema looks like a schema name (not a database URL), needs migration
    const isSchemaName = workspace.postgresSchema?.startsWith('workspace_') || 
                         workspace.postgresSchema?.startsWith('ws_')
    
    return isSchemaName
    
  } catch (error) {
    console.error('[Migration] Error checking migration status:', error)
    return false
  }
}

/**
 * Migrate single project from schema to isolated database
 * 
 * PHASE 1: Shadow Copy (non-destructive)
 * PHASE 2: Data Verification
 * PHASE 3: Cutover (atomic swap)
 * PHASE 4: Cleanup (optional, delayed)
 */
export async function migrateProjectToIsolatedDatabase(
  projectId: string,
  options: {
    dryRun?: boolean
    skipVerification?: boolean
    cleanupOldSchema?: boolean
  } = {}
): Promise<MigrationResult> {
  const { dryRun = false, skipVerification = false, cleanupOldSchema = false } = options
  
  console.log(`[Migration] Starting migration for project ${projectId}`)
  console.log(`[Migration] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  
  try {
    // Get workspace with current schema
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
      select: {
        id: true,
        projectId: true,
        postgresSchema: true,
      },
    })
    
    if (!workspace || !workspace.postgresSchema) {
      return {
        success: false,
        projectId,
        dataIntegrityVerified: false,
        tablesCreated: 0,
        rowsMigrated: 0,
        error: 'Workspace not found or not provisioned',
      }
    }
    
    const sourceSchemaName = workspace.postgresSchema
    
    // Verify it's actually a schema (not already migrated)
    const isSchemaName = sourceSchemaName.startsWith('workspace_') || sourceSchemaName.startsWith('ws_')
    if (!isSchemaName) {
      console.log(`[Migration] Project ${projectId} already migrated (has database URL)`)
      return {
        success: true,
        projectId,
        dataIntegrityVerified: true,
        tablesCreated: 0,
        rowsMigrated: 0,
      }
    }
    
    if (dryRun) {
      console.log(`[Migration] DRY RUN: Would migrate schema ${sourceSchemaName} to isolated database`)
      return {
        success: true,
        projectId,
        dataIntegrityVerified: false,
        tablesCreated: 0,
        rowsMigrated: 0,
      }
    }
    
    // PHASE 1: Provision isolated database (shadow copy target)
    console.log(`[Migration] Phase 1: Provisioning isolated database for ${projectId}`)
    const isolatedDbResult = await provisionIsolatedDatabase(projectId)
    
    if (!isolatedDbResult.success || !isolatedDbResult.databaseUrl) {
      throw new Error(`Failed to provision isolated database: ${isolatedDbResult.error}`)
    }
    
    const isolatedDatabaseUrl = isolatedDbResult.databaseUrl
    console.log(`[Migration] ✅ Isolated database provisioned: ${isolatedDbResult.databaseId}`)
    
    // PHASE 2: Copy schema structure and data
    console.log(`[Migration] Phase 2: Copying data from schema ${sourceSchemaName}`)
    const copyResult = await copySchemaToIsolatedDatabase(
      sourceSchemaName,
      isolatedDatabaseUrl
    )
    
    if (!copyResult.success) {
      throw new Error(`Failed to copy data: ${copyResult.error}`)
    }
    
    console.log(`[Migration] ✅ Data copied: ${copyResult.tablesCreated} tables, ${copyResult.rowsCopied} rows`)
    
    // PHASE 3: Verification
    if (!skipVerification) {
      console.log(`[Migration] Phase 3: Verifying data integrity`)
      const verifyResult = await verifyDataIntegrity(
        sourceSchemaName,
        isolatedDatabaseUrl
      )
      
      if (!verifyResult.verified) {
        throw new Error(`Data verification failed: ${verifyResult.error}`)
      }
      
      console.log(`[Migration] ✅ Data integrity verified`)
    }
    
    // PHASE 4: Cutover (atomic swap)
    console.log(`[Migration] Phase 4: Performing cutover`)
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        postgresSchema: isolatedDatabaseUrl, // Swap to isolated database URL
      },
    })
    
    console.log(`[Migration] ✅ Cutover complete - project now using isolated database`)
    
    // PHASE 5: Cleanup (optional, can be delayed or manual)
    if (cleanupOldSchema) {
      console.log(`[Migration] Phase 5: Cleaning up old schema ${sourceSchemaName}`)
      // TODO: Cleanup temporarily disabled - implement safe cleanup logic
      console.log(`[Migration] Cleanup skipped - to be implemented`)
    } else {
      console.log(`[Migration] Keeping old schema ${sourceSchemaName} for rollback (cleanup skipped)`)
    }
    
    return {
      success: true,
      projectId,
      dataIntegrityVerified: !skipVerification,
      tablesCreated: copyResult.tablesCreated,
      rowsMigrated: copyResult.rowsCopied,
      isolatedDatabaseUrl,
    }
    
  } catch (error: any) {
    console.error(`[Migration] Migration failed for ${projectId}:`, error)
    
    return {
      success: false,
      projectId,
      dataIntegrityVerified: false,
      tablesCreated: 0,
      rowsMigrated: 0,
      error: error.message || 'Unknown error during migration',
    }
  }
}

/**
 * Copy schema structure and data to isolated database
 */
async function copySchemaToIsolatedDatabase(
  sourceSchemaName: string,
  targetDatabaseUrl: string
): Promise<{ success: boolean; tablesCreated: number; rowsCopied: number; error?: string }> {
  try {
    // Get source Prisma client (main database with schema)
    const sourcePrisma = new PrismaClient()
    
    // Get target Prisma client (isolated database)
    const targetPrisma = new PrismaClient({
      datasources: {
        db: {
          url: targetDatabaseUrl,
        },
      },
    })
    
    try {
      // Get list of tables in source schema
      const tables = await sourcePrisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = ${sourceSchemaName}
          AND table_type = 'BASE TABLE'
      `
      
      let tablesCreated = 0
      let rowsCopied = 0
      
      // For each table:
      // 1. Create table structure in isolated database
      // 2. Copy data
      for (const { table_name } of tables) {
        // Get table DDL from source
        const tableDDL = await sourcePrisma.$queryRaw<Array<{ create_statement: string }>>`
          SELECT 
            'CREATE TABLE ' || quote_ident(table_name) || ' (' ||
            string_agg(
              quote_ident(column_name) || ' ' || 
              udt_name ||
              CASE WHEN character_maximum_length IS NOT NULL 
                   THEN '(' || character_maximum_length || ')' 
                   ELSE '' END ||
              CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END,
              ', '
            ) || ')' as create_statement
          FROM information_schema.columns
          WHERE table_schema = ${sourceSchemaName}
            AND table_name = ${table_name}
          GROUP BY table_name
        `
        
        if (tableDDL.length > 0) {
          // Create table in isolated database
          await targetPrisma.$executeRawUnsafe(tableDDL[0].create_statement)
          tablesCreated++
          
          // Copy data
          const rows = await sourcePrisma.$queryRawUnsafe(
            `SELECT * FROM "${sourceSchemaName}"."${table_name}"`
          )
          
          if (Array.isArray(rows) && rows.length > 0) {
            // Insert rows into target database
            // NOTE: This is simplified - production would use COPY or bulk insert
            for (const row of rows) {
              const columns = Object.keys(row)
              const values = Object.values(row)
              const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
              
              await targetPrisma.$executeRawUnsafe(
                `INSERT INTO "${table_name}" (${columns.join(', ')}) VALUES (${placeholders})`,
                ...values
              )
              rowsCopied++
            }
          }
        }
      }
      
      return {
        success: true,
        tablesCreated,
        rowsCopied,
      }
      
    } finally {
      await sourcePrisma.$disconnect()
      await targetPrisma.$disconnect()
    }
    
  } catch (error: any) {
    return {
      success: false,
      tablesCreated: 0,
      rowsCopied: 0,
      error: error.message,
    }
  }
}

/**
 * Verify data integrity between source and target
 */
async function verifyDataIntegrity(
  sourceSchemaName: string,
  targetDatabaseUrl: string
): Promise<{ verified: boolean; error?: string }> {
  try {
    const sourcePrisma = new PrismaClient()
    const targetPrisma = new PrismaClient({
      datasources: {
        db: {
          url: targetDatabaseUrl,
        },
      },
    })
    
    try {
      // Get table counts from source
      const sourceTables = await sourcePrisma.$queryRawUnsafe<Array<{ table_name: string; row_count: number }>>(
        `SELECT 
          t.table_name,
          (SELECT COUNT(*) FROM "${sourceSchemaName}"."" || t.table_name || "") as row_count
        FROM information_schema.tables t
        WHERE t.table_schema = '${sourceSchemaName}'
          AND t.table_type = 'BASE TABLE'`
      )
      
      // Verify each table in target
      for (const { table_name, row_count } of sourceTables) {
        const targetCount = await targetPrisma.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*) as count FROM "${table_name}"`
        )
        
        if (!targetCount || targetCount[0].count !== row_count) {
          return {
            verified: false,
            error: `Row count mismatch for table ${table_name}: source=${row_count}, target=${targetCount?.[0]?.count || 0}`,
          }
        }
      }
      
      return { verified: true }
      
    } finally {
      await sourcePrisma.$disconnect()
      await targetPrisma.$disconnect()
    }
    
  } catch (error: any) {
    return {
      verified: false,
      error: error.message,
    }
  }
}

/**
 * Cleanup old schema after successful migration
 */
async function cleanupOldSchema(schemaName: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    console.log(`[Migration] Dropped old schema: ${schemaName}`)
  } catch (error) {
    console.error(`[Migration] Failed to cleanup schema ${schemaName}:`, error)
    // Don't throw - cleanup failure is not critical
  }
}

/**
 * Batch migration for multiple projects
 * 
 * Can be run as background job or scheduled task
 */
export async function batchMigrateProjects(
  projectIds: string[],
  options: {
    dryRun?: boolean
    concurrency?: number
    skipVerification?: boolean
  } = {}
): Promise<{
  total: number
  successful: number
  failed: number
  results: MigrationResult[]
}> {
  const { concurrency = 5 } = options
  
  console.log(`[Migration] Starting batch migration for ${projectIds.length} projects`)
  console.log(`[Migration] Concurrency: ${concurrency}`)
  
  const results: MigrationResult[] = []
  
  // Process in batches
  for (let i = 0; i < projectIds.length; i += concurrency) {
    const batch = projectIds.slice(i, i + concurrency)
    
    const batchResults = await Promise.all(
      batch.map(projectId => 
        migrateProjectToIsolatedDatabase(projectId, options)
      )
    )
    
    results.push(...batchResults)
  }
  
  const successful = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length
  
  console.log(`[Migration] Batch migration complete:`)
  console.log(`[Migration]   Total: ${projectIds.length}`)
  console.log(`[Migration]   Successful: ${successful}`)
  console.log(`[Migration]   Failed: ${failed}`)
  
  return {
    total: projectIds.length,
    successful,
    failed,
    results,
  }
}
