/**
 * EXECUTION OBSERVABILITY LOGGER
 * ================================
 * Writes every agent execution attempt to the execution_logs table.
 *
 * Captures:
 *   - intent type (BUILD, FIX, INTEGRATION, ...)
 *   - strategy chosen
 *   - specific action taken
 *   - duration (ms)
 *   - success / failure
 *   - error message
 *   - arbitrary metadata
 *
 * Used for:
 *   - Debugging failed executions
 *   - Performance analysis
 *   - Building admin dashboards
 *   - Detecting abuse patterns
 */

import { prisma } from '@/lib/db/prisma'

export interface ExecutionTrace {
  projectId: string
  userId?: string
  intent: string
  strategy: string
  action: string
  startedAt: number  // Date.now() before execution
  success: boolean
  errorMsg?: string
  metadata?: Record<string, any>
}

/**
 * Finalize and persist an execution trace.
 * Call this after every agent execution (success or failure).
 * Non-blocking — errors are swallowed so they never affect the main flow.
 */
export async function logExecution(trace: ExecutionTrace): Promise<void> {
  const durationMs = Date.now() - trace.startedAt

  try {
    await prisma.executionLog.create({
      data: {
        projectId: trace.projectId,
        userId: trace.userId,
        intent: trace.intent,
        strategy: trace.strategy,
        action: trace.action,
        durationMs,
        success: trace.success,
        errorMsg: trace.errorMsg,
        metadata: trace.metadata as any,
      },
    })
  } catch {
    // Non-fatal — observability must never break execution
  }
}

/**
 * Convenience: wrap a function with automatic execution logging.
 *
 * Usage:
 *   const result = await withExecutionLog(
 *     { projectId, intent: 'FIX', strategy: 'schema-fix', action: 'fk-repair' },
 *     () => inferAndSaveRelationships(projectId)
 *   )
 */
export async function withExecutionLog<T>(
  trace: Omit<ExecutionTrace, 'startedAt' | 'success' | 'errorMsg'>,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await fn()
    await logExecution({ ...trace, startedAt, success: true })
    return result
  } catch (err: any) {
    await logExecution({ ...trace, startedAt, success: false, errorMsg: err?.message })
    throw err
  }
}

/**
 * Query recent execution logs for a project.
 */
export async function getRecentExecutions(
  projectId: string,
  limit = 50
): Promise<Array<{
  id: string
  intent: string
  strategy: string
  action: string
  durationMs: number
  success: boolean
  errorMsg: string | null
  createdAt: Date
}>> {
  try {
    return await prisma.executionLog.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        intent: true,
        strategy: true,
        action: true,
        durationMs: true,
        success: true,
        errorMsg: true,
        createdAt: true,
      },
    })
  } catch {
    return []
  }
}

/**
 * Get performance summary for a project.
 */
export async function getExecutionStats(projectId: string): Promise<{
  totalExecutions: number
  successRate: number
  avgDurationMs: number
  failedIntents: string[]
}> {
  try {
    const logs = await prisma.executionLog.findMany({
      where: { projectId, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      select: { success: true, durationMs: true, intent: true },
    })

    if (logs.length === 0) return { totalExecutions: 0, successRate: 1, avgDurationMs: 0, failedIntents: [] }

    const successes = logs.filter(l => l.success).length
    const avgDuration = logs.reduce((sum, l) => sum + l.durationMs, 0) / logs.length
    const failedIntents: string[] = [...new Set(logs.filter(l => !l.success).map(l => l.intent))]

    return {
      totalExecutions: logs.length,
      successRate: successes / logs.length,
      avgDurationMs: Math.round(avgDuration),
      failedIntents,
    }
  } catch {
    return { totalExecutions: 0, successRate: 1, avgDurationMs: 0, failedIntents: [] }
  }
}
