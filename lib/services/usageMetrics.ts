/**
 * Basic Usage Metrics Service
 * 
 * Simple usage tracking for:
 * - API requests
 * - Database queries
 * - Storage usage
 */

import { prisma } from '@/lib/db'

export interface UsageMetrics {
  projectId: string
  apiRequests: number
  databaseQueries: number
  storageBytes: number
  lastUpdated: Date
}

/**
 * Get usage metrics for a project
 */
export async function getUsageMetrics(projectId: string): Promise<UsageMetrics> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      apiRequests: true,
      storageUsed: true,
    },
  })

  return {
    projectId,
    apiRequests: project?.apiRequests || 0,
    databaseQueries: 0, // Track separately if needed
    storageBytes: Number(project?.storageUsed || 0),
    lastUpdated: new Date(),
  }
}

/**
 * Increment API request count
 */
export async function incrementApiRequests(projectId: string): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: {
      apiRequests: {
        increment: 1,
      },
    },
  })
}

/**
 * Update storage usage
 */
export async function updateStorageUsage(projectId: string, bytes: number): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: {
      storageUsed: BigInt(bytes),
    },
  })
}

