/**
 * CIRCUIT BREAKER
 * ===============
 * Prevents cascade failures when external APIs (Runway ML, Stripe, Replicate,
 * OpenAI, etc.) return repeated errors.
 *
 * State machine:
 *   CLOSED  → normal operation; failures are counted
 *   OPEN    → fast-fail; returns CircuitOpenError with Retry-After header value
 *   HALF_OPEN → one probe request allowed; success → CLOSED, failure → OPEN
 *
 * Default thresholds (override via env or options):
 *   FAILURE_THRESHOLD — consecutive failures to trip open     (default: 5)
 *   RESET_TIMEOUT_MS  — ms to wait before entering HALF_OPEN  (default: 30_000)
 *   HALF_OPEN_PROBES  — probe requests allowed in HALF_OPEN   (default: 1)
 *
 * Usage:
 *   const cb = getCircuitBreaker('runway', { failureThreshold: 3 })
 *   try {
 *     const result = await cb.execute(() => fetch('https://api.runwayml.com/...'))
 *   } catch (err) {
 *     if (err instanceof CircuitOpenError) {
 *       res.setHeader('Retry-After', err.retryAfterSec)
 *       return res.status(503).json({ error: err.message })
 *     }
 *     throw err
 *   }
 */

export class CircuitOpenError extends Error {
  /** Seconds until the circuit enters HALF_OPEN and probes can be attempted */
  readonly retryAfterSec: number
  readonly integrationId: string

  constructor(integrationId: string, retryAfterSec: number) {
    super(
      `Circuit breaker OPEN for integration '${integrationId}'. ` +
      `Retry after ${retryAfterSec}s.`
    )
    this.name = 'CircuitOpenError'
    this.integrationId = integrationId
    this.retryAfterSec = retryAfterSec
  }
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

interface CircuitBreakerOptions {
  failureThreshold?: number
  resetTimeoutMs?: number
  halfOpenProbes?: number
}

interface CircuitBreakerState {
  state: CircuitState
  failureCount: number
  lastFailureAt: number | null
  probeCount: number
}

const DEFAULT_FAILURE_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? '5', 10)
const DEFAULT_RESET_TIMEOUT_MS  = parseInt(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS  ?? '30000', 10)
const DEFAULT_HALF_OPEN_PROBES  = 1

// In-process store — keyed by integrationId (or integrationId + projectId for project-scoped breakers)
const breakers = new Map<string, { state: CircuitBreakerState; opts: Required<CircuitBreakerOptions> }>()

function getOrCreate(key: string, opts: Required<CircuitBreakerOptions>) {
  if (!breakers.has(key)) {
    breakers.set(key, {
      state: {
        state: 'CLOSED',
        failureCount: 0,
        lastFailureAt: null,
        probeCount: 0,
      },
      opts,
    })
  }
  return breakers.get(key)!
}

export class CircuitBreaker {
  private readonly key: string
  private readonly opts: Required<CircuitBreakerOptions>

  constructor(key: string, opts: CircuitBreakerOptions = {}) {
    this.key = key
    this.opts = {
      failureThreshold: opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      resetTimeoutMs:   opts.resetTimeoutMs   ?? DEFAULT_RESET_TIMEOUT_MS,
      halfOpenProbes:   opts.halfOpenProbes   ?? DEFAULT_HALF_OPEN_PROBES,
    }
  }

  private entry() {
    return getOrCreate(this.key, this.opts)
  }

  get currentState(): CircuitState {
    return this.transitionIfNeeded().state.state
  }

  /** Returns seconds until HALF_OPEN when OPEN, or 0 otherwise */
  get retryAfterSec(): number {
    const { state } = this.entry()
    if (state.state !== 'OPEN' || state.lastFailureAt === null) return 0
    const remainingMs = this.opts.resetTimeoutMs - (Date.now() - state.lastFailureAt)
    return Math.max(0, Math.ceil(remainingMs / 1000))
  }

  private transitionIfNeeded() {
    const entry = this.entry()
    const { state } = entry

    if (state.state === 'OPEN' && state.lastFailureAt !== null) {
      const age = Date.now() - state.lastFailureAt
      if (age >= this.opts.resetTimeoutMs) {
        // Transition to HALF_OPEN — allow probe requests
        state.state = 'HALF_OPEN'
        state.probeCount = 0
      }
    }

    return entry
  }

  private onSuccess() {
    const entry = this.entry()
    const { state } = entry

    if (state.state === 'HALF_OPEN') {
      // Probe succeeded — close the circuit
      state.state = 'CLOSED'
    }
    state.failureCount = 0
    state.probeCount = 0
  }

  private onFailure() {
    const entry = this.entry()
    const { state } = entry

    state.failureCount++
    state.lastFailureAt = Date.now()

    if (state.state === 'HALF_OPEN') {
      // Probe failed — re-open immediately
      state.state = 'OPEN'
      state.probeCount = 0
      return
    }

    if (state.failureCount >= this.opts.failureThreshold) {
      state.state = 'OPEN'
    }
  }

  /**
   * Execute fn through the circuit breaker.
   * Throws CircuitOpenError immediately if the circuit is OPEN.
   * In HALF_OPEN, allows up to halfOpenProbes concurrent probes — additional
   * callers receive CircuitOpenError until the probe resolves.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const entry = this.transitionIfNeeded()
    const { state } = entry

    if (state.state === 'OPEN') {
      throw new CircuitOpenError(this.key, this.retryAfterSec)
    }

    if (state.state === 'HALF_OPEN') {
      if (state.probeCount >= this.opts.halfOpenProbes) {
        // Already probing — fast fail other callers while probe is in flight
        throw new CircuitOpenError(this.key, this.retryAfterSec)
      }
      state.probeCount++
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      // Only count errors as failures if they're not CircuitOpenError themselves
      if (!(err instanceof CircuitOpenError)) {
        this.onFailure()
      }
      throw err
    }
  }

  /** Manual reset — for admin / testing use */
  reset() {
    const entry = this.entry()
    entry.state = { state: 'CLOSED', failureCount: 0, lastFailureAt: null, probeCount: 0 }
  }

  /** Export current state snapshot (for health endpoints / monitoring) */
  snapshot() {
    const { state } = this.transitionIfNeeded()
    return {
      key: this.key,
      state: state.state,
      failureCount: state.failureCount,
      retryAfterSec: this.retryAfterSec,
    }
  }
}

// ── Singleton registry ────────────────────────────────────────────────────────

const registry = new Map<string, CircuitBreaker>()

/**
 * Get (or create) a named circuit breaker.
 * Options are only applied on first creation — subsequent calls with the same
 * key return the existing breaker regardless of opts.
 *
 * @param integrationId  - e.g. 'runway', 'stripe', 'openai'
 * @param opts           - optional thresholds (only applied on first call)
 */
export function getCircuitBreaker(
  integrationId: string,
  opts: CircuitBreakerOptions = {}
): CircuitBreaker {
  if (!registry.has(integrationId)) {
    registry.set(integrationId, new CircuitBreaker(integrationId, opts))
  }
  return registry.get(integrationId)!
}

/**
 * Project-scoped circuit breaker — useful when one project's integration key
 * fails without affecting other projects using the same integration.
 */
export function getProjectCircuitBreaker(
  projectId: string,
  integrationId: string,
  opts: CircuitBreakerOptions = {}
): CircuitBreaker {
  const key = `${projectId}:${integrationId}`
  if (!registry.has(key)) {
    registry.set(key, new CircuitBreaker(key, opts))
  }
  return registry.get(key)!
}

/**
 * Snapshot all registered circuit breakers — expose via health endpoint.
 */
export function allCircuitBreakerSnapshots() {
  return [...registry.values()].map(cb => cb.snapshot())
}
