/**
 * Migration Runner - Applies REAL database migrations
 * 
 * This executes Prisma migrations against the actual PostgreSQL database
 * 
 * ENGINE MODE SUPPORT:
 * - runtime: Execute real DDL migrations
 * - integration: Skip real DDL, validate plan only
 * - simulation: No-op, return success
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { PrismaClient } from '@prisma/client'
import { isIntegrationMode, shouldExecuteRealMigrations } from '@/lib/config/engine-mode'

const execAsync = promisify(exec)

export interface MigrationResult {
  success: boolean
  migrationName?: string
  tablesCreated: string[]
  output: string
  error?: string
}

/**
 * Run Prisma migration to create real database tables
 * 
 * This is where the rubber meets the road - REAL tables get created
 * 
 * ENGINE MODE BEHAVIOR:
 * - runtime: Execute real DDL migrations against database
 * - integration: Skip DDL execution, validate schema generation only
 * - simulation: Return immediate success without any side effects
 */
export async function runMigration(
  projectId: string,
  schemaPath: string,
  migrationName: string
): Promise<MigrationResult> {
  const mode = process.env.ENGINE_MODE || 'runtime'
  console.log(`[Migration Runner] Engine mode: ${mode}`)
  
  // Integration mode - skip real DDL execution
  if (isIntegrationMode()) {
    console.log('[Migration Runner] INTEGRATION MODE - Skipping real DDL execution')
    console.log('[Migration Runner] Schema path:', schemaPath)
    console.log('[Migration Runner] Migration name:', migrationName)
    
    // Validate that schema file exists
    if (!fs.existsSync(schemaPath)) {
      return {
        success: false,
        tablesCreated: [],
        output: '',
        error: `Schema file not found: ${schemaPath}`,
      }
    }
    
    // Parse tables that would be created (for validation purposes)
    const schemaContent = fs.readFileSync(schemaPath, 'utf8')
    const tablesCreated = parseTablesFromSchemaContent(schemaContent)
    
    console.log(`[Migration Runner] INTEGRATION MODE - Would create tables: ${tablesCreated.join(', ')}`)
    
    return {
      success: true,
      migrationName,
      tablesCreated,
      output: 'INTEGRATION MODE - No real DDL executed',
    }
  }
  
  // Simulation mode - immediate success
  if (mode === 'simulation') {
    console.log('[Migration Runner] SIMULATION MODE - Returning immediate success')
    return {
      success: true,
      migrationName,
      tablesCreated: [],
      output: 'SIMULATION MODE - No execution performed',
    }
  }
  
  // Runtime mode - execute real migrations
  try {
    console.log(`[Migration Runner] Starting migration for project: ${projectId}`)
    console.log(`[Migration Runner] Schema path: ${schemaPath}`)
    console.log(`[Migration Runner] Migration name: ${migrationName}`)
    
    const workspaceSchema = `workspace_${projectId}`
    
    // Use Prisma Client to create schema and execute raw SQL
    // This is the ONLY safe way to handle multi-schema migrations
    console.log(`[Migration Runner] Creating workspace schema: ${workspaceSchema}`)
    
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env[`DATABASE_URL_${projectId}`] || process.env.DATABASE_URL,
        },
      },
    })
    
    // Step 1: Create workspace schema if it doesn't exist
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${workspaceSchema}"`)
    console.log(`[Migration Runner] ✅ Schema ${workspaceSchema} created`)
    
    // Step 2: Generate SQL from Prisma schema using migrate diff
    console.log(`[Migration Runner] Generating migration SQL...`)
    const { stdout: migrationSQL } = await execAsync(
      `npx prisma migrate diff --from-empty --to-schema-datamodel="${schemaPath}" --script`,
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env[`DATABASE_URL_${projectId}`] || process.env.DATABASE_URL,
        },
      }
    )
    
    console.log(`[Migration Runner] Generated SQL (first 200 chars):`, migrationSQL.substring(0, 200))
    
    // Step 3: Execute the migration SQL
    // IMPORTANT: PostgreSQL prepared statements can only execute ONE command at a time
    // We need to split the SQL into individual statements and execute them separately
    console.log(`[Migration Runner] Executing migration SQL...`)
    
    // Remove all comment lines first
    const sqlWithoutComments = migrationSQL
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
    
    // Split SQL into individual statements (separated by semicolons)
    const statements = sqlWithoutComments
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0)
    
    console.log(`[Migration Runner] Executing ${statements.length} SQL statements...`)
    
    // Execute each statement individually
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i]
      console.log(`[Migration Runner] [${i + 1}/${statements.length}] Executing: ${statement.substring(0, 100)}...`)
      
      try {
        await prisma.$executeRawUnsafe(statement)
      } catch (error: any) {
        // Ignore "already exists" errors (idempotency)
        if (error.code === 'P2010' && error.meta?.code === '42P07') {
          console.log(`[Migration Runner] [${i + 1}/${statements.length}] ⚠️  Table/schema already exists, skipping...`)
          continue
        }
        // Re-throw other errors
        throw error
      }
    }
    
    await prisma.$disconnect()
    
    console.log(`[Migration Runner] ✅ Migration completed successfully`)
    
    // Parse tables created
    const tablesCreated = parseTablesFromMigrationOutput(migrationSQL)
    
    return {
      success: true,
      migrationName,
      tablesCreated,
      output: migrationSQL,
    }
  } catch (error) {
    console.error('[Migration Runner] Migration failed:', error)
    
    const errorOutput = error instanceof Error && 'stdout' in error 
      ? (error as any).stdout + (error as any).stderr 
      : error instanceof Error ? error.message : 'Unknown error'
    
    return {
      success: false,
      tablesCreated: [],
      output: errorOutput,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Verify tables exist in database
 * 
 * ENGINE MODE BEHAVIOR:
 * - runtime: Query actual database to verify table existence
 * - integration: Return success without querying (tables "exist" in validation context)
 * - simulation: Return success without querying
 */
export async function verifyTablesExist(
  projectId: string,
  tableNames: string[]
): Promise<{ exists: boolean; foundTables: string[]; missingTables: string[] }> {
  const mode = process.env.ENGINE_MODE || 'runtime'
  console.log(`[Migration Runner] Verifying tables in ${mode} mode`)
  
  // Integration and simulation modes - assume tables exist for validation purposes
  if (mode === 'integration' || mode === 'simulation') {
    console.log(`[Migration Runner] ${mode.toUpperCase()} MODE - Assuming tables exist`)
    return {
      exists: true,
      foundTables: tableNames,
      missingTables: [],
    }
  }
  
  // Runtime mode - query actual database
  try {
    console.log(`[Migration Runner] Verifying tables exist: ${tableNames.join(', ')}`)
    
    // Get workspace schema name
    const workspaceSchema = `workspace_${projectId}`
    console.log(`[Migration Runner] Checking schema: ${workspaceSchema}`)
    
    // Query database to check if tables exist
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env[`DATABASE_URL_${projectId}`] || process.env.DATABASE_URL,
        },
      },
    })
    
    // Query information_schema to check table existence in workspace schema
    // Use LOWER() for case-insensitive comparison since PostgreSQL table names can be case-sensitive
    const lowerTableNames = tableNames.map(name => name.toLowerCase())
    const result = await prisma.$queryRaw<any[]>`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = ${workspaceSchema}
      AND LOWER(table_name) = ANY(${lowerTableNames})
    `
    
    await prisma.$disconnect()
    
    const foundTables = result.map((row: any) => row.table_name)
    const missingTables = tableNames.filter(name => 
      !foundTables.some(foundTable => foundTable.toLowerCase() === name.toLowerCase())
    )
    
    console.log(`[Migration Runner] Found tables: ${foundTables.join(', ')}`)
    if (missingTables.length > 0) {
      console.warn(`[Migration Runner] Missing tables: ${missingTables.join(', ')}`)
    }
    
    return {
      exists: missingTables.length === 0,
      foundTables,
      missingTables,
    }
  } catch (error) {
    console.error('[Migration Runner] Failed to verify tables:', error)
    return {
      exists: false,
      foundTables: [],
      missingTables: tableNames,
    }
  }
}

/**
 * Parse table names from Prisma schema content
 */
function parseTablesFromSchemaContent(schemaContent: string): string[] {
  const tables: string[] = []
  
  // Look for "model" declarations in the schema
  const modelRegex = /model\s+(\w+)\s*{/g
  let match
  
  while ((match = modelRegex.exec(schemaContent)) !== null) {
    tables.push(match[1])
  }
  
  return tables
}

/**
 * Parse table names from Prisma migration output
 */
function parseTablesFromMigrationOutput(output: string): string[] {
  const tables: string[] = []
  
  // Look for "CREATE TABLE" statements in the output
  const createTableRegex = /CREATE TABLE\s+"?(\w+)"?/gi
  let match
  
  while ((match = createTableRegex.exec(output)) !== null) {
    tables.push(match[1])
  }
  
  return tables
}
