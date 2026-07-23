/**
 * DATABASE GROWTH STRATEGY: Rolling Retention for BackendGraph
 * 
 * Keeps last N graphs per project, deletes older ones
 * Preserves: initial graph (sequence 1) + recent N graphs
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const RETENTION_WINDOW = 20 // Keep last 20 graphs per project

async function cleanupOldGraphs() {
  console.log('🧹 Starting BackendGraph cleanup (retention window:', RETENTION_WINDOW, ')\n')
  
  // Get all projects
  const projects = await prisma.project.findMany({
    select: { id: true, name: true },
  })
  
  console.log(`Found ${projects.length} projects\n`)
  
  let totalDeleted = 0
  
  for (const project of projects) {
    try {
      await prisma.$transaction(async (tx) => {
        // Get current activeGraphId (critical: must protect this)
        const currentProject = await tx.project.findUnique({
          where: { id: project.id },
          select: { activeGraphId: true },
        })
        
        if (!currentProject?.activeGraphId) {
          console.log(`  ${project.name}: No active graph, skip cleanup`)
          return
        }
        
        // Get all graphs for this project
        const allGraphs = await tx.backendGraph.findMany({
          where: { projectId: project.id },
          orderBy: { sequenceNumber: 'desc' },
          select: { id: true, sequenceNumber: true, createdAt: true },
        })
        
        if (allGraphs.length <= RETENTION_WINDOW) {
          console.log(`  ${project.name}: ${allGraphs.length} graphs (within limit, skip)`)
          return
        }
        
        // Keep: last N graphs
        const graphsToKeep = allGraphs.slice(0, RETENTION_WINDOW)
        const graphsToDelete = allGraphs.slice(RETENTION_WINDOW)
        
        // Filter out graphs that must never be deleted
        const graphsToDeleteFiltered = graphsToDelete.filter(g => {
          // NEVER delete active graph
          if (g.id === currentProject.activeGraphId) return false
          // NEVER delete initial graph (sequence 0 or 1)
          if (g.sequenceNumber <= 1) return false
          // NEVER delete if somehow in keep list
          if (graphsToKeep.some(k => k.id === g.id)) return false
          return true
        })
        
        if (graphsToDeleteFiltered.length === 0) {
          console.log(`  ${project.name}: ${allGraphs.length} graphs (no deletion needed)`)
          return
        }
        
        // Delete old graphs atomically
        const deletedIds = graphsToDeleteFiltered.map(g => g.id)
        const deleteResult = await tx.backendGraph.deleteMany({
          where: {
            id: { in: deletedIds },
          },
        })
        
        console.log(`  ${project.name}: Deleted ${deleteResult.count} old graphs (kept ${graphsToKeep.length})`)
        totalDeleted += deleteResult.count
      })
    } catch (error: any) {
      console.error(`  ❌ Failed to cleanup project ${project.name}:`, error.message)
    }
  }
  
  console.log('\n' + '='.repeat(50))
  console.log(`Cleanup Summary:`)
  console.log(`  🗑️  Total deleted: ${totalDeleted} graphs`)
  console.log(`  📊 Retention window: ${RETENTION_WINDOW} graphs per project`)
  console.log('='.repeat(50))
  
  await prisma.$disconnect()
}

// Run cleanup
cleanupOldGraphs()
  .then(() => {
    console.log('\n✅ Cleanup completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n❌ Cleanup failed:', error)
    process.exit(1)
  })
