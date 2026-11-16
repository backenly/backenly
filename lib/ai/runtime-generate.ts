/**
 * TEXT GENERATION FOR APPS — what /v1/{projectId}/ai/generate runs
 * ================================================================
 * An app built on Backenly asks for text; the deployment's AI provider writes
 * it, and the project's AI credits pay for it.
 *
 * This endpoint used to pass the caller's `model` straight to OpenAI on the
 * platform's own key, with no cap and no charge, so any key holder could pick
 * the most expensive model there was and nobody paid for it. Now:
 *
 *   - `model` is an alias. "fast" asks for a short, cheap answer; anything
 *     else, including the provider model names callers used to send, gets
 *     the default. The deployment decides what serves each.
 *   - the output ceiling is the route's (4,096 tokens); a caller may ask for
 *     less, never more.
 *   - the project's billing account must have credits left, and what the call
 *     consumes is charged to it, including a run the provider stopped part-way.
 *   - a failure answers with a code and words a person can act on, never the
 *     provider's own message.
 */

import { AiError, generate, type AiErrorKind, type AiPurpose } from './llm'
import { createTokenScope, runInTokenScope } from './token-meter'
import { enforceAiCredits } from '@/lib/entitlements/policy'
import { planNamesOf } from '@/lib/entitlements/plan-names'
import { closeCreditTurn } from '@/lib/entitlements/credit-holds'
import { creditAccountOf } from '@/lib/usage/account'

export type ModelAlias = 'default' | 'fast'

/** The alias a request's `model` names, and the gateway purpose that serves it. */
export function purposeForModel(model: string | undefined): { alias: ModelAlias; purpose: AiPurpose } {
  return model?.trim().toLowerCase() === 'fast'
    ? { alias: 'fast', purpose: 'runtime.fast' }
    : { alias: 'default', purpose: 'runtime.generate' }
}

export interface GenerateFailure {
  ok: false
  code: string
  message: string
  status: number
  details?: Record<string, unknown>
}

export interface GenerateSuccess {
  ok: true
  data: {
    content: string
    model: string
    usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  }
}

/** The response for each failure. Never carries the provider's own message. */
const FAILURE: Partial<Record<AiErrorKind, { code: string; status: number }>> = {
  not_configured: { code: 'AI_UNAVAILABLE', status: 503 },
  quota_exhausted: { code: 'AI_UNAVAILABLE', status: 503 },
  access_denied: { code: 'AI_UNAVAILABLE', status: 503 },
  spend_limit: { code: 'AI_UNAVAILABLE', status: 503 },
  spend_unavailable: { code: 'AI_UNAVAILABLE', status: 503 },
  credits_exhausted: { code: 'AI_CREDITS_EXHAUSTED', status: 402 },
  rate_limited: { code: 'RATE_LIMIT_EXCEEDED', status: 429 },
  timeout: { code: 'SERVICE_UNAVAILABLE', status: 503 },
  unavailable: { code: 'SERVICE_UNAVAILABLE', status: 503 },
  refused: { code: 'AI_REFUSED', status: 422 },
  invalid_request: { code: 'BAD_REQUEST', status: 400 },
}

export function failureOf(err: AiError): GenerateFailure {
  const f = FAILURE[err.kind] ?? { code: 'INTERNAL_ERROR', status: 500 }
  return { ok: false, code: f.code, message: err.userMessage, status: f.status }
}

export async function generateForProject(input: {
  projectId: string
  prompt: string
  model?: string
  maxTokens?: number
}): Promise<GenerateSuccess | GenerateFailure> {
  const { purpose } = purposeForModel(input.model)

  // The project's billing account pays, the same account backend_chat draws
  // on. Read-only and fail-open, as there: only a measured exhausted budget
  // blocks.
  const account = await creditAccountOf(input.projectId)
  const credits = account ? await enforceAiCredits(account) : true
  if (credits !== true) {
    return {
      ok: false,
      code: 'AI_CREDITS_EXHAUSTED',
      message: credits.message,
      status: 402,
      details: { currentPlan: credits.currentPlan, requiredPlan: credits.requiredPlan, ...planNamesOf(credits) },
    }
  }

  const meter = createTokenScope()
  try {
    const result = await runInTokenScope(meter, () =>
      generate({
        purpose,
        messages: [{ role: 'user', content: input.prompt }],
        ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
        billing: { projectId: input.projectId, ...(account ? { billingAccountId: account } : {}) },
        label: 'runtime-generate',
      }),
    )
    return {
      ok: true,
      data: {
        content: result.text,
        model: result.model,
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.outputTokens,
          totalTokens: result.usage.promptTokens + result.usage.outputTokens,
        },
      },
    }
  } catch (err) {
    if (err instanceof AiError) return failureOf(err)
    throw err
  } finally {
    // Charged from what the provider reported, after the call; nothing when
    // it never ran. Closing the turn also stops its credit hold counting, and
    // only after the charge is recorded.
    closeCreditTurn(account, meter, meter.tokens).catch(() => {})
  }
}
