/**
 * PHASE 8: AUTO-FIX REGISTRY
 * ===========================
 * Deterministic lookup table: ErrorTaxonomyCode → FixStrategy.
 *
 * Each strategy specifies:
 *   - A short description of what the fix does
 *   - Whether to treat the step as an idempotent skip (no retry needed)
 *   - A builder that produces the concrete AIAction to run before retrying,
 *     or null if the executor itself handles the fix on retry
 *
 * This is intentionally conservative — only categories where we can make
 * a deterministic, safe correction are registered. Everything else surfaces
 * to the user with operator guidance from the taxonomy.
 */

import type { ErrorTaxonomyCode } from '@/lib/errors/taxonomy'
import type { AIAction } from './minimal-executor'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FixStrategy {
  /** One-line description stored in the timeline entry's healingApplied field */
  description: string
  /**
   * When true: treat the failed step as already-done (idempotent).
   * The timeline status becomes 'self_corrected' and the outer loop continues.
   */
  idempotentSkip: boolean
  /**
   * Produce the AIAction to run before the original action is retried.
   * Returning null means "just retry without a pre-action" (executor coerces internally).
   */
  buildHealAction: (
    errorMessage: string,
    failedAction: AIAction,
    projectId: string,
  ) => AIAction | null
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Only covers taxonomy codes that are both `recoverable` and `autoFixable`.
 * MIGRATION_FAILURE is partially covered: if the error is "relation does not exist",
 * we can create the table first.
 */
export const AUTO_FIX_REGISTRY: Partial<Record<ErrorTaxonomyCode, FixStrategy>> = {

  FK_CONSTRAINT: {
    description: 'FK constraint — executor will enforce UUID type coercion on retry',
    idempotentSkip: false,
    buildHealAction(errorMessage) {
      const lower = errorMessage.toLowerCase()
      // Type mismatch (int vs uuid): the executor's UUID-enforcement handles this on retry.
      // Return null = retry the same action, executor will coerce.
      if (
        lower.includes('type mismatch') ||
        (lower.includes('integer') && lower.includes('uuid')) ||
        lower.includes('incompatible types')
      ) {
        return null
      }
      // Parent row genuinely missing — cannot be auto-fixed without data context.
      return null
    },
  },

  DUPLICATE_RESOURCE: {
    description: 'Resource already exists — step treated as idempotent success',
    idempotentSkip: true,
    buildHealAction() {
      return null // idempotent skip; no action needed before "retry"
    },
  },

  MIGRATION_FAILURE: {
    description: 'Migration failure — creating missing relation then retrying',
    idempotentSkip: false,
    buildHealAction(errorMessage, failedAction) {
      // "relation \"tablename\" does not exist" → create the table first
      const missingTable =
        errorMessage.match(/relation\s+"?([a-z_][a-z0-9_]*)"?\s+does not exist/i) ||
        errorMessage.match(/no such table[:\s]+"?([a-z_][a-z0-9_]*)"?/i)

      if (missingTable) {
        return {
          action: 'CREATE_TABLE',
          params: { tableName: missingTable[1], columns: [] },
        } satisfies AIAction
      }

      // No other migration errors can be safely auto-fixed.
      return null
    },
  },

  TRIGGER_DELIVERY_FAILURE: {
    description: 'Trigger delivery failed — will retry after backoff',
    idempotentSkip: false,
    buildHealAction() {
      // No pre-action; just retry after the delay computed by the retry wrapper.
      return null
    },
  },
}

// ─── Lookup API ───────────────────────────────────────────────────────────────

/**
 * Return the fix strategy for a given taxonomy code, or null if none exists.
 */
export function getAutoFix(
  taxonomyCode: ErrorTaxonomyCode | 'UNKNOWN',
): FixStrategy | null {
  if (taxonomyCode === 'UNKNOWN') return null
  return AUTO_FIX_REGISTRY[taxonomyCode] ?? null
}
