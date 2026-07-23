/**
 * Background Reliability Engine
 * 
 * Phase 11: Idempotent execution, retries, circuit breakers, graceful degradation.
 * 
 * PRINCIPLE: Users never see chaos. The system behaves predictably under stress.
 */

export interface ExecutionOptions {
  maxRetries?: number
  timeout?: number
  idempotencyKey?: string
  circuitBreakerThreshold?: number
}

export interface ExecutionResult {
  success: boolean
  message: string
  data?: any
  retried?: boolean
  degraded?: boolean
}

/**
 * Circuit Breaker State
 */
const circuitBreakers = new Map<string, {
  failures: number
  lastFailureTime: number
  state: 'closed' | 'open' | 'half-open'
}>()

/**
 * Idempotency Cache (in-memory, should be Redis in production)
 */
const idempotencyCache = new Map<string, ExecutionResult>()

/**
 * Execute with automatic retries and circuit breaking
 */
export async function executeWithReliability<T>(
  fn: () => Promise<T>,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const {
    maxRetries = 3,
    timeout = 30000,
    idempotencyKey,
    circuitBreakerThreshold = 5,
  } = options

  // Check idempotency cache
  if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
    return idempotencyCache.get(idempotencyKey)!
  }

  // Check circuit breaker
  const circuitKey = fn.name || 'default'
  const circuit = getCircuitBreaker(circuitKey)
  
  if (circuit.state === 'open') {
    const timeSinceFailure = Date.now() - circuit.lastFailureTime
    if (timeSinceFailure < 60000) { // 1 minute cooldown
      return {
        success: false,
        message: "We're having temporary issues. Nothing was changed. Try again in a moment.",
        degraded: true,
      }
    } else {
      // Try half-open
      circuit.state = 'half-open'
    }
  }

  let lastError: Error | null = null
  let attempt = 0

  while (attempt < maxRetries) {
    try {
      // Execute with timeout
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeout)
        ),
      ])

      // Success - reset circuit breaker
      resetCircuitBreaker(circuitKey)

      const executionResult: ExecutionResult = {
        success: true,
        message: 'Success',
        data: result,
        retried: attempt > 0,
      }

      // Cache result if idempotency key provided
      if (idempotencyKey) {
        idempotencyCache.set(idempotencyKey, executionResult)
        // Clear cache after 1 hour
        setTimeout(() => idempotencyCache.delete(idempotencyKey), 3600000)
      }

      return executionResult

    } catch (error) {
      lastError = error as Error
      attempt++

      // Record failure in circuit breaker
      recordFailure(circuitKey, circuitBreakerThreshold)

      // Don't retry on certain errors
      if (isNonRetryableError(error)) {
        break
      }

      // Exponential backoff
      if (attempt < maxRetries) {
        await delay(Math.min(1000 * Math.pow(2, attempt), 10000))
      }
    }
  }

  // All retries failed
  return {
    success: false,
    message: "Something didn't work after multiple attempts. Nothing was changed.",
    retried: attempt > 1,
  }
}

/**
 * Get circuit breaker state
 */
function getCircuitBreaker(key: string) {
  if (!circuitBreakers.has(key)) {
    circuitBreakers.set(key, {
      failures: 0,
      lastFailureTime: 0,
      state: 'closed',
    })
  }
  return circuitBreakers.get(key)!
}

/**
 * Record a failure
 */
function recordFailure(key: string, threshold: number) {
  const circuit = getCircuitBreaker(key)
  circuit.failures++
  circuit.lastFailureTime = Date.now()

  if (circuit.failures >= threshold) {
    circuit.state = 'open'
  }
}

/**
 * Reset circuit breaker on success
 */
function resetCircuitBreaker(key: string) {
  const circuit = getCircuitBreaker(key)
  circuit.failures = 0
  circuit.state = 'closed'
}

/**
 * Check if error should not be retried
 */
function isNonRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error)
  
  // Don't retry validation errors, auth errors, etc.
  return (
    message.includes('validation') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('not found')
  )
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Graceful degradation: Execute with fallback
 */
export async function executeWithFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  try {
    const result = await executeWithReliability(primary, options)
    if (result.success) return result

    // Try fallback
    const fallbackResult = await executeWithReliability(fallback, {
      ...options,
      maxRetries: 1,
    })

    return {
      ...fallbackResult,
      degraded: true,
    }
  } catch {
    return {
      success: false,
      message: "Something didn't work. Nothing was changed.",
      degraded: true,
    }
  }
}
