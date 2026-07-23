import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export type LogType = 'api' | 'auth' | 'database' | 'function' | 'system'
export type LogSeverity = 'error' | 'warning' | 'info' | 'debug'

export interface LogData {
  type: LogType
  severity: LogSeverity
  message: string
  service?: string
  endpoint?: string
  method?: string
  statusCode?: number
  userId?: string
  projectId?: string
  metadata?: Record<string, any>
  stackTrace?: string
  duration?: number
  timestamp?: Date
}

/**
 * Create a structured log entry
 */
export async function createLog(data: LogData) {
  try {
    const log = await prisma.log.create({
      data: {
        type: data.type,
        severity: data.severity,
        message: data.message,
        service: data.service,
        endpoint: data.endpoint,
        method: data.method,
        statusCode: data.statusCode,
        userId: data.userId,
        projectId: data.projectId,
        metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : null,
        stackTrace: data.stackTrace,
        duration: data.duration,
        timestamp: data.timestamp || new Date(),
      },
    })
    return log
  } catch (error) {
    console.error('Failed to create log:', error)
    // Don't throw - logging should never break the application
    return null
  }
}

/**
 * Log an API request
 */
export async function logApiRequest(data: {
  endpoint: string
  method: string
  statusCode: number
  duration: number
  userId?: string
  projectId?: string
  metadata?: Record<string, any>
}) {
  const severity: LogSeverity = 
    data.statusCode >= 500 ? 'error' :
    data.statusCode >= 400 ? 'warning' :
    'info'

  return createLog({
    type: 'api',
    severity,
    message: `${data.method} ${data.endpoint} - ${data.statusCode}`,
    service: 'api',
    endpoint: data.endpoint,
    method: data.method,
    statusCode: data.statusCode,
    duration: data.duration,
    userId: data.userId,
    projectId: data.projectId,
    metadata: data.metadata,
  })
}

/**
 * Log a database query
 */
export async function logDatabaseQuery(data: {
  query: string
  duration: number
  projectId?: string
  metadata?: Record<string, any>
  error?: Error
}) {
  const severity: LogSeverity = data.error ? 'error' : 'info'

  return createLog({
    type: 'database',
    severity,
    message: data.error ? `Database query failed: ${data.error.message}` : 'Database query executed',
    service: 'database',
    duration: data.duration,
    projectId: data.projectId,
    metadata: {
      ...data.metadata,
      query: data.query.substring(0, 500), // Truncate long queries
    },
    stackTrace: data.error?.stack,
  })
}

/**
 * Log an authentication event
 */
export async function logAuthEvent(data: {
  event: string
  userId?: string
  projectId?: string // Optional for auth events (login/signup happen before project creation)
  success: boolean
  metadata?: Record<string, any>
  error?: Error
}) {
  const severity: LogSeverity = data.error || !data.success ? 'warning' : 'info'

  return createLog({
    type: 'auth',
    severity,
    message: data.error ? `Auth ${data.event} failed: ${data.error.message}` : `Auth ${data.event} ${data.success ? 'succeeded' : 'failed'}`,
    service: 'auth',
    userId: data.userId,
    projectId: data.projectId, // Optional - auth events may not have a project yet
    metadata: data.metadata,
    stackTrace: data.error?.stack,
  })
}

/**
 * Log a function execution
 */
export async function logFunctionExecution(data: {
  functionName: string
  duration: number
  projectId?: string
  success: boolean
  metadata?: Record<string, any>
  error?: Error
}) {
  const severity: LogSeverity = data.error || !data.success ? 'error' : 'info'

  return createLog({
    type: 'function',
    severity,
    message: data.error 
      ? `Function ${data.functionName} failed: ${data.error.message}`
      : `Function ${data.functionName} executed successfully`,
    service: 'function',
    duration: data.duration,
    projectId: data.projectId,
    metadata: {
      ...data.metadata,
      functionName: data.functionName,
    },
    stackTrace: data.error?.stack,
  })
}

/**
 * Log a system event
 */
export async function logSystemEvent(data: {
  message: string
  severity: LogSeverity
  metadata?: Record<string, any>
  error?: Error
}) {
  return createLog({
    type: 'system',
    severity: data.severity,
    message: data.message,
    service: 'system',
    metadata: data.metadata,
    stackTrace: data.error?.stack,
  })
}

