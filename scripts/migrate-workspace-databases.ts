/**
 * Migration Script: Add Database Provisioning to Existing Workspaces
 * 
 * This script:
 * 1. Adds database fields to existing workspaces (if schema migration already run)
 * 2. Provisions databases for existing workspaces
 * 
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/migrate-workspace-databases.ts
 * 
 * Or with specific workspace:
 *   npx ts-node --project tsconfig.scripts.json scripts/migrate-workspace-databases.ts --workspace-id <id>
 * 
 * Note: Make sure to run from project root directory
 */

import { PrismaClient } from '@prisma/client'
import { provisionWorkspaceDatabase } from '../lib/services/databaseProvisioning'

const prisma = new PrismaClient()

async function main() {
  const args = process.argv.slice(2)
  const workspaceIdArg = args.find(arg => arg.startsWith('--workspace-id='))
  const workspaceId = workspaceIdArg?.split('=')[1]

  console.log('🚀 Starting workspace database migration...\n')

  try {
    if (workspaceId) {
      // Migrate specific workspace
      console.log(`📦 Migrating workspace: ${workspaceId}`)
      
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          name: true,
          projectId: true,
          databaseProvisioned: true,
        },
      })

      if (!workspace) {
        console.error(`❌ Workspace ${workspaceId} not found`)
        process.exit(1)
      }

      if (workspace.databaseProvisioned) {
        console.log(`✅ Workspace ${workspace.name} already has databases provisioned`)
        return
      }

      const result = await provisionWorkspaceDatabase(workspace.id, workspace.projectId)
      if (result.success) {
        console.log(`✅ Successfully provisioned databases for ${workspace.name}`)
        console.log(`   PostgreSQL schema: ${result.postgresSchema}`)
        console.log(`   MongoDB database: ${result.mongodbDatabase}`)
      } else {
        console.error(`❌ Failed to provision databases: ${result.error}`)
        process.exit(1)
      }
    } else {
      // Migrate all workspaces
      console.log('📦 Finding all workspaces...\n')

      const workspaces = await prisma.workspace.findMany({
        select: {
          id: true,
          name: true,
          projectId: true,
          databaseProvisioned: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      })

      console.log(`Found ${workspaces.length} workspaces\n`)

      let successCount = 0
      let skipCount = 0
      let failCount = 0

      for (const workspace of workspaces) {
        if (workspace.databaseProvisioned) {
          console.log(`⏭️  Skipping ${workspace.name} (already provisioned)`)
          skipCount++
          continue
        }

        console.log(`🔄 Provisioning databases for: ${workspace.name} (${workspace.id})`)
        
        const result = await provisionWorkspaceDatabase(workspace.id, workspace.projectId)
        
        if (result.success) {
          console.log(`   ✅ PostgreSQL schema: ${result.postgresSchema}`)
          console.log(`   ✅ MongoDB database: ${result.mongodbDatabase}\n`)
          successCount++
        } else {
          console.error(`   ❌ Failed: ${result.error}\n`)
          failCount++
        }

        // Small delay to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      console.log('\n📊 Migration Summary:')
      console.log(`   ✅ Success: ${successCount}`)
      console.log(`   ⏭️  Skipped: ${skipCount}`)
      console.log(`   ❌ Failed: ${failCount}`)
      console.log(`   📦 Total: ${workspaces.length}`)
    }
  } catch (error: any) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })

