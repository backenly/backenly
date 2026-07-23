/**
 * PHASE 2: RLS Transaction Wrapper
 * 
 * Automatically sets app.project_id at start of every transaction
 * Ensures PostgreSQL RLS policies enforce project isolation
 */

import { PrismaClient } from '@prisma/client'
import { ExecutionContext, assertExecutionContext } from '@/lib/context/execution-context'

/**
 * Execute database operations within RLS-protected transaction
 * 
 * CRITICAL: Sets PostgreSQL session variable before executing any queries
 * This activates Row Level Security policies
 * 
 * Usage:
 * await withRLSTransaction(context, async (tx) => {
 *   // All queries in this transaction are automatically scoped to project
 *   const tables = await tx.table.findMany()
 *   return tables
 * })
 */
export async function withRLSTransaction<T>(
  context: ExecutionContext,
  operation: (tx: any) => Promise<T>
): Promise<T> {
  assertExecutionContext(context)
  
  const prisma = new PrismaClient()
  
  try {
    // Execute within transaction
    return await prisma.$transaction(async (tx) => {
      // CRITICAL: Set session variable FIRST
      // This enables RLS policies to filter rows by project_id
      const sanitizedProjectId = context.projectId.replace(/'/g, "''")
      await tx.$executeRawUnsafe(
        `SET LOCAL app.project_id = '${sanitizedProjectId}'`
      )
      
      console.log(
        `[RLS Transaction] Set project_id=${context.projectId} for execution ${context.executionId}`
      )
      
      // Execute user operation with RLS protection active
      return await operation(tx)
    })
  } catch (error) {
    console.error(
      `[RLS Transaction] Failed for project ${context.projectId}:`,
      error
    )
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Verify RLS is enabled on a table
 * 
 * Utility for runtime validation
 */
export async function verifyRLSEnabled(
  tableName: string
): Promise<boolean> {
  const prisma = new PrismaClient()
  
  try {
    const result = await prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = ${tableName}
        AND n.nspname = 'public'
    `
    
    if (result.length === 0) {
      console.warn(`[RLS] Table ${tableName} not found`)
      return false
    }
    
    return result[0].relrowsecurity
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Verify all tenant tables have RLS enabled
 * 
 * Run this on startup to ensure security invariants
 */
export async function verifyAllRLSEnabled(): Promise<void> {
  const requiredTables = [
    'Table',
    'ApiDefinition',
    'ApiKey',
    'Deployment',
    'DatabaseIssue',
    'ExecutionHistory',
    'Workspace',
    'Log',
  ]
  
  console.log('[RLS] Verifying Row Level Security on all tenant tables...')
  
  for (const table of requiredTables) {
    const enabled = await verifyRLSEnabled(table)
    if (!enabled) {
      throw new Error(
        `SECURITY VIOLATION: RLS not enabled on table ${table}. ` +
        `Run migration: prisma/migrations/add_rls_policies.sql`
      )
    }
    console.log(`[RLS] ✓ ${table}`)
  }
  
  console.log('[RLS] ✓ All tenant tables have RLS enabled')
}
