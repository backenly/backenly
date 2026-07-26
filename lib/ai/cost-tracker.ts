/**
 * LLM COST TRACKER (#14)
 * =======================
 * Tracks real token usage and cost for every OpenAI call.
 * Records to the AiUsage model and aggregates per project per month.
 *
 * Pricing (USD per 1M tokens, as of 2025):
 *   gpt-4o         input: $2.50   output: $10.00
 *   gpt-4o-mini    input: $0.15   output: $0.60
 *   gpt-4-turbo    input: $10.00  output: $30.00
 *   gpt-4          input: $30.00  output: $60.00
 *   gpt-3.5-turbo  input: $0.50   output: $1.50
 *
 * Alerts when a single request is unexpectedly expensive.
 */

// ─── Model pricing table (USD per 1M tokens) ──────────────────────────────────
interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // gpt-4.1 family — the brain's actual smart model (see lib/ai/model-router).
  // Absent from this table until 2026-07-26, which made every brain call fall
  // through the prefix loop below onto legacy 'gpt-4' at $30/$60 and report
  // ~12x the real cost. 326,874 recorded tokens were billed at $9.87 when the
  // true figure was $0.85.
  'gpt-4.1':         { inputPer1M: 2.00,  outputPer1M: 8.00  },
  'gpt-4.1-mini':    { inputPer1M: 0.40,  outputPer1M: 1.60  },
  'gpt-4.1-nano':    { inputPer1M: 0.10,  outputPer1M: 0.40  },
  'gpt-4o':          { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'gpt-4o-mini':     { inputPer1M: 0.15,  outputPer1M: 0.60  },
  'gpt-4-turbo':     { inputPer1M: 10.00, outputPer1M: 30.00 },
  'gpt-4':           { inputPer1M: 30.00, outputPer1M: 60.00 },
  'gpt-3.5-turbo':   { inputPer1M: 0.50,  outputPer1M: 1.50  },
}

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 2.00, outputPer1M: 8.00 }

/** Alert if a single request costs more than this (USD) */
const SINGLE_REQUEST_ALERT_THRESHOLD = 0.10

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calculate the USD cost for a given model and token counts.
 */
/**
 * Fraction of the input price charged for tokens served from OpenAI's prompt
 * cache. Cached input bills at 25% on the gpt-4o and gpt-4.1 families.
 *
 * This matters far more here than it looks. The brain sends `BRAIN_TOOLS`
 * (~15.7k tokens) plus a fixed system prompt as the first thing in every single
 * request, byte-identical across every turn, every project and every user — a
 * textbook cacheable prefix. Treating those tokens as full price overstated the
 * cost of the loop's dominant component by 4x, on top of the gpt-4 prefix bug.
 */
const CACHED_INPUT_MULTIPLIER = 0.25

/**
 * `cachedTokens` is the subset of `promptTokens` OpenAI served from cache
 * (`usage.prompt_tokens_details.cached_tokens`). Omit it and behaviour is
 * unchanged — every prompt token bills at full rate.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  const pricing = resolvePricing(model)
  // Clamp: cached can never exceed prompt, and a bad reading must not produce a
  // negative bill.
  const cached = Math.max(0, Math.min(cachedTokens, promptTokens))
  const fresh = promptTokens - cached
  const inputCost =
    (fresh / 1_000_000) * pricing.inputPer1M +
    (cached / 1_000_000) * pricing.inputPer1M * CACHED_INPUT_MULTIPLIER
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M
  return parseFloat((inputCost + outputCost).toFixed(6))
}

/**
 * Tokens weighted by what they actually cost us, for metering against a user's
 * credit balance. A cached prompt token is a quarter of a fresh one, so billing
 * it as a whole one charges the user four times over for a catalog they did not
 * ask for and we did not re-pay for.
 *
 * This is what makes a long multi-step build affordable: iteration 1 pays for
 * the tool catalog, iterations 2..N read it from cache, and the credit meter now
 * reflects that instead of charging 15.7k tokens per step.
 */
export function effectiveTokens(promptTokens: number, completionTokens: number, cachedTokens = 0): number {
  const cached = Math.max(0, Math.min(cachedTokens, promptTokens))
  const fresh = promptTokens - cached
  return Math.round(fresh + cached * CACHED_INPUT_MULTIPLIER + completionTokens)
}

/**
 * Estimate cost before making a call (for pre-flight checks).
 * Uses rough token estimate: 1 token ≈ 4 characters.
 */
export function estimateCost(model: string, estimatedInputChars: number, maxOutputTokens: number): number {
  const estimatedInputTokens = Math.ceil(estimatedInputChars / 4)
  return calculateCost(model, estimatedInputTokens, maxOutputTokens)
}

/**
 * Record actual usage after a completed OpenAI call.
 * Non-blocking — use with .catch(() => {}) pattern.
 */
export async function recordAiUsage(
  projectId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  endpoint: string,
  cachedTokens = 0,
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const cost = calculateCost(model, promptTokens, completionTokens, cachedTokens)
    const totalTokens = promptTokens + completionTokens

    await prisma.aiUsage.create({
      data: {
        projectId,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        cost,
        endpoint,
        // Cache hit rate is the single most useful number for reasoning about
        // brain cost, and there is no column for it — `metadata` is Json, so
        // record it there rather than migrate. Lets a query answer "what share
        // of our prompt tokens are we actually re-paying for?"
        metadata: { cachedTokens, cacheHitRate: promptTokens > 0 ? +(cachedTokens / promptTokens).toFixed(3) : 0 },
      },
    })

    // Alert on expensive single requests
    if (cost > SINGLE_REQUEST_ALERT_THRESHOLD) {
      console.warn(
        `[CostTracker] High-cost request: project=${projectId} model=${model} ` +
        `tokens=${totalTokens} cost=$${cost.toFixed(4)} endpoint=${endpoint}`
      )
    }
  } catch (err: any) {
    // Non-fatal — cost tracking failure must never break the AI flow
    console.warn('[CostTracker] Failed to record usage:', err?.message)
  }
}

/**
 * Get total cost for a project this month.
 */
export async function getProjectMonthlyCost(projectId: string): Promise<{
  month: string
  totalCost: number
  totalTokens: number
  callCount: number
  breakdown: Array<{ model: string; cost: number; calls: number; tokens: number }>
}> {
  const { prisma } = await import('@/lib/db/prisma')
  const month = new Date().toISOString().slice(0, 7) // YYYY-MM

  const monthStart = new Date(`${month}-01T00:00:00Z`)
  const monthEnd = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const rows = await prisma.aiUsage.findMany({
    where: {
      projectId,
      createdAt: { gte: monthStart, lt: monthEnd },
    },
    select: { model: true, promptTokens: true, completionTokens: true, totalTokens: true, cost: true },
  })

  // Aggregate by model
  const byModel = new Map<string, { cost: number; calls: number; tokens: number }>()
  let totalCost = 0
  let totalTokens = 0

  for (const row of rows) {
    const cost = row.cost ?? calculateCost(row.model, row.promptTokens, row.completionTokens)
    const entry = byModel.get(row.model) || { cost: 0, calls: 0, tokens: 0 }
    entry.cost += cost
    entry.calls += 1
    entry.tokens += row.totalTokens
    byModel.set(row.model, entry)
    totalCost += cost
    totalTokens += row.totalTokens
  }

  const breakdown = [...byModel.entries()].map(([model, data]) => ({
    model,
    cost: parseFloat(data.cost.toFixed(6)),
    calls: data.calls,
    tokens: data.tokens,
  }))

  return {
    month,
    totalCost: parseFloat(totalCost.toFixed(6)),
    totalTokens,
    callCount: rows.length,
    breakdown,
  }
}

/**
 * Get recent usage history for a project (last N calls).
 */
export async function getRecentUsage(projectId: string, limit = 20): Promise<Array<{
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
  endpoint: string
  createdAt: Date
}>> {
  const { prisma } = await import('@/lib/db/prisma')
  const rows = await prisma.aiUsage.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { model: true, promptTokens: true, completionTokens: true, cost: true, endpoint: true, createdAt: true },
  })
  return rows.map((r: any) => ({
    ...r,
    cost: r.cost ?? calculateCost(r.model, r.promptTokens, r.completionTokens),
  }))
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Prefix keys, LONGEST FIRST. Object insertion order is not a pricing decision,
 * but the old loop treated it as one: it returned the first key that matched, so
 * 'gpt-4' (a 5-char prefix of nearly every OpenAI model name) shadowed every
 * longer, more specific entry that happened to sit after it. 'gpt-4.1-2025-04-14'
 * resolved to legacy gpt-4 at $30/$60 instead of $2/$8.
 *
 * Sorting by length makes the match specific-before-general regardless of how
 * the table is written, so adding a model can no longer be silently defeated by
 * where it lands in the literal. Computed once at module load.
 */
const PRICING_PREFIXES = Object.entries(MODEL_PRICING).sort(
  ([a], [b]) => b.length - a.length,
)

function resolvePricing(model: string): ModelPricing {
  // Exact match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]

  // Longest-prefix match (e.g. "gpt-4.1-mini-2025-04-14" → "gpt-4.1-mini",
  // never the shorter "gpt-4.1" and never bare "gpt-4").
  for (const [key, pricing] of PRICING_PREFIXES) {
    if (model.startsWith(key)) return pricing
  }

  return DEFAULT_PRICING
}
