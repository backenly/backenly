/**
 * THE AI GATEWAY — the only code that talks to a model provider.
 * =============================================================
 *
 *   const result = await generate({ purpose: 'brain.classify', system, messages })
 *
 * A call names its purpose; lib/ai/llm/config.ts decides the provider, model,
 * thinking, effort, output ceiling and timeout. On Backenly Cloud that is
 * Claude Opus 4.6 on Amazon Bedrock for every purpose. Self-hosted installs can
 * use the Claude API or OpenAI instead.
 *
 * What it guarantees:
 *   - every request carries an explicit output ceiling and only parameters the
 *     routed model accepts (lib/ai/llm/params.ts);
 *   - its worst-case cost is reserved against the deployment's monthly limits
 *     before it is sent, and settled from the provider's own usage after
 *     (lib/ai/llm/spend.ts); a reservation that cannot be written stops the call;
 *   - every failure is an AiError with a kind, user-facing copy and whether
 *     inference may have run (lib/ai/llm/errors.ts);
 *   - a failure is retried only when the provider rejected it before inference,
 *     so a retry can never run, and bill, a request twice;
 *   - usage comes back in one shape with cache reads and writes kept apart, and
 *     priced at the model's own cache rates (lib/ai/cost-tracker.ts);
 *   - every customer-paid call that ran is reported to the credit meter of the
 *     request that made it (lib/ai/token-meter.ts) and, with a project, written
 *     to the project's usage log, so no call site has to remember either;
 *   - a call that names no account bills the request that made it, when that
 *     request's meter names one, so its credits are held before it is sent.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { recordAiUsage } from '../cost-tracker'
import { activeTokenScope, recordTokens } from '../token-meter'
import { aiAvailability as configuredAvailability, resolveProvider, routeFor, type ProviderConfig } from './config'
import { AiError, classifyProviderError } from './errors'
import { buildParams, shouldStream } from './params'
import { anthropicProvider, bedrockProvider } from './providers/anthropic'
import { openaiProvider } from './providers/openai'
import { defaultPayer, reserveSpend, settleSpend } from './spend'
import type { GenerateRequest, GenerateResult, LlmProvider, NormalizedUsage, ProviderId, PurposeRoute } from './types'
import { costOf, effectiveTokensOf, maxCostOf, maxEffectiveTokensOf, normalizeUsage } from './usage'

export type { AiPurpose, GenerateRequest, GenerateResult, NormalizedUsage, ProviderId } from './types'
export { AiError } from './errors'
export type { AiErrorKind, Consumption } from './errors'
export { normalizeUsage, costOf, effectiveTokensOf } from './usage'

const MAX_ATTEMPTS = 3
/** Margin past the last attempt's timeout before an unsettled reservation is booked as unknown. */
const SETTLE_GRACE_MS = 5 * 60_000

let override: LlmProvider | null = null
let cached: { key: string; provider: LlmProvider } | null = null
let retryDelayMs = (attempt: number) => 500 * 2 ** (attempt - 1)

/** Route every call to `provider` (a scripted one in tests). `null` restores configuration. */
export function setProviderForTests(provider: LlmProvider | null): void {
  override = provider
}

/**
 * The provider calls go to right now: a test's, or the configured one. The
 * lab's live arm wraps it to count calls. Throws not_configured when there is
 * none.
 */
export function activeProvider(): LlmProvider {
  return currentProvider()
}

/**
 * Whether a call can be made here, and if not, a sentence saying why: the
 * configured provider, or the one a test put in its place. Configuration only;
 * a configured provider can still fail.
 */
export function aiAvailability(
  env: Record<string, string | undefined> = process.env,
): { available: true; provider: ProviderId } | { available: false; reason: string } {
  if (override) return { available: true, provider: override.id }
  return configuredAvailability(env)
}

export function setRetryDelayForTests(fn: ((attempt: number) => number) | null): void {
  retryDelayMs = fn ?? ((attempt: number) => 500 * 2 ** (attempt - 1))
}

function configKey(c: ProviderConfig): string {
  return c.id === 'bedrock' ? `bedrock:${c.region}` : `${c.id}:${c.apiKey.length}:${c.apiKey.slice(-4)}`
}

function currentProvider(): LlmProvider {
  if (override) return override
  const resolved = resolveProvider()
  if ('reason' in resolved) throw new AiError('not_configured', resolved.reason, { consumption: 'none' })
  const key = configKey(resolved.config)
  if (cached?.key === key) return cached.provider
  const c = resolved.config
  const provider =
    c.id === 'bedrock' ? bedrockProvider(c.region) : c.id === 'anthropic' ? anthropicProvider(c.apiKey) : openaiProvider(c.apiKey)
  cached = { key, provider }
  return provider
}

function finish(
  message: Anthropic.Message,
  provider: ProviderId,
  route: PurposeRoute,
  req: GenerateRequest,
  attempts: number,
): GenerateResult {
  const usage = normalizeUsage(message.usage)
  const ran = { provider, consumption: 'ran' as const, usage }

  if (message.stop_reason === 'refusal') {
    const e = new AiError('refused', 'The model declined the request.', ran)
    e.attempts = attempts
    throw e
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  let json: unknown
  // A step that asks for tools carries no answer yet; the JSON is the final one.
  if (req.jsonSchema && message.stop_reason !== 'tool_use') {
    const cutOff = message.stop_reason === 'max_tokens'
    try {
      if (cutOff) throw new Error('cut off')
      json = JSON.parse(text)
    } catch {
      const e = new AiError(
        'output_invalid',
        cutOff ? 'The JSON answer was cut off at the output ceiling.' : 'The answer was not valid JSON.',
        ran,
      )
      e.attempts = attempts
      throw e
    }
  }

  return {
    provider,
    model: route.model,
    message,
    text,
    ...(req.jsonSchema ? { json } : {}),
    usage,
    costUsd: costOf(route.model, usage),
    attempts,
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const provider = currentProvider()
  // A scripted provider stands in for Claude, so it is routed as Claude.
  const route = routeFor(req.purpose, provider.id === 'scripted' ? 'anthropic' : provider.id)
  const params = buildParams(route, req)
  const stream = shouldStream(route, params.max_tokens) || !!req.onText
  const payment = paymentOf(req)

  const reservation = await reserveSpend({
    purpose: req.purpose,
    model: route.model,
    payer: payment.payer,
    amountUsd: maxCostOf(route.model, params),
    maxTokens: maxEffectiveTokensOf(route.model, params),
    expiresInMs: route.timeoutMs * MAX_ATTEMPTS + SETTLE_GRACE_MS,
    billingAccountId: payment.billing?.billingAccountId,
    projectId: payment.billing?.projectId,
  })

  for (let attempt = 1; ; attempt++) {
    let message: Anthropic.Message
    try {
      message = await provider.send(params, { timeoutMs: route.timeoutMs, signal: req.signal, stream, onText: req.onText })
    } catch (err) {
      const e = classifyProviderError(err, provider.id)
      e.attempts = attempt
      if (!e.model) e.model = route.model
      if (e.retryable && e.consumption === 'none' && attempt < MAX_ATTEMPTS && !req.signal?.aborted) {
        await sleep(retryDelayMs(attempt))
        continue
      }
      await settleFailure(reservation, e, route.model, req, payment)
      throw e
    }

    try {
      const result = finish(message, provider.id, route, req, attempt)
      recordRun(req, payment, route.model, result.usage)
      await settleSpend(reservation, { consumption: 'ran', costUsd: result.costUsd, usage: result.usage })
      return result
    } catch (err) {
      const e = err instanceof AiError ? err : classifyProviderError(err, provider.id)
      if (!e.model) e.model = route.model
      await settleFailure(reservation, e, route.model, req, payment)
      throw e
    }
  }
}

/** Who pays for a request, and the account and project it bills. */
interface Payment {
  payer: 'customer' | 'platform'
  billing?: { billingAccountId?: string; projectId?: string }
}

/**
 * A call that names no account bills the request that made it: the meter a
 * charging route opened names the project (lib/ai/token-meter.ts). Without
 * this, a model call deep inside a tool held no credits and was charged by
 * nobody unless its author remembered to pass `billing`, which is how
 * `functions.schedule` and `integrations.connect` came to spend Backenly's
 * model budget for free (FN-12, FN-19).
 */
function paymentOf(req: GenerateRequest): Payment {
  return {
    payer: req.payer ?? defaultPayer(req.purpose),
    billing: req.billing ?? activeTokenScope()?.billing,
  }
}

/**
 * Account for a call that ran. A customer-paid call's credit-weighted tokens go
 * to the meter of whatever request opened one (a no-op outside a scope); a call
 * the platform pays for never does, so a customer's turn that triggers one is
 * not billed for it. With a project, its usage row is written either way.
 * Never throws and never waits: the call has happened.
 */
function recordRun(req: GenerateRequest, payment: Payment, model: string, usage: NormalizedUsage): void {
  if (payment.payer === 'customer') recordTokens(effectiveTokensOf(model, usage))
  const projectId = payment.billing?.projectId
  if (!projectId) return
  recordAiUsage(projectId, model, usage.promptTokens, usage.outputTokens, req.label ?? req.purpose, usage.cacheReadTokens, {
    tokens5m: usage.cacheWrite5mTokens,
    tokens1h: usage.cacheWrite1hTokens,
  }).catch(() => {})
}

async function settleFailure(
  reservation: Awaited<ReturnType<typeof reserveSpend>>,
  e: AiError,
  model: string,
  req: GenerateRequest,
  payment: Payment,
): Promise<void> {
  if (e.consumption === 'ran' && e.usage) {
    recordRun(req, payment, model, e.usage)
    await settleSpend(reservation, { consumption: 'ran', costUsd: costOf(model, e.usage), usage: e.usage })
  } else if (e.consumption === 'none') {
    await settleSpend(reservation, { consumption: 'none' })
  } else {
    // Inference may have run and its usage is not known: book the reservation.
    await settleSpend(reservation, { consumption: 'unknown' })
  }
}
