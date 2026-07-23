/**
 * MIGRATION SCRIPT: Migrate projects from file-based graphs to BackendGraph pointer architecture
 * 
 * Run once to migrate all existing projects that have NULL activeGraphId
 */

import { PrismaClient } from '@prisma/client'
import { createEmptyGraph } from '../lib/orchestration/backend-state-graph'

const prisma = new PrismaClient()

async function migrateProjects() {
  console.log('🔄 Starting migration to graph pointer architecture...\n')
  
  // Find all projects with NULL activeGraphId
  const projectsToMigrate = await prisma.project.findMany({
    where: {
      activeGraphId: null,
    },
    include: {
      _count: {
        select: { graphs: true },
      },
    },
  })
  
  console.log(`Found ${projectsToMigrate.length} projects to migrate\n`)
  
  if (projectsToMigrate.length === 0) {
    console.log('✅ No projects need migration')
    return
  }
  
  let migratedCount = 0
  let errorCount = 0
  
  for (const project of projectsToMigrate) {
    try {
      console.log(`Migrating project: ${project.name} (${project.id})`)
      
      // Use transaction for atomicity
      await prisma.$transaction(async (tx) => {
        // Double-check activeGraphId still NULL (idempotency)
        const currentProject = await tx.project.findUnique({
          where: { id: project.id },
          select: { activeGraphId: true },
        })
        
        if (currentProject?.activeGraphId) {
          console.log(`  ⚠ Already migrated, skipping`)
          return
        }
        
        // Check if project has old graph data in ProjectMetadata
        let graphData: any = null
        
        try {
          const metadata = await (tx as any).projectMetadata.findUnique({
            where: { projectId: project.id },
            select: { backendStateGraph: true },
          })
          
          if (metadata?.backendStateGraph) {
            graphData = metadata.backendStateGraph
            console.log(`  ✓ Found existing graph in ProjectMetadata`)
          }
        } catch (error) {
          console.log(`  ⚠ No metadata table or graph data`)
        }
        
        // If no old data, create empty graph
        if (!graphData) {
          graphData = createEmptyGraph(project.id)
          console.log(`  ✓ Created new empty graph`)
        }
        
        // Create BackendGraph row
        const backendGraph = await tx.backendGraph.create({
          data: {
            projectId: project.id,
            graphData: graphData as any,
            sequenceNumber: 1, // Initial graph
          },
        })
        
        console.log(`  ✓ Created BackendGraph row: ${backendGraph.id}`)
        
        // Set activeGraphId atomically
        await tx.project.update({
          where: { id: project.id },
          data: { activeGraphId: backendGraph.id },
        })
        
        console.log(`  ✓ Set activeGraphId: ${backendGraph.id}`)
      })
      
      console.log(`  ✅ Migration complete\n`)
      migratedCount++
    } catch (error: any) {
      console.error(`  ❌ Migration failed: ${error.message}\n`)
      errorCount++
    }
  }
  
  console.log('\n' + '='.repeat(50))
  console.log(`Migration Summary:`)
  console.log(`  ✅ Migrated: ${migratedCount}`)
  console.log(`  ❌ Failed: ${errorCount}`)
  console.log(`  📊 Total: ${projectsToMigrate.length}`)
  console.log('='.repeat(50))
  
  await prisma.$disconnect()
}

// Run migration
migrateProjects()
  .then(() => {
    console.log('\n✅ Migration script completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n❌ Migration script failed:', error)
    process.exit(1)
  })
