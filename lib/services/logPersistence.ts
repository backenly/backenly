/**
 * Log Persistence Service
 * 
 * Streams worker logs to platform database for persistence across restarts.
 * Provides billing-grade tracking of API calls, errors, and performance metrics.
 */

import { prisma } from '@/lib/db/postgres'

export interface PersistentLogEntry {
  projectId: string
  severity: 'info' | 'warn' | 'error' | 'debug'
  message: string
  runId?: string
  route?: string
  method?: string
  status?: number
  duration?: number
  data?: any
}

/**
 * Write log to platform database
 * Used by worker to persist logs beyond memory
 */
export async function persistLog(entry: PersistentLogEntry): Promise<void> {
  try {
    await prisma.log.create({
      data: {
        projectId: entry.projectId,
        severity: entry.severity,
        message: entry.message,
        type: entry.route ? 'api_request' : 'system',
        endpoint: entry.route,
        method: entry.method,
        statusCode: entry.status,
        duration: entry.duration,
        metadata: {
          runId: entry.runId,
          ...entry.data,
        },
      },
    })
  } catch (error) {
    // Don't throw - log persistence should never break the main flow
    console.error('[Log Persistence] Failed to persist log:', error)
  }
}

/**
 * Batch write logs (more efficient for high-volume logging)
 */
export async function persistLogsBatch(entries: PersistentLogEntry[]): Promise<void> {
  try {
    await prisma.log.createMany({
      data: entries.map(entry => ({
        projectId: entry.projectId,
        severity: entry.severity,
        message: entry.message,
        type: entry.route ? 'api_request' : 'system',
        endpoint: entry.route,
        method: entry.method,
        statusCode: entry.status,
        duration: entry.duration,
        metadata: {
          runId: entry.runId,
          ...entry.data,
        },
      })),
      skipDuplicates: true,
    })
  } catch (error) {
    console.error('[Log Persistence] Failed to persist batch logs:', error)
  }
}

/**
 * Query logs for a project (with pagination)
 */
export async function getProjectLogs(
  projectId: string,
  options?: {
    limit?: number
    offset?: number
    level?: string
    startDate?: Date
    endDate?: Date
  }
) {
  const where: any = { projectId }

  if (options?.level) {
    where.severity = options.level
  }

  if (options?.startDate || options?.endDate) {
    where.timestamp = {}
    if (options.startDate) where.timestamp.gte = options.startDate
    if (options.endDate) where.timestamp.lte = options.endDate
  }

  const [logs, total] = await Promise.all([
    prisma.log.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: options?.limit || 100,
      skip: options?.offset || 0,
    }),
    prisma.log.count({ where }),
  ])

  return { logs, total }
}

/**
 * Get API request statistics for billing
 */
export async function getApiRequestStats(
  projectId: string,
  startDate: Date,
  endDate: Date
) {
  const logs = await prisma.log.findMany({
    where: {
      projectId,
      type: 'api_request',
      timestamp: {
        gte: startDate,
        lte: endDate,
      },
    },
    select: {
      metadata: true,
      timestamp: true,
    },
  })

  // Calculate stats
  const stats = {
    totalRequests: logs.length,
    successCount: 0,
    errorCount: 0,
    avgDuration: 0,
    requestsByStatus: {} as Record<number, number>,
    requestsByRoute: {} as Record<string, number>,
  }

  let totalDuration = 0

  for (const log of logs) {
    const metadata = log.metadata as any

    // Count by status
    if (metadata.status) {
      stats.requestsByStatus[metadata.status] = (stats.requestsByStatus[metadata.status] || 0) + 1
      
      if (metadata.status >= 200 && metadata.status < 400) {
        stats.successCount++
      } else {
        stats.errorCount++
      }
    }

    // Count by route
    if (metadata.route) {
      stats.requestsByRoute[metadata.route] = (stats.requestsByRoute[metadata.route] || 0) + 1
    }

    // Sum duration
    if (metadata.duration) {
      totalDuration += metadata.duration
    }
  }

  stats.avgDuration = logs.length > 0 ? totalDuration / logs.length : 0

  return stats
}

/**
 * Clean up old logs (retention policy)
 */
export async function cleanupOldLogs(daysToKeep: number = 30): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)

  const result = await prisma.log.deleteMany({
    where: {
      timestamp: {
        lt: cutoffDate,
      },
    },
  })

  return result.count
}
