/**
 * GRAPH RETENTION & CLEANUP
 * 
 * Automatically cleans old BackendGraph rows while ensuring:
 * - Active graph is never deleted
 * - Sequence 1 (initial state) is always preserved
 * - Cleanup happens inside transaction
 * - No race conditions with concurrent mutations
 */

import { prisma } from '@/lib/db/prisma'

const RETENTION_COUNT = 20 // Keep last 20 graphs per project

/**
 * Clean up old graphs for a single project
 * Must be called inside transaction for safety
 */
export async function cleanupProjectGraphs(projectId: string): Promise<{
  deleted: number
  kept: number
}> {
  return await prisma.$transaction(async (tx) => {
    // 1. Get current active graph (inside transaction)
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { activeGraphId: true },
    })

    if (!project?.activeGraphId) {
      console.log(`[Graph Cleanup] Project ${projectId} has no active graph, skipping`)
      return { deleted: 0, kept: 0 }
    }

    // 2. Get all graphs ordered by sequence (newest first)
    const allGraphs = await tx.backendGraph.findMany({
      where: { projectId },
      orderBy: { sequenceNumber: 'desc' },
      select: { id: true, sequenceNumber: true },
    })

    if (allGraphs.length <= RETENTION_COUNT) {
      console.log(`[Graph Cleanup] Project ${projectId} has ${allGraphs.length} graphs (under limit), skipping`)
      return { deleted: 0, kept: allGraphs.length }
    }

    // 3. Determine which graphs to keep
    const keep = new Set<string>()
    
    // Always keep active graph
    keep.add(project.activeGraphId)
    
    // Always keep sequence 1 (initial state)
    const initialGraph = allGraphs.find(g => g.sequenceNumber === 1)
    if (initialGraph) {
      keep.add(initialGraph.id)
    }
    
    // Keep last N graphs
    allGraphs.slice(0, RETENTION_COUNT).forEach(g => keep.add(g.id))

    // 4. Delete old graphs (inside same transaction)
    const deleteResult = await tx.backendGraph.deleteMany({
      where: {
        projectId,
        id: { notIn: Array.from(keep) },
        sequenceNumber: { gt: 1 }, // Extra safety: never delete sequence 1
      },
    })

    console.log(`[Graph Cleanup] Project ${projectId}: deleted ${deleteResult.count}, kept ${keep.size}`)

    return {
      deleted: deleteResult.count,
      kept: keep.size,
    }
  })
}

/**
 * Clean up old graphs for all projects
 * Run periodically (e.g., daily via cron job)
 */
export async function cleanupAllProjectGraphs(): Promise<{
  projectsProcessed: number
  totalDeleted: number
  totalKept: number
  errors: string[]
}> {
  const startTime = Date.now()
  console.log('[Graph Cleanup] Starting global cleanup...')

  const stats = {
    projectsProcessed: 0,
    totalDeleted: 0,
    totalKept: 0,
    errors: [] as string[],
  }

  try {
    // Get all project IDs with graphs
    const projects = await prisma.project.findMany({
      where: {
        activeGraphId: { not: null },
      },
      select: { id: true },
    })

    console.log(`[Graph Cleanup] Found ${projects.length} projects to process`)

    for (const project of projects) {
      try {
        const result = await cleanupProjectGraphs(project.id)
        stats.projectsProcessed++
        stats.totalDeleted += result.deleted
        stats.totalKept += result.kept
      } catch (error: any) {
        console.error(`[Graph Cleanup] Failed for project ${project.id}:`, error)
        stats.errors.push(`${project.id}: ${error.message}`)
      }
    }

    const duration = Date.now() - startTime
    console.log(`[Graph Cleanup] Complete in ${duration}ms:`, stats)

    return stats
  } catch (error: any) {
    console.error('[Graph Cleanup] Global cleanup failed:', error)
    throw error
  }
}

/**
 * CLI entry point for manual cleanup
 * Usage: tsx lib/orchestration/graph-cleanup.ts
 */
if (require.main === module) {
  cleanupAllProjectGraphs()
    .then((stats) => {
      console.log('\n✅ Cleanup complete:', JSON.stringify(stats, null, 2))
      process.exit(0)
    })
    .catch((error) => {
      console.error('\n❌ Cleanup failed:', error)
      process.exit(1)
    })
}

