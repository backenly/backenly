#!/usr/bin/env ts-node
/**
 * Schema Audit Script
 * 
 * PHASE A: Schema Truth & Data Integrity Lockdown
 * 
 * Compares Prisma schema with actual database schema
 * Generates diff report and migration requirements
 */

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

interface SchemaDiff {
  table: string
  expectedColumns: string[]
  actualColumns: string[]
  missingColumns: string[]
  extraColumns: string[]
}

interface AuditReport {
  timestamp: string
  databaseUrl: string
  diffs: SchemaDiff[]
  criticalIssues: string[]
  warnings: string[]
  migrationRequired: boolean
}

/**
 * Get actual database schema from PostgreSQL
 */
async function getDatabaseSchema(): Promise<Map<string, string[]>> {
  const schema = new Map<string, string[]>()
  
  try {
    const columns = await prisma.$queryRaw<Array<{
      table_name: string
      column_name: string
      data_type: string
      is_nullable: string
    }>>`
      SELECT 
        table_name,
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `
    
    for (const col of columns) {
      if (!schema.has(col.table_name)) {
        schema.set(col.table_name, [])
      }
      schema.get(col.table_name)!.push(col.column_name)
    }
  } catch (error) {
    console.error('Failed to query database schema:', error)
    throw error
  }
  
  return schema
}

/**
 * Get expected schema from Prisma (simplified parsing)
 */
function getPrismaSchema(): Map<string, string[]> {
  const schema = new Map<string, string[]>()
  const schemaPath = path.join(__dirname, '../prisma/schema.prisma')
  
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Prisma schema not found at ${schemaPath}`)
  }
  
  const content = fs.readFileSync(schemaPath, 'utf-8')
  
  // Simple regex to extract model definitions
  const modelRegex = /model\s+(\w+)\s+\{([^}]+)\}/g
  let match
  
  while ((match = modelRegex.exec(content)) !== null) {
    const modelName = match[1]
    const modelBody = match[2]
    
    // Extract field names (lines that start with whitespace followed by a word)
    const fields: string[] = []
    const fieldRegex = /^\s+(\w+)\s+/gm
    let fieldMatch
    
    while ((fieldMatch = fieldRegex.exec(modelBody)) !== null) {
      const fieldName = fieldMatch[1]
      // Skip relation fields (contain @relation)
      const fieldLine = modelBody.substring(fieldMatch.index, fieldMatch.index + 200)
      if (!fieldLine.includes('@relation') && !fieldLine.includes('@@')) {
        fields.push(fieldName)
      }
    }
    
    // Map Prisma model name to DB table name (usually lowercase plural)
    const tableName = modelName.toLowerCase() + 's'
    schema.set(tableName, fields)
  }
  
  return schema
}

/**
 * Compare schemas and generate diff
 */
function compareSchemas(
  expected: Map<string, string[]>,
  actual: Map<string, string[]>
): SchemaDiff[] {
  const diffs: SchemaDiff[] = []
  
  for (const entry of Array.from(expected.entries())) {
    const table = entry[0]
    const expectedColumns = entry[1]
    const actualColumns = actual.get(table) || []
    
    const missingColumns = expectedColumns.filter(col => !actualColumns.includes(col))
    const extraColumns = actualColumns.filter(col => !expectedColumns.includes(col))
    
    if (missingColumns.length > 0 || extraColumns.length > 0) {
      diffs.push({
        table,
        expectedColumns,
        actualColumns,
        missingColumns,
        extraColumns,
      })
    }
  }
  
  // Check for extra tables in DB
  for (const entry of Array.from(actual.entries())) {
    const table = entry[0]
    const actualColumns = entry[1]
    if (!expected.has(table)) {
      diffs.push({
        table,
        expectedColumns: [],
        actualColumns,
        missingColumns: [],
        extraColumns: actualColumns,
      })
    }
  }
  
  return diffs
}

/**
 * Generate migration SQL for missing columns
 */
function generateMigrationSQL(diff: SchemaDiff): string {
  const migrations: string[] = []
  
  for (const col of diff.missingColumns) {
    // Map common Prisma types to PostgreSQL
    let sqlType = 'TEXT'
    
    // Infer type from column name conventions
    if (col.endsWith('At') || col.includes('Date') || col.includes('Time')) {
      sqlType = 'TIMESTAMP'
    } else if (col.endsWith('Id') || col === 'id') {
      sqlType = 'UUID'
    } else if (col.includes('Count') || col.includes('Size') || col.includes('Version')) {
      sqlType = 'INTEGER'
    } else if (col.includes('Enabled') || col.includes('Verified') || col.startsWith('is') || col.startsWith('has')) {
      sqlType = 'BOOLEAN'
    } else if (col.includes('Json') || col === 'metadata' || col === 'config') {
      sqlType = 'JSONB'
    }
    
    migrations.push(`ALTER TABLE "${diff.table}" ADD COLUMN IF NOT EXISTS "${col}" ${sqlType};`)
  }
  
  return migrations.join('\n')
}

/**
 * Run Prisma migrate status
 */
function checkMigrationStatus(): { pending: boolean; output: string } {
  try {
    const output = execSync('npx prisma migrate status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    })
    return { pending: false, output }
  } catch (error: any) {
    const output = error.stdout || error.message || ''
    const hasPending = output.includes('have not been applied yet') || 
                       output.includes('diverged') ||
                       output.includes('Migration failed')
    return { pending: hasPending, output }
  }
}

/**
 * Main audit function
 */
async function runSchemaAudit(): Promise<void> {
  console.log('\n' + '='.repeat(80))
  console.log('SCHEMA AUDIT REPORT')
  console.log('='.repeat(80) + '\n')
  
  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    databaseUrl: process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') || 'not set',
    diffs: [],
    criticalIssues: [],
    warnings: [],
    migrationRequired: false,
  }
  
  // Check migration status
  console.log('[Audit] Checking Prisma migration status...')
  const migrationStatus = checkMigrationStatus()
  
  if (migrationStatus.pending) {
    console.log('❌ Pending migrations detected')
    report.criticalIssues.push('Pending Prisma migrations')
    report.migrationRequired = true
  } else {
    console.log('✅ No pending migrations')
  }
  
  // Get schemas
  console.log('[Audit] Fetching database schema...')
  const dbSchema = await getDatabaseSchema()
  console.log(`  Found ${dbSchema.size} tables`)
  
  console.log('[Audit] Parsing Prisma schema...')
  const prismaSchema = getPrismaSchema()
  console.log(`  Found ${prismaSchema.size} models`)
  
  // Compare
  console.log('[Audit] Comparing schemas...\n')
  const diffs = compareSchemas(prismaSchema, dbSchema)
  report.diffs = diffs
  
  if (diffs.length === 0) {
    console.log('✅ Schema alignment: PERFECT')
  } else {
    console.log('❌ Schema alignment: MISMATCHES FOUND\n')
    report.migrationRequired = true
    
    for (const diff of diffs) {
      console.log(`Table: ${diff.table}`)
      
      if (diff.missingColumns.length > 0) {
        console.log(`  ❌ Missing columns: ${diff.missingColumns.join(', ')}`)
        report.criticalIssues.push(`Table ${diff.table} missing columns: ${diff.missingColumns.join(', ')}`)
      }
      
      if (diff.extraColumns.length > 0) {
        console.log(`  ⚠️  Extra columns: ${diff.extraColumns.join(', ')}`)
        report.warnings.push(`Table ${diff.table} has extra columns: ${diff.extraColumns.join(', ')}`)
      }
      
      // Generate migration SQL
      const migrationSQL = generateMigrationSQL(diff)
      if (migrationSQL) {
        console.log(`  💡 Migration SQL:\n${migrationSQL.split('\n').map(l => '     ' + l).join('\n')}`)
      }
      
      console.log()
    }
  }
  
  // Summary
  console.log('='.repeat(80))
  console.log('SUMMARY')
  console.log('='.repeat(80))
  console.log(`Critical Issues: ${report.criticalIssues.length}`)
  console.log(`Warnings: ${report.warnings.length}`)
  console.log(`Migration Required: ${report.migrationRequired ? 'YES' : 'NO'}`)
  console.log()
  
  if (report.migrationRequired) {
    console.log('❌ SCHEMA AUDIT FAILED')
    console.log()
    console.log('To fix:')
    console.log('  1. Run: npx prisma migrate dev')
    console.log('  2. Or apply the generated SQL above')
    console.log('  3. Re-run this audit')
    console.log()
    process.exit(1)
  } else {
    console.log('✅ SCHEMA AUDIT PASSED')
    console.log()
    console.log('Database schema is aligned with Prisma schema.')
    console.log()
    process.exit(0)
  }
}

// Run if called directly
if (require.main === module) {
  runSchemaAudit().catch(error => {
    console.error('Schema audit failed:', error)
    process.exit(1)
  })
}

export { runSchemaAudit }
