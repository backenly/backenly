/**
 * Observability Layer
 * 
 * PHASE 4: Production Observability
 * 
 * Provides:
 * - Structured JSON logging
 * - Request ID tracking
 * - Mutation metrics collection
 * - Error aggregation
 * - Performance monitoring
 */

import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'

// ============================================================================
// LOG LEVELS
// ============================================================================
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
}

const CURRENT_LOG_LEVEL = (process.env.LOG_LEVEL as LogLevel) || 'info'

// ============================================================================
// STRUCTURED LOG ENTRY
// ============================================================================
export interface LogEntry {
  // Required fields
  timestamp: string
  level: LogLevel
  message: string
  requestId: string
  
  // Context
  service: string
  environment: string
  version: string
  
  // Mutation context (when applicable)
  mutation?: {
    projectId: string
    intent: string
    success: boolean
    durationMs: number
    graphVersion: number
    refusalReason?: string
    executionState: string
  }
  
  // Error context
  error?: {
    type: string
    message: string
    stack?: string
    code?: string
  }
  
  // Performance
  performance?: {
    dbQueryCount: number
    dbQueryTimeMs: number
    aiCallTimeMs?: number
  }
  
  // Metadata
  metadata?: Record<string, unknown>
}

// ============================================================================
// METRICS COLLECTION
// ============================================================================
interface MutationMetrics {
  totalCount: number
  successCount: number
  failureCount: number
  refusalCount: number
  totalDurationMs: number
  refusalReasons: Record<string, number>
}

interface ObservabilityMetrics {
  mutations: MutationMetrics
  errors: Record<string, number>
  latencies: number[] // Last 1000 latency measurements
}

const metrics: ObservabilityMetrics = {
  mutations: {
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    refusalCount: 0,
    totalDurationMs: 0,
    refusalReasons: {},
  },
  errors: {},
  latencies: [],
}

// ============================================================================
// REQUEST CONTEXT
// ============================================================================
class RequestContext {
  private requestId: string
  private startTime: number
  private dbQueryCount: number
  private dbQueryTimeMs: number
  
  constructor(requestId?: string) {
    this.requestId = requestId || randomUUID()
    this.startTime = Date.now()
    this.dbQueryCount = 0
    this.dbQueryTimeMs = 0
  }
  
  getRequestId(): string {
    return this.requestId
  }
  
  getDurationMs(): number {
    return Date.now() - this.startTime
  }
  
  recordDbQuery(durationMs: number): void {
    this.dbQueryCount++
    this.dbQueryTimeMs += durationMs
  }
  
  getDbMetrics(): { count: number; timeMs: number } {
    return { count: this.dbQueryCount, timeMs: this.dbQueryTimeMs }
  }
}

// AsyncLocalStorage for request context propagation
const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

// ============================================================================
// LOGGER
// ============================================================================
export class Logger {
  private service: string
  private version: string
  
  constructor(service: string, version: string = '1.0.0') {
    this.service = service
    this.version = version
  }
  
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[CURRENT_LOG_LEVEL]
  }
  
  private createLogEntry(
    level: LogLevel,
    message: string,
    context?: Partial<LogEntry>
  ): LogEntry {
    const requestContext = asyncLocalStorage.getStore()
    
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      requestId: requestContext?.getRequestId() || 'no-request',
      service: this.service,
      environment: process.env.NODE_ENV || 'development',
      version: this.version,
      ...context,
    }
  }
  
  private output(entry: LogEntry): void {
    const isProduction = process.env.NODE_ENV === 'production'
    
    if (isProduction) {
      // Structured JSON logging in production
      console.log(JSON.stringify(entry))
    } else {
      // Human-readable logging in development
      const color = this.getColor(entry.level)
      const duration = entry.mutation ? `(${entry.mutation.durationMs}ms)` : ''
      console.log(
        `${color}[${entry.level.toUpperCase()}]${'\x1b[0m'} ` +
        `[${entry.requestId.slice(0, 8)}] ` +
        `${entry.message} ` +
        `${duration}`
      )
      
      if (entry.error) {
        console.error('  Error:', entry.error.message)
        if (entry.error.stack) {
          console.error('  Stack:', entry.error.stack.split('\n').slice(0, 3).join('\n'))
        }
      }
    }
  }
  
  private getColor(level: LogLevel): string {
    const colors: Record<LogLevel, string> = {
      debug: '\x1b[36m',   // Cyan
      info: '\x1b[32m',    // Green
      warn: '\x1b[33m',    // Yellow
      error: '\x1b[31m',   // Red
      fatal: '\x1b[35m',   // Magenta
    }
    return colors[level] || '\x1b[0m'
  }
  
  debug(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      this.output(this.createLogEntry('debug', message, { metadata }))
    }
  }
  
  info(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      this.output(this.createLogEntry('info', message, { metadata }))
    }
  }
  
  warn(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      this.output(this.createLogEntry('warn', message, { metadata }))
    }
  }
  
  error(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      this.output(this.createLogEntry('error', message, {
        error: error ? {
          type: error.constructor.name,
          message: error.message,
          stack: error.stack,
          code: (error as any).code,
        } : undefined,
        metadata,
      }))
    }
  }
  
  fatal(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    this.output(this.createLogEntry('fatal', message, {
      error: error ? {
        type: error.constructor.name,
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      } : undefined,
      metadata,
    }))
  }
  
  mutation(
    message: string,
    mutationData: {
      projectId: string
      intent: string
      success: boolean
      durationMs: number
      graphVersion: number
      refusalReason?: string
      executionState: string
    }
  ): void {
    const requestContext = asyncLocalStorage.getStore()
    const dbMetrics = requestContext?.getDbMetrics()
    
    this.output(this.createLogEntry('info', message, {
      mutation: mutationData,
      performance: dbMetrics ? {
        dbQueryCount: dbMetrics.count,
        dbQueryTimeMs: dbMetrics.timeMs,
      } : undefined,
    }))
    
    // Update metrics
    this.updateMetrics(mutationData)
  }
  
  private updateMetrics(mutationData: LogEntry['mutation']): void {
    if (!mutationData) return
    
    metrics.mutations.totalCount++
    metrics.mutations.totalDurationMs += mutationData.durationMs
    
    if (mutationData.success) {
      metrics.mutations.successCount++
    } else if (mutationData.refusalReason) {
      metrics.mutations.refusalCount++
      metrics.mutations.refusalReasons[mutationData.refusalReason] = 
        (metrics.mutations.refusalReasons[mutationData.refusalReason] || 0) + 1
    } else {
      metrics.mutations.failureCount++
    }
    
    // Keep last 1000 latencies
    metrics.latencies.push(mutationData.durationMs)
    if (metrics.latencies.length > 1000) {
      metrics.latencies.shift()
    }
  }
}

// ============================================================================
// GLOBAL LOGGER INSTANCE
// ============================================================================
export const logger = new Logger('backenly-orchestration', '1.0.0')

// ============================================================================
// REQUEST CONTEXT MANAGEMENT
// ============================================================================
export function withRequestContext<T>(
  requestId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const context = new RequestContext(requestId)
  return asyncLocalStorage.run(context, fn)
}

export function getCurrentRequestId(): string | undefined {
  return asyncLocalStorage.getStore()?.getRequestId()
}

export function recordDbQuery(durationMs: number): void {
  asyncLocalStorage.getStore()?.recordDbQuery(durationMs)
}

// ============================================================================
// METRICS EXPORT
// ============================================================================
export function getMetrics(): {
  mutations: {
    total: number
    success: number
    failure: number
    refusal: number
    successRate: number
    averageLatencyMs: number
    p95LatencyMs: number
    refusalReasons: Record<string, number>
  }
  errors: Record<string, number>
} {
  const sortedLatencies = [...metrics.latencies].sort((a, b) => a - b)
  const p95Index = Math.floor(sortedLatencies.length * 0.95)
  
  return {
    mutations: {
      total: metrics.mutations.totalCount,
      success: metrics.mutations.successCount,
      failure: metrics.mutations.failureCount,
      refusal: metrics.mutations.refusalCount,
      successRate: metrics.mutations.totalCount > 0
        ? (metrics.mutations.successCount / metrics.mutations.totalCount) * 100
        : 0,
      averageLatencyMs: metrics.mutations.totalCount > 0
        ? metrics.mutations.totalDurationMs / metrics.mutations.totalCount
        : 0,
      p95LatencyMs: sortedLatencies[p95Index] || 0,
      refusalReasons: metrics.mutations.refusalReasons,
    },
    errors: metrics.errors,
  }
}

export function recordError(errorType: string): void {
  metrics.errors[errorType] = (metrics.errors[errorType] || 0) + 1
}

// ============================================================================
// MIDDLEWARE WRAPPER
// ============================================================================
export function createObservabilityMiddleware() {
  return async function observabilityMiddleware(
    request: Request,
    next: () => Promise<Response>
  ): Promise<Response> {
    const requestId = request.headers.get('x-request-id') || randomUUID()
    
    return withRequestContext(requestId, async () => {
      const startTime = Date.now()
      
      logger.info('Request started', {
        method: request.method,
        url: request.url,
        userAgent: request.headers.get('user-agent'),
      })
      
      try {
        const response = await next()
        
        logger.info('Request completed', {
          status: response.status,
          durationMs: Date.now() - startTime,
        })
        
        // Add request ID to response headers
        const newResponse = new Response(response.body, response)
        newResponse.headers.set('x-request-id', requestId)
        return newResponse
      } catch (error) {
        logger.error('Request failed', error as Error, {
          durationMs: Date.now() - startTime,
        })
        throw error
      }
    })
  }
}
