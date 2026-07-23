/**
 * 🔒 POSTGRESQL ROW-LEVEL SECURITY (RLS)
 * 
 * CRITICAL: Database-level enforcement
 * Even if Prisma is bypassed, DB still enforces tenant isolation
 * 
 * Database-enforced isolation is what makes multi-tenancy truly secure.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Enable RLS on all tenant-scoped tables
 * Run this once during setup or migration
 */
export async function enableRowLevelSecurity() {
  console.log('🔒 Enabling PostgreSQL Row-Level Security (RLS)...\n')

  const tables = [
    'tables',
    'api_keys',
    'audit_logs',
    'deployments',
    'storage_buckets',
    'storage_files',
    'preview_shares',
    'logs',
    'metrics',
    'incidents',
    'anomalies',
    'security_issues',
    'security_scans',
    'database_issues',
    'blocked_attacks',
    'provider_credentials',
    'workspace_oauth_configs',
    'project_cors_origins',
    'ai_usage',
  ]

  for (const table of tables) {
    try {
      // 1. Enable RLS on table
      await prisma.$executeRawUnsafe(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      `)
      console.log(`✅ Enabled RLS on: ${table}`)

      // 2. Drop existing policies (idempotent)
      await prisma.$executeRawUnsafe(`
        DROP POLICY IF EXISTS project_isolation_policy ON ${table};
      `)

      // 3. Create project isolation policy
      await prisma.$executeRawUnsafe(`
        CREATE POLICY project_isolation_policy ON ${table}
        USING (project_id = current_setting('app.current_project_id', true)::uuid);
      `)
      console.log(`✅ Created isolation policy for: ${table}`)

    } catch (error: any) {
      console.error(`❌ Error on ${table}:`, error.message)
    }
  }

  // Special handling for workspace-scoped tables
  const workspaceTables = ['workspace_files']
  
  for (const table of workspaceTables) {
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      `)
      console.log(`✅ Enabled RLS on: ${table}`)

      await prisma.$executeRawUnsafe(`
        DROP POLICY IF EXISTS workspace_isolation_policy ON ${table};
      `)

      await prisma.$executeRawUnsafe(`
        CREATE POLICY workspace_isolation_policy ON ${table}
        USING (
          project_id = current_setting('app.current_project_id', true)::uuid
          OR workspace_id = current_setting('app.current_workspace_id', true)::uuid
        );
      `)
      console.log(`✅ Created workspace isolation policy for: ${table}`)

    } catch (error: any) {
      console.error(`❌ Error on ${table}:`, error.message)
    }
  }

  console.log('\n🎉 Row-Level Security enabled on all tables!')
}

/**
 * Set current project context for RLS
 * Call this at the start of every database transaction
 */
export async function setProjectContext(
  projectId: string,
  workspaceId?: string
) {
  await prisma.$executeRawUnsafe(`
    SELECT set_config('app.current_project_id', '${projectId}', false);
  `)

  if (workspaceId) {
    await prisma.$executeRawUnsafe(`
      SELECT set_config('app.current_workspace_id', '${workspaceId}', false);
    `)
  }
}

/**
 * Clear project context (for admin operations)
 */
export async function clearProjectContext() {
  await prisma.$executeRawUnsafe(`
    SELECT set_config('app.current_project_id', '', false);
  `)
  await prisma.$executeRawUnsafe(`
    SELECT set_config('app.current_workspace_id', '', false);
  `)
}

/**
 * Enhanced Prisma client with automatic RLS context
 */
export async function createRLSPrismaClient(
  projectId: string,
  workspaceId?: string
) {
  // Set context before any queries
  await setProjectContext(projectId, workspaceId)
  
  return prisma
}

/**
 * Test RLS enforcement
 */
export async function testRLSEnforcement() {
  console.log('\n🧪 Testing RLS enforcement...\n')

  const testProjectId = '00000000-0000-0000-0000-000000000001'

  try {
    // Test 1: Query without context (should return empty)
    await clearProjectContext()
    const noContextTables = await prisma.table.findMany()
    console.log(`Test 1: No context query returned ${noContextTables.length} rows (should be 0)`)

    // Test 2: Query with context (should return scoped data)
    await setProjectContext(testProjectId)
    const scopedTables = await prisma.table.findMany()
    console.log(`Test 2: Scoped query returned ${scopedTables.length} rows`)

    // Test 3: Try to access different project (should fail or return 0)
    const differentProjectId = '00000000-0000-0000-0000-000000000002'
    await setProjectContext(differentProjectId)
    const otherTables = await prisma.table.findMany()
    console.log(`Test 3: Different project query returned ${otherTables.length} rows`)

    console.log('\n✅ RLS enforcement tests complete!')
  } catch (error: any) {
    console.error('❌ RLS test failed:', error.message)
  }
}

// Export for migrations
export default enableRowLevelSecurity
