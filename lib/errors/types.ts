/**
 * PHASE 6: ERROR COMMUNICATION SYSTEM
 * 
 * Centralized error types with trace IDs, actionable messages, and retry guidance.
 * Replaces all generic "Something went wrong" errors with specific, helpful feedback.
 */

/**
 * Error severity levels for user communication
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical'

/**
 * Error categories for classification and routing
 */
export type ErrorCategory =
  | 'validation'      // Input validation failures
  | 'authentication'  // Auth/session errors
  | 'authorization'   // Permission errors
  | 'database'        // Database/Prisma errors
  | 'network'         // Network/API errors
  | 'external'        // Third-party service errors
  | 'ai'              // AI/LLM errors
  | 'deployment'      // Deployment errors
  | 'storage'         // File storage errors
  | 'rate_limit'      // Rate limiting errors
  | 'internal'        // Internal server errors
  | 'not_found'       // Resource not found
  | 'conflict'        // Resource conflicts

/**
 * Recovery action types
 */
export type RecoveryAction = 
  | 'retry'           // User should retry the operation
  | 'retry_later'     // User should wait and retry
  | 'login'           // User needs to re-authenticate
  | 'contact_support' // User needs to contact support
  | 'check_input'     // User needs to correct their input
  | 'wait'            // User should wait (rate limit, etc.)
  | 'none'            // No action available

/**
 * Structured error details for logging and debugging
 */
export interface ErrorDetails {
  traceId: string
  timestamp: string
  category: ErrorCategory
  severity: ErrorSeverity
  
  // User-facing messages
  message: string              // Clear, actionable error message
  userMessage?: string         // Alternative user-friendly message
  technicalMessage?: string    // Technical details for advanced users
  
  // Recovery information
  recoveryAction: RecoveryAction
  retryable: boolean
  retryInSeconds?: number
  actionText?: string          // Button/link text (e.g., "Sign in", "Try again")
  actionUrl?: string           // URL for action button
  
  // Context
  operation?: string           // What was being attempted
  resource?: string            // What resource was affected
  userId?: string              // User ID (for logging)
  projectId?: string           // Project ID (for logging)
  
  // Technical details (for logging only)
  originalError?: any
  stack?: string
  metadata?: Record<string, any>
}

/**
 * Base error class for all Backenly errors
 */
export class BackenlyError extends Error {
  public readonly traceId: string
  public readonly timestamp: string
  public readonly category: ErrorCategory
  public readonly severity: ErrorSeverity
  public readonly recoveryAction: RecoveryAction
  public readonly retryable: boolean
  public readonly retryInSeconds?: number
  public readonly actionText?: string
  public readonly actionUrl?: string
  public readonly operation?: string
  public readonly resource?: string
  public readonly originalError?: any
  public readonly metadata?: Record<string, any>

  constructor(details: Partial<ErrorDetails> & { message: string, category: ErrorCategory }) {
    super(details.message)
    this.name = this.constructor.name
    this.traceId = details.traceId || generateTraceId()
    this.timestamp = details.timestamp || new Date().toISOString()
    this.category = details.category
    this.severity = details.severity || 'error'
    this.recoveryAction = details.recoveryAction || 'retry'
    this.retryable = details.retryable ?? true
    this.retryInSeconds = details.retryInSeconds
    this.actionText = details.actionText
    this.actionUrl = details.actionUrl
    this.operation = details.operation
    this.resource = details.resource
    this.originalError = details.originalError
    this.metadata = details.metadata
    
    // Capture stack trace
    Error.captureStackTrace(this, this.constructor)
  }

  /**
   * Convert to user-facing error details
   */
  toUserFacing(): ErrorDetails {
    return {
      traceId: this.traceId,
      timestamp: this.timestamp,
      category: this.category,
      severity: this.severity,
      message: this.message,
      recoveryAction: this.recoveryAction,
      retryable: this.retryable,
      retryInSeconds: this.retryInSeconds,
      actionText: this.actionText,
      actionUrl: this.actionUrl,
      operation: this.operation,
      resource: this.resource,
    }
  }

  /**
   * Convert to logging format with full details
   */
  toLogFormat(): ErrorDetails {
    return {
      ...this.toUserFacing(),
      originalError: this.originalError,
      stack: this.stack,
      metadata: this.metadata,
    }
  }
}

/**
 * Validation error - user input is invalid
 */
export class ValidationError extends BackenlyError {
  constructor(message: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'validation',
      severity: 'warning',
      recoveryAction: 'check_input',
      retryable: true,
      actionText: 'Fix input and try again',
    })
  }
}

/**
 * Authentication error - user needs to log in
 */
export class AuthenticationError extends BackenlyError {
  constructor(message: string = 'Your session has expired', details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'authentication',
      severity: 'warning',
      recoveryAction: 'login',
      retryable: false,
      actionText: 'Sign in again',
      actionUrl: '/auth/login',
    })
  }
}

/**
 * Authorization error - user lacks permission
 */
export class AuthorizationError extends BackenlyError {
  constructor(message: string = 'You don\'t have permission to do that', details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'authorization',
      severity: 'warning',
      recoveryAction: 'none',
      retryable: false,
    })
  }
}

/**
 * Database error - database operation failed
 */
export class DatabaseError extends BackenlyError {
  constructor(message: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'database',
      severity: 'error',
      recoveryAction: 'retry',
      retryable: true,
      actionText: 'Try again',
    })
  }
}

/**
 * Network error - network/API call failed
 */
export class NetworkError extends BackenlyError {
  constructor(message: string = 'Connection issue - try again in a moment', details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'network',
      severity: 'warning',
      recoveryAction: 'retry_later',
      retryable: true,
      retryInSeconds: 30,
      actionText: 'Retry',
    })
  }
}

/**
 * External service error - third-party service failed
 */
export class ExternalServiceError extends BackenlyError {
  constructor(service: string, message?: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message: message || `${service} is temporarily unavailable`,
      category: 'external',
      severity: 'error',
      recoveryAction: 'retry_later',
      retryable: true,
      retryInSeconds: 60,
      resource: service,
      actionText: 'Try again in a moment',
    })
  }
}

/**
 * AI/LLM error - AI processing failed
 */
export class AIError extends BackenlyError {
  constructor(message: string = 'AI processing failed - try rephrasing', details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'ai',
      severity: 'error',
      recoveryAction: 'retry',
      retryable: true,
      actionText: 'Try rephrasing',
    })
  }
}

/**
 * Deployment error - deployment failed
 */
export class DeploymentError extends BackenlyError {
  constructor(message: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'deployment',
      severity: 'error',
      recoveryAction: 'contact_support',
      retryable: false,
      actionText: 'Contact support',
    })
  }
}

/**
 * Storage error - file storage operation failed
 */
export class StorageError extends BackenlyError {
  constructor(message: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'storage',
      severity: 'error',
      recoveryAction: 'retry',
      retryable: true,
      actionText: 'Try again',
    })
  }
}

/**
 * Rate limit error - user exceeded rate limit
 */
export class RateLimitError extends BackenlyError {
  constructor(retryInSeconds: number = 60, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message: `Slow down - wait ${retryInSeconds} seconds before trying again`,
      category: 'rate_limit',
      severity: 'warning',
      recoveryAction: 'wait',
      retryable: true,
      retryInSeconds,
      actionText: 'Wait and try again',
    })
  }
}

/**
 * Not found error - resource doesn't exist
 */
export class NotFoundError extends BackenlyError {
  constructor(resource: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message: `${resource} not found`,
      category: 'not_found',
      severity: 'warning',
      recoveryAction: 'none',
      retryable: false,
      resource,
    })
  }
}

/**
 * Conflict error - resource conflict (duplicate, concurrent modification, etc.)
 */
export class ConflictError extends BackenlyError {
  constructor(message: string, details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'conflict',
      severity: 'warning',
      recoveryAction: 'check_input',
      retryable: true,
      actionText: 'Check and try again',
    })
  }
}

/**
 * Internal error - internal server error
 */
export class InternalError extends BackenlyError {
  constructor(message: string = 'Internal error occurred', details?: Partial<ErrorDetails>) {
    super({
      ...details,
      message,
      category: 'internal',
      severity: 'critical',
      recoveryAction: 'contact_support',
      retryable: false,
      actionText: 'Contact support',
    })
  }
}

/**
 * Generate unique trace ID for error tracking
 */
export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return `${timestamp}-${random}`
}

/**
 * Error response format for APIs
 */
export interface ErrorResponse {
  error: {
    message: string
    traceId: string
    category: ErrorCategory
    severity: ErrorSeverity
    retryable: boolean
    retryInSeconds?: number
    actionText?: string
    actionUrl?: string
    operation?: string
  }
}

/**
 * Convert any error to ErrorResponse format
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof BackenlyError) {
    const details = error.toUserFacing()
    return {
      error: {
        message: details.message,
        traceId: details.traceId,
        category: details.category,
        severity: details.severity,
        retryable: details.retryable,
        retryInSeconds: details.retryInSeconds,
        actionText: details.actionText,
        actionUrl: details.actionUrl,
        operation: details.operation,
      },
    }
  }

  // Unknown error - wrap in generic BackenlyError
  const traceId = generateTraceId()
  const message = error instanceof Error ? error.message : 'An unexpected error occurred'
  
  return {
    error: {
      message,
      traceId,
      category: 'internal',
      severity: 'error',
      retryable: false,
      actionText: 'Contact support if this persists',
    },
  }
}
