/**
 * PHASE 6: ERROR COMMUNICATION SYSTEM - Central Error Logging
 * 
 * Centralized error logging service with trace IDs and structured logging.
 * All errors flow through this service for consistent tracking and reporting.
 */

import { BackenlyError, ErrorDetails, ErrorCategory, ErrorSeverity, generateTraceId } from './types'

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'

/**
 * Structured log entry
 */
export interface LogEntry {
  timestamp: string
  level: LogLevel
  traceId: string
  category?: ErrorCategory
  message: string
  operation?: string
  resource?: string
  userId?: string
  projectId?: string
  metadata?: Record<string, any>
  error?: ErrorDetails
  stack?: string
}

/**
 * Error logger configuration
 */
export interface ErrorLoggerConfig {
  enableConsole: boolean
  enableFile: boolean
  minLevel: LogLevel
  includeStack: boolean
}

/**
 * Central error logger
 */
class ErrorLogger {
  private config: ErrorLoggerConfig = {
    enableConsole: true,
    enableFile: false,
    minLevel: 'info',
    includeStack: process.env.NODE_ENV !== 'production',
  }

  private logStore: LogEntry[] = []
  private maxLogEntries = 1000 // Keep last 1000 entries in memory

  /**
   * Configure the logger
   */
  configure(config: Partial<ErrorLoggerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Log an error
   */
  logError(error: unknown, context?: {
    operation?: string
    resource?: string
    userId?: string
    projectId?: string
    metadata?: Record<string, any>
  }): string {
    // Convert to BackenlyError if needed
    let backenlyError: BackenlyError
    
    if (error instanceof BackenlyError) {
      // Use existing error or create new one with added context
      if (context?.operation || context?.resource || context?.metadata) {
        backenlyError = new BackenlyError({
          message: error.message,
          category: error.category,
          severity: error.severity,
          recoveryAction: error.recoveryAction,
          retryable: error.retryable,
          retryInSeconds: error.retryInSeconds,
          actionText: error.actionText,
          actionUrl: error.actionUrl,
          operation: context?.operation || error.operation,
          resource: context?.resource || error.resource,
          originalError: error.originalError,
          metadata: { ...error.metadata, ...context?.metadata },
          traceId: error.traceId, // Keep same trace ID
        })
      } else {
        backenlyError = error
      }
    } else if (error instanceof Error) {
      // Wrap generic error
      backenlyError = new BackenlyError({
        message: error.message,
        category: 'internal',
        originalError: error,
        operation: context?.operation,
        resource: context?.resource,
        metadata: context?.metadata,
      })
    } else {
      // Unknown error type
      backenlyError = new BackenlyError({
        message: String(error),
        category: 'internal',
        originalError: error,
        operation: context?.operation,
        resource: context?.resource,
        metadata: context?.metadata,
      })
    }

    // Create log entry
    const logEntry: LogEntry = {
      timestamp: backenlyError.timestamp,
      level: this.severityToLogLevel(backenlyError.severity),
      traceId: backenlyError.traceId,
      category: backenlyError.category,
      message: backenlyError.message,
      operation: context?.operation || backenlyError.operation,
      resource: context?.resource || backenlyError.resource,
      userId: context?.userId,
      projectId: context?.projectId,
      metadata: context?.metadata || backenlyError.metadata,
      error: backenlyError.toLogFormat(),
      stack: this.config.includeStack ? backenlyError.stack : undefined,
    }

    // Store in memory
    this.addToStore(logEntry)

    // Console output
    if (this.config.enableConsole && this.shouldLog(logEntry.level)) {
      this.logToConsole(logEntry)
    }

    return backenlyError.traceId
  }

  /**
   * Log a message (non-error)
   */
  log(level: LogLevel, message: string, context?: {
    operation?: string
    resource?: string
    userId?: string
    projectId?: string
    metadata?: Record<string, any>
  }): string {
    const traceId = generateTraceId()

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      traceId,
      message,
      operation: context?.operation,
      resource: context?.resource,
      userId: context?.userId,
      projectId: context?.projectId,
      metadata: context?.metadata,
    }

    // Store in memory
    this.addToStore(logEntry)

    // Console output
    if (this.config.enableConsole && this.shouldLog(level)) {
      this.logToConsole(logEntry)
    }

    return traceId
  }

  /**
   * Get recent logs (for debugging/support)
   */
  getRecentLogs(limit: number = 100): LogEntry[] {
    return this.logStore.slice(-limit)
  }

  /**
   * Get logs by trace ID
   */
  getLogsByTraceId(traceId: string): LogEntry[] {
    return this.logStore.filter(entry => entry.traceId === traceId)
  }

  /**
   * Clear log store
   */
  clearLogs(): void {
    this.logStore = []
  }

  /**
   * Get logs by filter
   */
  getLogsByFilter(filter: {
    level?: LogLevel
    category?: ErrorCategory
    userId?: string
    projectId?: string
    operation?: string
    startTime?: string
    endTime?: string
  }): LogEntry[] {
    return this.logStore.filter(entry => {
      if (filter.level && entry.level !== filter.level) return false
      if (filter.category && entry.category !== filter.category) return false
      if (filter.userId && entry.userId !== filter.userId) return false
      if (filter.projectId && entry.projectId !== filter.projectId) return false
      if (filter.operation && entry.operation !== filter.operation) return false
      if (filter.startTime && entry.timestamp < filter.startTime) return false
      if (filter.endTime && entry.timestamp > filter.endTime) return false
      return true
    })
  }

  /**
   * Add entry to log store
   */
  private addToStore(entry: LogEntry): void {
    this.logStore.push(entry)
    
    // Trim if exceeds max
    if (this.logStore.length > this.maxLogEntries) {
      this.logStore = this.logStore.slice(-this.maxLogEntries)
    }
  }

  /**
   * Log to console with formatting
   */
  private logToConsole(entry: LogEntry): void {
    const prefix = `[${entry.level.toUpperCase()}] [${entry.traceId}]`
    const context = []
    
    if (entry.operation) context.push(`op=${entry.operation}`)
    if (entry.resource) context.push(`resource=${entry.resource}`)
    if (entry.projectId) context.push(`project=${entry.projectId}`)
    if (entry.userId) context.push(`user=${entry.userId}`)
    
    const contextStr = context.length > 0 ? ` (${context.join(', ')})` : ''
    const message = `${prefix} ${entry.message}${contextStr}`

    switch (entry.level) {
      case 'debug':
        console.debug(message, entry.metadata)
        break
      case 'info':
        console.info(message, entry.metadata)
        break
      case 'warn':
        console.warn(message, entry.metadata)
        if (entry.error) console.warn('Error details:', entry.error)
        break
      case 'error':
      case 'critical':
        console.error(message, entry.metadata)
        if (entry.error) console.error('Error details:', entry.error)
        if (entry.stack) console.error('Stack trace:', entry.stack)
        break
    }
  }

  /**
   * Convert error severity to log level
   */
  private severityToLogLevel(severity: ErrorSeverity): LogLevel {
    switch (severity) {
      case 'info': return 'info'
      case 'warning': return 'warn'
      case 'error': return 'error'
      case 'critical': return 'critical'
    }
  }

  /**
   * Check if log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical']
    const levelIndex = levels.indexOf(level)
    const minLevelIndex = levels.indexOf(this.config.minLevel)
    return levelIndex >= minLevelIndex
  }
}

// Singleton instance
const errorLogger = new ErrorLogger()

/**
 * Log an error with full context
 */
export function logError(error: unknown, context?: {
  operation?: string
  resource?: string
  userId?: string
  projectId?: string
  metadata?: Record<string, any>
}): string {
  return errorLogger.logError(error, context)
}

/**
 * Log a message
 */
export function log(level: LogLevel, message: string, context?: {
  operation?: string
  resource?: string
  userId?: string
  projectId?: string
  metadata?: Record<string, any>
}): string {
  return errorLogger.log(level, message, context)
}

/**
 * Configure the logger
 */
export function configureLogger(config: Partial<ErrorLoggerConfig>): void {
  errorLogger.configure(config)
}

/**
 * Get recent logs
 */
export function getRecentLogs(limit?: number): LogEntry[] {
  return errorLogger.getRecentLogs(limit)
}

/**
 * Get logs by trace ID
 */
export function getLogsByTraceId(traceId: string): LogEntry[] {
  return errorLogger.getLogsByTraceId(traceId)
}

/**
 * Get logs by filter
 */
export function getLogsByFilter(filter: {
  level?: LogLevel
  category?: ErrorCategory
  userId?: string
  projectId?: string
  operation?: string
  startTime?: string
  endTime?: string
}): LogEntry[] {
  return errorLogger.getLogsByFilter(filter)
}

/**
 * Clear all logs
 */
export function clearLogs(): void {
  errorLogger.clearLogs()
}

/**
 * Export singleton instance for advanced use
 */
export { errorLogger }
