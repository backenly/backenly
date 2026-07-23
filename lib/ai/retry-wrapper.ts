/**
 * PHASE 8: RETRY WRAPPER
 * ======================
 * Taxonomy-aware retry/backoff for AI execution steps.
 *
 * Strategy:
 *   TRY → FAIL → CLASSIFY(taxonomy) → LOOKUP(auto-fix registry)
 *   → APPLY_FIX? → WAIT(exponential+jitter) → RETRY  (up to maxAttempts)
 *
 * Guarantees:
 *   - Never retries non-recoverable error categories (saves latency and avoids loops)
 *   - Idempotent errors (DUPLICATE_RESOURCE) are turned into instant success
 *   - Deterministic fixes (FK type coercion, missing table) are applied before retry
 *   - Exponential backoff with jitter prevents thundering-herd on transient failures
 *   - Full retry history is returned for the persistent execution timeline
 *
 * This wrapper is intentionally separate from the AI replanning loop in
 * minimal-executor.ts.  Use it wherever you need structured retry:
 *   - Integration executors (Stripe, SendGrid, etc.)
 *   - Trigger delivery
 *   - Direct schema operations outside the AI loop
 */

import { classifyError, classifyErrorCode } from '@/lib/errors/taxonomy'
import type { ErrorTaxonomyCode } from '@/lib/errors/taxonomy'
import { getAutoFix } from './auto-fix-registry'
import type { AIAction } from './minimal-executor'

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Maximum total attempts including the initial one. Default: 3 */
  maxAttempts?: number
  /** Base delay in ms for exponential backoff. Default: 500 */
  baseDelayMs?: number
  /** Maximum delay cap in ms. Default: 10_000 */
  maxDelayMs?: number
  /** Add random jitter to delay to prevent thundering herd. Default: true */
  jitter?: boolean
}

export interface RetryAttemptRecord {
  attempt: number
  errorMessage: string
  errorClassification: ErrorTaxonomyCode | 'UNKNOWN'
  /** Description of the healing action applied before this retry, or null */
  healingApplied: string | null
  /** How long the wrapper waited before this retry */
  delayMs: number
  timestamp: string
}

export interface RetryWrapperResult<T> {
  success: boolean
  value?: T
  /** Last error message if all attempts failed */
  error?: string
  /** Taxonomy classification of the last error seen */
  errorClassification: ErrorTaxonomyCode | 'UNKNOWN'
  /** Total attempts made (1 = succeeded on first try) */
  attempts: number
  /** True if any healing action was applied during the run */
  selfCorrected: boolean
  /** Per-attempt records for the execution timeline */
  retryHistory: RetryAttemptRecord[]
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function computeDelay(attempt: number, policy: Required<RetryPolicy>): number {
  const exp = Math.pow(2, attempt - 1) * policy.baseDelayMs
  const capped = Math.min(exp, policy.maxDelayMs)
  if (!policy.jitter) return capped
  // ±25% jitter
  return Math.floor(capped * (0.75 + Math.random() * 0.5))
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Core Wrapper ─────────────────────────────────────────────────────────────

/**
 * Execute `fn` with taxonomy-aware retry and exponential backoff.
 *
 * @param fn             Async function to execute. Must return `{ success, message? }`.
 * @param failedAction   The AIAction being attempted (needed for auto-fix context).
 * @param projectId      Project context for heal-action construction.
 * @param runHealAction  Callback that executes a heal AIAction before retrying.
 *                       If omitted, heal actions are skipped (only delay retries happen).
 * @param policy         Retry configuration overrides.
 */
export async function withRetry<T extends { success: boolean; message?: string }>(
  fn: () => Promise<T>,
  failedAction: AIAction,
  projectId: string,
  runHealAction?: (action: AIAction) => Promise<void>,
  policy: RetryPolicy = {},
): Promise<RetryWrapperResult<T>> {
  const cfg: Required<RetryPolicy> = {
    maxAttempts: policy.maxAttempts ?? 3,
    baseDelayMs: policy.baseDelayMs ?? 500,
    maxDelayMs:  policy.maxDelayMs  ?? 10_000,
    jitter:      policy.jitter      ?? true,
  }

  const retryHistory: RetryAttemptRecord[] = []
  let selfCorrected = false
  let lastError = ''
  let lastClassification: ErrorTaxonomyCode | 'UNKNOWN' = 'UNKNOWN'

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      const result = await fn()

      if (!result.success && result.message) {
        const errorMsg = result.message
        const classification = classifyErrorCode(errorMsg)
        const entry = classifyError(errorMsg)
        const fix = getAutoFix(classification)

        lastError = errorMsg
        lastClassification = classification

        // ── Idempotent skip: already exists → treat as success ────────────
        if (fix?.idempotentSkip) {
          retryHistory.push({
            attempt,
            errorMessage: errorMsg,
            errorClassification: classification,
            healingApplied: fix.description,
            delayMs: 0,
            timestamp: new Date().toISOString(),
          })
          return {
            success: true,
            value: result,
            errorClassification: classification,
            attempts: attempt,
            selfCorrected: true,
            retryHistory,
          }
        }

        // ── Non-recoverable or last attempt → surface error ───────────────
        const canRetry = entry?.recoverable && attempt < cfg.maxAttempts
        if (!canRetry) {
          retryHistory.push({
            attempt,
            errorMessage: errorMsg,
            errorClassification: classification,
            healingApplied: null,
            delayMs: 0,
            timestamp: new Date().toISOString(),
          })
          return {
            success: false,
            error: errorMsg,
            errorClassification: classification,
            attempts: attempt,
            selfCorrected,
            retryHistory,
          }
        }

        // ── Apply deterministic fix if available ──────────────────────────
        let healingDesc: string | null = null
        if (fix) {
          const healAction = fix.buildHealAction(errorMsg, failedAction, projectId)
          if (healAction && runHealAction) {
            try {
              await runHealAction(healAction)
              healingDesc = fix.description
              selfCorrected = true
            } catch (healErr: any) {
              console.warn('[RetryWrapper] Heal action failed:', healErr?.message)
            }
          } else if (!healAction) {
            // Executor handles internally on retry (e.g. UUID coercion)
            healingDesc = fix.description
            selfCorrected = true
          }
        }

        const delay = computeDelay(attempt, cfg)
        retryHistory.push({
          attempt,
          errorMessage: errorMsg,
          errorClassification: classification,
          healingApplied: healingDesc,
          delayMs: delay,
          timestamp: new Date().toISOString(),
        })

        console.log(
          `[RetryWrapper] Attempt ${attempt}/${cfg.maxAttempts} failed` +
          ` (${classification}). Fix: ${healingDesc ?? 'none'}. Retrying in ${delay}ms.`
        )
        await sleep(delay)
        continue
      }

      // ── Success ───────────────────────────────────────────────────────────
      return {
        success: true,
        value: result,
        errorClassification: lastClassification,
        attempts: attempt,
        selfCorrected,
        retryHistory,
      }

    } catch (err: any) {
      const errorMsg: string = err?.message ?? String(err)
      const classification = classifyErrorCode(errorMsg)
      const entry = classifyError(errorMsg)
      const fix = getAutoFix(classification)

      lastError = errorMsg
      lastClassification = classification

      // ── Idempotent skip from thrown error ─────────────────────────────────
      if (fix?.idempotentSkip) {
        retryHistory.push({
          attempt,
          errorMessage: errorMsg,
          errorClassification: classification,
          healingApplied: fix.description,
          delayMs: 0,
          timestamp: new Date().toISOString(),
        })
        return {
          success: true,
          value: undefined,
          errorClassification: classification,
          attempts: attempt,
          selfCorrected: true,
          retryHistory,
        }
      }

      const canRetry = entry?.recoverable && attempt < cfg.maxAttempts
      if (!canRetry) {
        retryHistory.push({
          attempt,
          errorMessage: errorMsg,
          errorClassification: classification,
          healingApplied: null,
          delayMs: 0,
          timestamp: new Date().toISOString(),
        })
        return {
          success: false,
          error: errorMsg,
          errorClassification: classification,
          attempts: attempt,
          selfCorrected,
          retryHistory,
        }
      }

      let healingDesc: string | null = null
      if (fix) {
        const healAction = fix.buildHealAction(errorMsg, failedAction, projectId)
        if (healAction && runHealAction) {
          try {
            await runHealAction(healAction)
            healingDesc = fix.description
            selfCorrected = true
          } catch (healErr: any) {
            console.warn('[RetryWrapper] Heal action failed:', healErr?.message)
          }
        } else if (!healAction) {
          healingDesc = fix.description
          selfCorrected = true
        }
      }

      const delay = computeDelay(attempt, cfg)
      retryHistory.push({
        attempt,
        errorMessage: errorMsg,
        errorClassification: classification,
        healingApplied: healingDesc,
        delayMs: delay,
        timestamp: new Date().toISOString(),
      })

      console.log(
        `[RetryWrapper] Attempt ${attempt}/${cfg.maxAttempts} threw` +
        ` (${classification}). Retrying in ${delay}ms.`
      )
      await sleep(delay)
    }
  }

  // Exhausted all attempts
  return {
    success: false,
    error: lastError || 'Max retry attempts exceeded',
    errorClassification: lastClassification,
    attempts: cfg.maxAttempts,
    selfCorrected,
    retryHistory,
  }
}
