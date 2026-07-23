/**
 * Long-Running Operation Guard
 * 
 * PROBLEM: Serverless is bad for long-running jobs (>30s timeout)
 * SOLUTION: Detect and reject operations that shouldn't run in serverless
 * 
 * PHILOSOPHY: Fail fast with clear guidance (don't silently timeout)
 * 
 * PROHIBITED OPERATIONS (Serverless incompatible):
 * - Video processing
 * - Large batch imports (>1000 records)
 * - ML training
 * - File conversions
 * - Heavy data transformations
 * 
 * MITIGATION: Users shouldn't do these via API anyway
 * FUTURE: Async jobs → queue → worker (if needed, but not now)
 */

/**
 * Operation types that are too long for serverless
 */
const PROHIBITED_OPERATIONS = [
  'video-processing',
  'ml-training',
  'large-batch-import',
  'file-conversion',
  'data-migration',
  'bulk-export',
]

/**
 * Detect if operation is likely to be long-running
 * Returns warning if operation should be avoided
 */
export function detectLongRunningOperation(params: {
  method: string
  path: string[]
  body?: any
  query?: Record<string, string>
}): {
  isLongRunning: boolean
  reason?: string
  estimatedDuration?: number
  suggestion?: string
} {
  const { method, path, body, query } = params

  // Check for bulk operations
  if (method === 'POST' && body) {
    // Bulk create detection
    if (Array.isArray(body) && body.length > 1000) {
      return {
        isLongRunning: true,
        reason: 'Bulk operation exceeds serverless limits',
        estimatedDuration: Math.ceil(body.length / 10), // ~10 records per second
        suggestion:
          'Break into smaller batches (<1000 records) or use paginated creation',
      }
    }

    // Check for records array in body
    if (body.records && Array.isArray(body.records) && body.records.length > 1000) {
      return {
        isLongRunning: true,
        reason: 'Bulk operation exceeds serverless limits',
        estimatedDuration: Math.ceil(body.records.length / 10),
        suggestion: 'Break into smaller batches (<1000 records)',
      }
    }

    // Check for file upload size (>10MB likely slow)
    if (body.file && body.file.size > 10 * 1024 * 1024) {
      return {
        isLongRunning: true,
        reason: 'Large file upload may timeout',
        estimatedDuration: Math.ceil(body.file.size / (1024 * 1024)), // ~1MB/s
        suggestion: 'Use direct S3 upload with presigned URL instead',
      }
    }
  }

  // Check for large query limits
  if (query?.limit) {
    const limit = parseInt(query.limit)
    if (limit > 10000) {
      return {
        isLongRunning: true,
        reason: 'Query limit too high for single request',
        estimatedDuration: Math.ceil(limit / 1000), // ~1000 records/sec
        suggestion: 'Use pagination with limit <10000',
      }
    }
  }

  // Check for export operations
  if (
    path.some((segment) => segment.toLowerCase().includes('export')) &&
    method === 'GET'
  ) {
    return {
      isLongRunning: true,
      reason: 'Export operations may timeout in serverless',
      estimatedDuration: 30,
      suggestion: 'Use paginated API calls instead of full export',
    }
  }

  // Operation looks safe for serverless
  return {
    isLongRunning: false,
  }
}

/**
 * Enforce serverless time limits
 * Throws error if operation will likely timeout
 */
export function enforceServerlessLimits(params: {
  method: string
  path: string[]
  body?: any
  query?: Record<string, string>
}): void {
  const detection = detectLongRunningOperation(params)

  if (detection.isLongRunning) {
    throw new ServerlessLimitError(
      detection.reason || 'Operation too long for serverless execution',
      detection.estimatedDuration,
      detection.suggestion
    )
  }
}

/**
 * Custom error for serverless limit violations
 */
export class ServerlessLimitError extends Error {
  code = 'SERVERLESS_LIMIT_EXCEEDED'
  statusCode = 413 // Payload Too Large
  estimatedDuration?: number
  suggestion?: string

  constructor(message: string, estimatedDuration?: number, suggestion?: string) {
    super(message)
    this.name = 'ServerlessLimitError'
    this.estimatedDuration = estimatedDuration
    this.suggestion = suggestion
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      estimatedDuration: this.estimatedDuration
        ? `${this.estimatedDuration} seconds`
        : undefined,
      suggestion: this.suggestion,
      hint: 'Serverless functions have 30-second timeout. Break operation into smaller requests.',
    }
  }
}

/**
 * Check if request body size is within serverless limits
 */
export function validateRequestSize(bodySize: number): {
  valid: boolean
  error?: string
} {
  const MAX_SIZE = 4.5 * 1024 * 1024 // 4.5 MB

  if (bodySize > MAX_SIZE) {
    return {
      valid: false,
      error: `Request body too large (${(bodySize / 1024 / 1024).toFixed(2)}MB). Maximum: 4.5MB`,
    }
  }

  return { valid: true }
}

/**
 * Estimate operation duration (rough heuristic)
 */
export function estimateOperationDuration(params: {
  method: string
  recordCount?: number
  queryComplexity?: 'simple' | 'complex'
}): number {
  const { method, recordCount = 1, queryComplexity = 'simple' } = params

  let baseDuration = 100 // 100ms base

  // Method overhead
  if (method === 'POST' || method === 'PUT') {
    baseDuration += 50 // Write operations slower
  }

  // Record count
  baseDuration += recordCount * 10 // ~10ms per record

  // Query complexity
  if (queryComplexity === 'complex') {
    baseDuration *= 2 // Complex queries take 2x longer
  }

  return baseDuration
}
