/**
 * PHASE 11: ERROR COMMUNICATION SYSTEM HARDENING
 * 
 * Comprehensive error codes with actionable recovery steps
 * Eliminates all generic "Something went wrong" errors
 */

import { generateTraceId } from '@/lib/utils'

/**
 * Error code format: AREA_SPECIFIC_ISSUE
 * Examples: UNDO_VALIDATION_FAILURE, DEPLOY_CONTAINER_CRASH, STORAGE_PROVISIONING_FAILED
 */
export type ErrorCode =
  // Execution errors
  | 'EXECUTE_AI_PARSING_FAILED'
  | 'EXECUTE_VALIDATION_FAILED'
  | 'EXECUTE_SAFETY_BLOCKED'
  | 'EXECUTE_DATABASE_ERROR'
  | 'EXECUTE_TIMEOUT'
  | 'EXECUTE_ROLLBACK_FAILED'
  
  // Undo errors
  | 'UNDO_NO_HISTORY'
  | 'UNDO_VALIDATION_FAILURE'
  | 'UNDO_MISSING_SNAPSHOT'
  | 'UNDO_ROLLBACK_FAILED'
  | 'UNDO_DATABASE_ERROR'
  | 'UNDO_STATE_MISMATCH'
  
  // Deployment errors
  | 'DEPLOY_NO_CHANGES'
  | 'DEPLOY_ALREADY_DEPLOYING'
  | 'DEPLOY_CONTAINER_CRASH'
  | 'DEPLOY_PORT_BINDING_FAILED'
  | 'DEPLOY_DATABASE_CONNECTION_FAILED'
  | 'DEPLOY_HEALTH_CHECK_FAILED'
  | 'DEPLOY_TIMEOUT'
  | 'DEPLOY_FILE_SYNC_FAILED'
  | 'DEPLOY_SCHEMA_GENERATION_FAILED'
  
  // Storage errors
  | 'STORAGE_PROVISIONING_FAILED'
  | 'STORAGE_BUCKET_NOT_FOUND'
  | 'STORAGE_UPLOAD_FAILED'
  | 'STORAGE_DOWNLOAD_FAILED'
  | 'STORAGE_DELETE_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_INVALID_FILE'
  
  // Integration errors
  | 'INTEGRATION_AUTH_FAILED'
  | 'INTEGRATION_CONNECTION_FAILED'
  | 'INTEGRATION_RATE_LIMIT'
  | 'INTEGRATION_INVALID_CONFIG'
  | 'INTEGRATION_SERVICE_UNAVAILABLE'
  
  // Database errors
  | 'DATABASE_CONNECTION_LOST'
  | 'DATABASE_QUERY_FAILED'
  | 'DATABASE_CONSTRAINT_VIOLATION'
  | 'DATABASE_TIMEOUT'
  | 'DATABASE_PROVISIONING_FAILED'
  
  // Authentication errors
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_PERMISSION_DENIED'
  
  // Generic errors (use sparingly)
  | 'INTERNAL_ERROR'
  | 'UNKNOWN_ERROR'

/**
 * Structured error response format
 */
export interface StructuredErrorResponse {
  code: ErrorCode
  message: string
  reason: string
  recovery: string[]
  traceId: string
  timestamp: string
  retryable: boolean
  retryInSeconds?: number
  metadata?: Record<string, any>
}

/**
 * Error code definitions with default messages and recovery steps
 */
export const ERROR_DEFINITIONS: Record<ErrorCode, {
  message: string
  reason: string
  recovery: string[]
  retryable: boolean
  retryInSeconds?: number
}> = {
  // Execution errors
  EXECUTE_AI_PARSING_FAILED: {
    message: 'Could not understand your request',
    reason: 'The AI could not parse your intent into a valid backend change',
    recovery: [
      'Try rephrasing your request more clearly',
      'Use simpler language and be specific',
      'Break down complex requests into smaller steps'
    ],
    retryable: true
  },
  
  EXECUTE_VALIDATION_FAILED: {
    message: 'Your request failed validation',
    reason: 'The requested change conflicts with your current backend state or safety rules',
    recovery: [
      'Check the Database section to see your current backend state',
      'Make sure you\'re not creating duplicate resources',
      'Verify the change is safe and reversible'
    ],
    retryable: true
  },
  
  EXECUTE_SAFETY_BLOCKED: {
    message: 'This change was blocked for safety',
    reason: 'The requested change could cause data loss or break your backend',
    recovery: [
      'Review the safety warnings in the response',
      'Modify your request to be less destructive',
      'Open the Database section to understand the impact'
    ],
    retryable: false
  },
  
  EXECUTE_DATABASE_ERROR: {
    message: 'Database operation failed',
    reason: 'Could not save the changes to your workspace database',
    recovery: [
      'Wait a moment and try again',
      'Check if your database is accessible',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  EXECUTE_TIMEOUT: {
    message: 'Request timed out',
    reason: 'The operation took too long to complete',
    recovery: [
      'Try a simpler request',
      'Wait a moment for the system to catch up',
      'Contact support if your requests consistently timeout'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  EXECUTE_ROLLBACK_FAILED: {
    message: 'Failed to roll back after error',
    reason: 'An error occurred and the automatic rollback also failed',
    recovery: [
      'Check the Database section to see your backend state',
      'Use the Undo button to manually revert',
      'Contact support immediately with your trace ID'
    ],
    retryable: false
  },
  
  // Undo errors
  UNDO_NO_HISTORY: {
    message: 'Nothing to undo yet',
    reason: 'Your backend hasn\'t been changed yet',
    recovery: [
      'Make a change first, then you can undo it',
      'Check the Timeline panel to see your change history'
    ],
    retryable: false
  },
  
  UNDO_VALIDATION_FAILURE: {
    message: 'Cannot undo this change',
    reason: 'The last change doesn\'t have rollback information or is not reversible',
    recovery: [
      'Check the Timeline to see which change failed',
      'Use History to revert an earlier change',
      'Contact support with your trace ID'
    ],
    retryable: false
  },
  
  UNDO_MISSING_SNAPSHOT: {
    message: 'Missing rollback snapshot',
    reason: 'The snapshot needed to undo this change is missing or corrupted',
    recovery: [
      'Check the Timeline for an earlier change to undo',
      'Use the Database section to see your current state',
      'Contact support to recover your state history'
    ],
    retryable: false
  },
  
  UNDO_ROLLBACK_FAILED: {
    message: 'Undo operation failed',
    reason: 'Could not safely revert to the previous state',
    recovery: [
      'Check History to see what changed',
      'Try undoing again in a few moments',
      'Contact support with your trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  UNDO_DATABASE_ERROR: {
    message: 'Database error during undo',
    reason: 'Could not access your change history from the database',
    recovery: [
      'Wait a moment and try undoing again',
      'Check if your database is accessible',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  UNDO_STATE_MISMATCH: {
    message: 'Backend state has changed',
    reason: 'Your backend state doesn\'t match the expected state for this undo',
    recovery: [
      'Refresh the page to sync your state',
      'Check the Database section for the current state',
      'Try undoing the most recent change instead'
    ],
    retryable: false
  },
  
  // Deployment errors
  DEPLOY_NO_CHANGES: {
    message: 'Nothing to deploy',
    reason: 'There are no pending changes to deploy',
    recovery: [
      'Make changes to your backend first',
      'Check the Database section to see your current state',
      'Use the Timeline to see your change history'
    ],
    retryable: false
  },
  
  DEPLOY_ALREADY_DEPLOYING: {
    message: 'Deployment already in progress',
    reason: 'A deployment is currently running for this project',
    recovery: [
      'Wait for the current deployment to finish',
      'Check the Deploy panel for status updates',
      'If stuck, contact support'
    ],
    retryable: false
  },
  
  DEPLOY_CONTAINER_CRASH: {
    message: 'Container failed to start',
    reason: 'Docker encountered an error while creating your isolated runtime',
    recovery: [
      'Make sure Docker is running',
      'Check if you have enough system resources',
      'Try deploying again in a moment',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 30
  },
  
  DEPLOY_PORT_BINDING_FAILED: {
    message: 'Port allocation failed',
    reason: 'All available ports are currently in use',
    recovery: [
      'Wait a moment and try deploying again',
      'Some deployments may need to finish first',
      'Contact support if your project never deploys'
    ],
    retryable: true,
    retryInSeconds: 30
  },
  
  DEPLOY_DATABASE_CONNECTION_FAILED: {
    message: 'Database connection failed',
    reason: 'Could not connect to your workspace database during deployment',
    recovery: [
      'Wait a moment and try deploying again',
      'Check if your database is accessible',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  DEPLOY_HEALTH_CHECK_FAILED: {
    message: 'Health check failed',
    reason: 'Your backend started but didn\'t respond to health checks',
    recovery: [
      'Wait a moment - your backend may need more time to initialize',
      'Try deploying again',
      'Check the Deploy logs for specific errors',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 30
  },
  
  DEPLOY_TIMEOUT: {
    message: 'Deployment timed out',
    reason: 'Your infrastructure is taking longer than expected to start',
    recovery: [
      'Try deploying again in a moment',
      'Check system status for infrastructure issues',
      'Simplify your backend if it\'s very complex',
      'Contact support if timeouts persist'
    ],
    retryable: true,
    retryInSeconds: 60
  },
  
  DEPLOY_FILE_SYNC_FAILED: {
    message: 'Workspace file sync failed',
    reason: 'Could not prepare your API files for deployment',
    recovery: [
      'Your workspace data is safe',
      'Try deploying again',
      'Check the Database section for any schema issues',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  DEPLOY_SCHEMA_GENERATION_FAILED: {
    message: 'Database schema generation failed',
    reason: 'Your schema configuration needs attention',
    recovery: [
      'Check the Database section for any schema warnings',
      'Make sure all tables have valid column types',
      'Try deploying again after fixing schema issues',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  // Storage errors
  STORAGE_PROVISIONING_FAILED: {
    message: 'Storage bucket creation failed',
    reason: 'Could not create your storage bucket in the cloud provider',
    recovery: [
      'Wait a moment and try again',
      'Check if your storage provider is accessible',
      'Verify your storage credentials are configured',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  STORAGE_BUCKET_NOT_FOUND: {
    message: 'Storage bucket not found',
    reason: 'The requested storage bucket doesn\'t exist',
    recovery: [
      'Check the Storage panel for available buckets',
      'Create a storage bucket first',
      'Verify the bucket name is correct'
    ],
    retryable: false
  },
  
  STORAGE_UPLOAD_FAILED: {
    message: 'File upload failed',
    reason: 'Could not upload the file to storage',
    recovery: [
      'Check your internet connection',
      'Verify the file size is within limits',
      'Try uploading again',
      'Contact support if uploads consistently fail'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  STORAGE_DOWNLOAD_FAILED: {
    message: 'File download failed',
    reason: 'Could not download the file from storage',
    recovery: [
      'Check your internet connection',
      'Verify the file exists',
      'Try downloading again',
      'Contact support if downloads consistently fail'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  STORAGE_DELETE_FAILED: {
    message: 'File deletion failed',
    reason: 'Could not delete the file from storage',
    recovery: [
      'Check if the file exists',
      'Verify you have permission to delete',
      'Try deleting again',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  STORAGE_QUOTA_EXCEEDED: {
    message: 'Storage quota exceeded',
    reason: 'You\'ve reached your storage limit',
    recovery: [
      'Delete some files to free up space',
      'Upgrade your plan for more storage',
      'Contact support to discuss your storage needs'
    ],
    retryable: false
  },
  
  STORAGE_INVALID_FILE: {
    message: 'Invalid file',
    reason: 'The file type or format is not supported',
    recovery: [
      'Check the allowed file types',
      'Convert your file to a supported format',
      'Contact support if you need a specific file type'
    ],
    retryable: false
  },
  
  // Integration errors
  INTEGRATION_AUTH_FAILED: {
    message: 'Integration authentication failed',
    reason: 'Could not authenticate with the external service',
    recovery: [
      'Re-connect your integration',
      'Check if your credentials are still valid',
      'Verify the service is accessible',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  INTEGRATION_CONNECTION_FAILED: {
    message: 'Integration connection failed',
    reason: 'Could not connect to the external service',
    recovery: [
      'Check your internet connection',
      'Verify the service is online',
      'Try again in a moment',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 30
  },
  
  INTEGRATION_RATE_LIMIT: {
    message: 'Integration rate limit exceeded',
    reason: 'Too many requests to the external service',
    recovery: [
      'Wait a few minutes before trying again',
      'Reduce the frequency of your requests',
      'Check the service\'s rate limit documentation'
    ],
    retryable: true,
    retryInSeconds: 300
  },
  
  INTEGRATION_INVALID_CONFIG: {
    message: 'Integration configuration invalid',
    reason: 'The integration settings are incorrect or incomplete',
    recovery: [
      'Check your integration settings',
      'Re-configure the integration',
      'Verify all required fields are filled',
      'Contact support if you need help'
    ],
    retryable: false
  },
  
  INTEGRATION_SERVICE_UNAVAILABLE: {
    message: 'Integration service unavailable',
    reason: 'The external service is temporarily down',
    recovery: [
      'Wait for the service to come back online',
      'Check the service\'s status page',
      'Try again in a few minutes',
      'Contact support if the service stays down'
    ],
    retryable: true,
    retryInSeconds: 300
  },
  
  // Database errors
  DATABASE_CONNECTION_LOST: {
    message: 'Database connection lost',
    reason: 'Lost connection to your workspace database',
    recovery: [
      'Wait a moment and try again',
      'Check if your database is accessible',
      'Verify your database credentials',
      'Contact support if this persists'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  DATABASE_QUERY_FAILED: {
    message: 'Database query failed',
    reason: 'The database query could not be executed',
    recovery: [
      'Wait a moment and try again',
      'Check the Database section for schema issues',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 5
  },
  
  DATABASE_CONSTRAINT_VIOLATION: {
    message: 'Database constraint violation',
    reason: 'The operation violates a database constraint (unique, foreign key, etc.)',
    recovery: [
      'Check the Database section for conflicting data',
      'Modify your request to avoid the conflict',
      'Delete conflicting records if safe'
    ],
    retryable: false
  },
  
  DATABASE_TIMEOUT: {
    message: 'Database query timeout',
    reason: 'The database query took too long to execute',
    recovery: [
      'Wait a moment and try again',
      'Simplify your query if possible',
      'Contact support if timeouts persist'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  DATABASE_PROVISIONING_FAILED: {
    message: 'Database provisioning failed',
    reason: 'Could not create or configure your database',
    recovery: [
      'Wait a moment and try again',
      'Check system status for database issues',
      'Contact support immediately with trace ID'
    ],
    retryable: true,
    retryInSeconds: 30
  },
  
  // Authentication errors
  AUTH_SESSION_EXPIRED: {
    message: 'Your session has expired',
    reason: 'You need to sign in again',
    recovery: [
      'Click "Sign in" to authenticate',
      'You\'ll be redirected back after signing in'
    ],
    retryable: false
  },
  
  AUTH_INVALID_CREDENTIALS: {
    message: 'Invalid credentials',
    reason: 'The username or password is incorrect',
    recovery: [
      'Check your credentials and try again',
      'Use "Forgot password" if needed',
      'Contact support if you\'re locked out'
    ],
    retryable: true
  },
  
  AUTH_TOKEN_INVALID: {
    message: 'Invalid authentication token',
    reason: 'Your authentication token is invalid or expired',
    recovery: [
      'Sign in again to get a new token',
      'Clear your browser cache if this persists'
    ],
    retryable: false
  },
  
  AUTH_PERMISSION_DENIED: {
    message: 'Permission denied',
    reason: 'You don\'t have permission to perform this action',
    recovery: [
      'Contact the project owner for access',
      'Verify you\'re using the correct account'
    ],
    retryable: false
  },
  
  // Generic errors
  INTERNAL_ERROR: {
    message: 'Internal server error',
    reason: 'An unexpected error occurred on the server',
    recovery: [
      'Wait a moment and try again',
      'Contact support with trace ID if this persists'
    ],
    retryable: true,
    retryInSeconds: 10
  },
  
  UNKNOWN_ERROR: {
    message: 'An unexpected error occurred',
    reason: 'The error type could not be determined',
    recovery: [
      'Try again in a moment',
      'Contact support with trace ID for investigation'
    ],
    retryable: true,
    retryInSeconds: 10
  }
}

/**
 * Create a structured error response
 */
export function createStructuredError(
  code: ErrorCode,
  options?: {
    customMessage?: string
    customReason?: string
    customRecovery?: string[]
    traceId?: string
    metadata?: Record<string, any>
  }
): StructuredErrorResponse {
  const definition = ERROR_DEFINITIONS[code]
  const traceId = options?.traceId || generateTraceId()
  
  return {
    code,
    message: options?.customMessage || definition.message,
    reason: options?.customReason || definition.reason,
    recovery: options?.customRecovery || definition.recovery,
    traceId,
    timestamp: new Date().toISOString(),
    retryable: definition.retryable,
    retryInSeconds: definition.retryInSeconds,
    metadata: options?.metadata
  }
}

/**
 * Log structured error to console and database
 */
export async function logStructuredError(
  error: StructuredErrorResponse,
  context?: {
    userId?: string
    projectId?: string
    operation?: string
    stack?: string
  }
): Promise<void> {
  // Console logging
  console.error(`[Error ${error.code}] ${error.message}`)
  console.error(`  Trace ID: ${error.traceId}`)
  console.error(`  Reason: ${error.reason}`)
  console.error(`  Recovery: ${error.recovery.join(', ')}`)
  
  if (context?.stack) {
    console.error(`  Stack: ${context.stack.split('\n').slice(0, 3).join('\n')}`)
  }
  
  // TODO: Store in database for analytics and debugging
  // await prisma.errorLog.create({
  //   data: {
  //     code: error.code,
  //     message: error.message,
  //     reason: error.reason,
  //     traceId: error.traceId,
  //     timestamp: error.timestamp,
  //     userId: context?.userId,
  //     projectId: context?.projectId,
  //     operation: context?.operation,
  //     metadata: error.metadata,
  //     stack: context?.stack
  //   }
  // })
}
