/**
 * TOKEN METER — model spend is measured at the boundary, not at call sites
 * ========================================================================
 * Every credit charge in this codebase used to be a call-site obligation: the
 * author of a model-backed path had to remember to add `chargeAiCredits`. That
 * contract failed twice, in the same way, for months at a time:
 *
 *   • `backend_chat` ran a full multi-step brain loop on our key with no charge
 *     at all — `chargeAiCredits` had literally no callers (see the header of
 *     app/api/mcp/chat/route.ts).
 *   • `generate_function` on /api/mcp/tool was *gated* on credits but never
 *     debited them. Because the meter never moved, the gate never tripped, so
 *     the tool was effectively unlimited: 600 calls/min per key (the default
 *     rate limit) against an unbounded monthly total on any plan with unlimited
 *     API requests.
 *
 * Both bugs are invisible in review — the code reads correctly, the tests pass,
 * and the cost lands weeks later on an invoice nobody can attribute. The fix is
 * to stop relying on the author remembering. Every model call in the platform
 * goes through the AI gateway (lib/ai/llm), which reports each customer-paid
 * call that ran into whatever meter scope is active on the async stack.
 *
 * A caller that wants to bill opens a scope; a caller that doesn't, doesn't.
 * `recordTokens` is a silent no-op outside a scope, so the autonomy loop, the
 * free dashboard assistant, and the brain's own `onTokens` accounting all
 * continue exactly as before.
 *
 * A scope can also name who pays (`billing`). A customer-paid call made inside
 * it that names no account then holds that account's credits before it is
 * sent, so the turn is gated as well as charged. The tool route used to gate
 * and charge only the tools on a hand-kept list; `functions.schedule` and
 * `integrations.connect` reached the model too, and were neither (FN-12,
 * FN-19).
 *
 * CONSEQUENCE FOR NEW CODE: a new model-backed tool on a metered route is
 * gated and charged correctly the moment it is written, with no billing code
 * in it.
 */

import { AsyncLocalStorage } from 'async_hooks'

export interface TokenScope {
  /**
   * Tokens of the customer-paid calls that ran inside this scope, weighted the
   * way AI credits count them. A call the platform pays for (autonomy,
   * support) is never counted, so a turn that triggers one is not billed for it.
   */
  tokens: number
  /**
   * AI credit holds taken by calls inside this scope, closed together when the
   * turn is charged (lib/entitlements/credit-holds.ts closeCreditTurn).
   */
  holds: string[]
  /**
   * Who pays for a customer-paid call made inside this scope that names no
   * account itself: its credit hold is taken against this account and its usage
   * is logged to this project. Unset, such a call holds nothing.
   */
  billing?: { projectId?: string; billingAccountId?: string }
}

const storage = new AsyncLocalStorage<TokenScope>()

/** A fresh scope. Hold the reference — it stays readable after `runInTokenScope` throws. */
export function createTokenScope(billing?: TokenScope['billing']): TokenScope {
  return billing ? { tokens: 0, holds: [], billing } : { tokens: 0, holds: [] }
}

/** The scope open on this async stack, if any. */
export function activeTokenScope(): TokenScope | undefined {
  return storage.getStore()
}

/**
 * Run `fn` with `scope` active. Any customer-paid call issued underneath, at
 * any async depth, accumulates into `scope.tokens`.
 *
 * Deliberately does NOT swallow errors and does NOT return the tally: a run
 * that threw still burned real tokens, and the caller bills from `scope` in a
 * `finally`. That is the same stance the chat route takes on its 90s timeout —
 * the run that died at 80s is precisely the one worth charging for.
 *
 * The scope names a payer only while `fn` runs. Work `fn` sets going in the
 * background (the reconciler's function self-heal a minute later, say) keeps
 * the scope on its async stack but outlives the turn that would charge it, so
 * from then on its calls hold nothing, as before scopes named a payer. Healing
 * is never billed to a customer's credits, and must not be refused for them.
 */
export function runInTokenScope<T>(scope: TokenScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn).finally(() => {
    scope.billing = undefined
  })
}

/** Add raw tokens to the active scope. No-op when no scope is open. */
export function recordTokens(count: number): void {
  if (!Number.isFinite(count) || count <= 0) return
  const scope = storage.getStore()
  if (scope) scope.tokens += count
}

/**
 * Record a completion's usage into the active scope.
 *
 * Tolerant by construction — it is called on every completion the platform
 * makes, including streams (no `usage`) and any future response shape. Anything
 * it cannot read is skipped rather than thrown: a metering fault must never
 * take down the call it was measuring.
 */
export function meterCompletion(response: unknown): void {
  try {
    const usage = (response as { usage?: { total_tokens?: unknown } } | null)?.usage
    const total = usage?.total_tokens
    if (typeof total === 'number') recordTokens(total)
  } catch {
    /* metering is never load-bearing */
  }
}

/**
 * Attach the meter to an OpenAI client, in place.
 *
 * Wraps `chat.completions.create` while preserving the exact object it returns.
 * The SDK hands back an `APIPromise`, which carries `.withResponse()` /
 * `.asResponse()` beyond the thenable contract — re-wrapping it in an `async`
 * function would silently strip those. So the original return value is passed
 * straight through and the meter rides along on a detached `.then`, whose
 * rejection handler exists solely to keep a failed call from surfacing as an
 * unhandled rejection (the real error still propagates to the real caller).
 */
export function attachTokenMeter(client: {
  chat: { completions: { create: (...args: any[]) => any } }
}): void {
  const completions = client.chat.completions
  const anyCompletions = completions as { create: (...args: any[]) => any; __metered?: boolean }
  if (anyCompletions.__metered) return // idempotent — clients are singletons
  const original = completions.create.bind(completions)

  anyCompletions.create = (...args: any[]) => {
    const out = original(...args)
    if (out && typeof out.then === 'function') {
      out.then(
        (res: unknown) => meterCompletion(res),
        () => {
          /* the caller owns this failure; the meter just declines to count it */
        },
      )
    }
    return out
  }
  anyCompletions.__metered = true
}
