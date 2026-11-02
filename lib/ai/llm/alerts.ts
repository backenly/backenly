/**
 * AI FAILURE MARKERS: one log line an alarm can count
 * ===================================================
 * From 2026-10-12 to 2026-11-02 every AI feature on Backenly Cloud failed (the
 * gateway was calling a provider account with no balance) and nothing noticed
 * for three weeks: each failure was an AiError some caller handled, and none
 * left anything stable in the logs. A deployment's alarms are log metric
 * filters on literal markers, so a failed call writes one line, after the
 * gateway's own retries, when the failure is the deployment's rather than the
 * request's:
 *
 *   BACKENLY_AI_UNAVAILABLE kind=<kind> provider=<provider> purpose=<purpose> model=<model>
 *       quota_exhausted, not_configured, access_denied, spend_limit,
 *       spend_unavailable: no call succeeds until someone acts on the
 *       deployment (tops up the account, fixes configuration or access, raises
 *       a limit, repairs the spend ledger).
 *
 *   BACKENLY_AI_THROTTLED kind=rate_limited provider=<provider> purpose=<purpose> model=<model>
 *       the provider still refused after the gateway's retries. One is
 *       routine; a steady rate means the account's quota is below the load.
 *
 * Nothing for a request's own failure (invalid_request, refused,
 * output_invalid, aborted, timeout, unavailable), nor for credits_exhausted,
 * which is one customer's plan credits, not the deployment.
 *
 * The line has those four fields and nothing else: never prompt text, the
 * provider's message, a credential, or a user or project id. A missing value
 * is `unknown`, and every value is one token, so the line stays one line
 * whatever a configured model id holds.
 */

import type { AiError, AiErrorKind } from './errors'
import type { AiPurpose, ProviderId } from './types'

export const AI_UNAVAILABLE_MARKER = 'BACKENLY_AI_UNAVAILABLE'
export const AI_THROTTLED_MARKER = 'BACKENLY_AI_THROTTLED'

/** The marker each kind logs. A kind added to AiErrorKind must be decided here before it compiles. */
const MARKER: Record<AiErrorKind, string | null> = {
  quota_exhausted: AI_UNAVAILABLE_MARKER,
  not_configured: AI_UNAVAILABLE_MARKER,
  access_denied: AI_UNAVAILABLE_MARKER,
  spend_limit: AI_UNAVAILABLE_MARKER,
  spend_unavailable: AI_UNAVAILABLE_MARKER,
  rate_limited: AI_THROTTLED_MARKER,
  invalid_request: null,
  refused: null,
  output_invalid: null,
  aborted: null,
  timeout: null,
  unavailable: null,
  credits_exhausted: null,
}

export interface AiFailureContext {
  /** What the call was for: its gateway purpose, or `embeddings`. */
  purpose: AiPurpose | 'embeddings'
  /** Where the call was routed, when it got that far. The error's own provider and model win. */
  provider?: ProviderId
  model?: string
}

function token(value: string | undefined): string {
  const v = value?.trim()
  return v ? v.replace(/[^\w.:/@+-]/g, '_').slice(0, 128) : 'unknown'
}

/**
 * Log the marker for a failed call, if its kind has one. Call it once per
 * failed call, after any retries; `generate` does, for every gateway call.
 */
export function reportAiFailure(err: AiError, ctx: AiFailureContext): void {
  const marker = MARKER[err.kind]
  if (!marker) return
  console.error(
    `${marker} kind=${err.kind} provider=${token(err.provider ?? ctx.provider)} purpose=${token(ctx.purpose)} model=${token(err.model ?? ctx.model)}`,
  )
}
