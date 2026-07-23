/**
 * Non-feature detection for the product-feedback log.
 *
 * Reuses the canonical NON_FEATURES regex catalogue (lib/non-features) so
 * "what did users ask for that we don't do" is measured against the SAME
 * definition the product uses to refuse. Observe-only: this never blocks or
 * changes the AI's behaviour — it just records the signal for the founder's
 * Feedback tab so the roadmap is driven by real demand, not guesses.
 */

import { NON_FEATURES } from '@/lib/non-features'

export interface NonFeatureHit {
  category: string
  refusalMessage: string
}

export function detectNonFeature(message: string): NonFeatureHit | null {
  if (!message || message.length < 4) return null
  for (const nf of NON_FEATURES) {
    if (nf.pattern.test(message)) {
      return { category: nf.category, refusalMessage: nf.refusalMessage }
    }
  }
  return null
}
