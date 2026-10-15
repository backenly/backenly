/**
 * AI SPEND — reserved before every model call, settled after it
 * ==============================================================
 *
 * Two monthly limits, both optional, both enforced atomically:
 *
 *   AI_TOTAL_MONTHLY_HARD_LIMIT_USD   every call, whoever pays. On Backenly
 *                                     Cloud this protects the AWS credits.
 *   AI_PLATFORM_MONTHLY_BUDGET_USD    calls the deployment pays for itself
 *                                     (autonomy investigations), as opposed
 *                                     to calls billed to a customer.
 *
 * Before a call, its worst case (estimated prompt plus the full output
 * ceiling) is reserved against each limit with one conditional update, so
 * concurrent calls cannot overshoot between a check and a charge. If the
 * reservation cannot be written at all, the call is not made.
 *
 * After it, the reservation settles one of three ways (docs/ai-billing-settlement.md):
 *
 *   ran      The provider returned usage. Its real cost is charged.
 *   none     The request was never sent, or was refused before inference.
 *            Nothing is charged; the reservation is released.
 *   unknown  The request went out and the answer was lost (a timeout, a
 *            dropped connection). A lost answer is not proof nothing ran, so
 *            the full reservation is booked as unknown usage against the
 *            limits. A customer is never charged for it.
 *
 * A reservation that never settles (the process died mid-call) expires and is
 * booked as unknown the same way.
 *
 * Customer billing is a hook (setCustomerSpendHook): the deployment that bills
 * customers holds credits there, and a self-hosted install bills nobody.
 */

import { prisma } from '@/lib/db/prisma'
import { AiError } from './errors'
import { effectiveTokensOf } from './usage'
import type { AiPurpose, NormalizedUsage } from './types'

export type Payer = 'customer' | 'platform'
export type SpendScope = 'total' | 'platform'
export type Settlement = 'settled' | 'released' | 'unknown'

/**
 * Who pays for a purpose unless the call says otherwise. Autonomy and support
 * are the deployment's own work: healing a backend and answering a support
 * case must never spend the customer's plan credits.
 */
export function defaultPayer(purpose: AiPurpose): Payer {
  return purpose.startsWith('autonomy.') || purpose.startsWith('support.') ? 'platform' : 'customer'
}

export interface SpendLimits {
  totalUsd: number | null
  platformUsd: number | null
}

function parseLimit(name: string, env: Record<string, string | undefined>): number | null {
  const raw = env[name]?.trim()
  if (!raw) return null
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return n
  // A limit someone meant to set but mistyped must not become "unlimited".
  console.warn(`[AiSpend] ${name}="${raw}" is not a dollar amount; treating it as 0, so no AI call is allowed.`)
  return 0
}

export function spendLimits(env: Record<string, string | undefined> = process.env): SpendLimits {
  return {
    totalUsd: parseLimit('AI_TOTAL_MONTHLY_HARD_LIMIT_USD', env),
    platformUsd: parseLimit('AI_PLATFORM_MONTHLY_BUDGET_USD', env),
  }
}

export interface Hold {
  id: string
  month: string
  scopes: SpendScope[]
  amountUsd: number
}

export interface ReserveInput {
  purpose: AiPurpose
  model: string
  payer: Payer
  amountUsd: number
  /** How long until an unsettled reservation is booked as unknown. */
  expiresInMs: number
}

/** Where reservations are kept. Postgres in production; memory in unit tests. */
export interface SpendLedger {
  reserve(input: ReserveInput, limits: SpendLimits, now: Date): Promise<Hold>
  settle(hold: Hold, outcome: Settlement, chargedUsd: number): Promise<void>
  /** Book every reservation past its expiry as unknown. Returns how many. */
  expire(now: Date): Promise<number>
}

export const monthOf = (d: Date) => d.toISOString().slice(0, 7)

function scopesFor(payer: Payer): SpendScope[] {
  return payer === 'platform' ? ['total', 'platform'] : ['total']
}

function limitFor(scope: SpendScope, limits: SpendLimits): number | null {
  return scope === 'total' ? limits.totalUsd : limits.platformUsd
}

function limitReached(scope: SpendScope): AiError {
  return new AiError(
    'spend_limit',
    scope === 'platform'
      ? 'The monthly budget for AI the deployment pays for itself is used up.'
      : 'The monthly AI spending limit for this deployment is reached.',
    { consumption: 'none' },
  )
}

class LimitReached extends Error {
  constructor(readonly scope: SpendScope) {
    super(`limit reached: ${scope}`)
  }
}

// ── Postgres ────────────────────────────────────────────────────────────────

export const postgresSpendLedger: SpendLedger = {
  async reserve(input, limits, now) {
    const month = monthOf(now)
    const scopes = scopesFor(input.payer)
    const amount = input.amountUsd
    try {
      const id = await prisma.$transaction(async (tx) => {
        for (const scope of scopes) {
          await tx.$executeRaw`
            INSERT INTO "ai_spend_periods" ("month", "scope") VALUES (${month}, ${scope})
            ON CONFLICT ("month", "scope") DO NOTHING`
          const limit = limitFor(scope, limits)
          // One statement, so the check and the increment cannot be split by
          // a concurrent call: the row lock makes the second wait and re-check.
          const updated =
            limit === null
              ? await tx.$executeRaw`
                  UPDATE "ai_spend_periods"
                     SET "reservedUsd" = "reservedUsd" + ${amount}::numeric, "updatedAt" = now()
                   WHERE "month" = ${month} AND "scope" = ${scope}`
              : await tx.$executeRaw`
                  UPDATE "ai_spend_periods"
                     SET "reservedUsd" = "reservedUsd" + ${amount}::numeric, "updatedAt" = now()
                   WHERE "month" = ${month} AND "scope" = ${scope}
                     AND "reservedUsd" + "settledUsd" + "unknownUsd" + ${amount}::numeric <= ${limit}::numeric`
          if (updated === 0) throw new LimitReached(scope)
        }
        const hold = await tx.aiSpendHold.create({
          data: {
            month,
            scopes,
            purpose: input.purpose,
            model: input.model,
            amountUsd: amount,
            expiresAt: new Date(now.getTime() + input.expiresInMs),
          },
          select: { id: true },
        })
        return hold.id
      })
      return { id, month, scopes, amountUsd: amount }
    } catch (err) {
      if (err instanceof LimitReached) throw limitReached(err.scope)
      throw new AiError(
        'spend_unavailable',
        `The AI spend reservation could not be written: ${err instanceof Error ? err.message : String(err)}`,
        { consumption: 'none' },
      )
    }
  },

  async settle(hold, outcome, chargedUsd) {
    const charged = outcome === 'settled' ? chargedUsd : 0
    await prisma.$transaction(async (tx) => {
      // Idempotent: only a reservation still open moves, so a late settle after
      // expiry, or a second settle, changes nothing.
      const moved = await tx.aiSpendHold.updateMany({
        where: { id: hold.id, status: 'reserved' },
        data: { status: outcome, chargedUsd: charged, settledAt: new Date() },
      })
      if (moved.count === 0) return
      for (const scope of hold.scopes) {
        if (outcome === 'settled') {
          await tx.$executeRaw`
            UPDATE "ai_spend_periods"
               SET "reservedUsd" = "reservedUsd" - ${hold.amountUsd}::numeric,
                   "settledUsd" = "settledUsd" + ${charged}::numeric, "updatedAt" = now()
             WHERE "month" = ${hold.month} AND "scope" = ${scope}`
        } else if (outcome === 'unknown') {
          await tx.$executeRaw`
            UPDATE "ai_spend_periods"
               SET "reservedUsd" = "reservedUsd" - ${hold.amountUsd}::numeric,
                   "unknownUsd" = "unknownUsd" + ${hold.amountUsd}::numeric, "updatedAt" = now()
             WHERE "month" = ${hold.month} AND "scope" = ${scope}`
        } else {
          await tx.$executeRaw`
            UPDATE "ai_spend_periods"
               SET "reservedUsd" = "reservedUsd" - ${hold.amountUsd}::numeric, "updatedAt" = now()
             WHERE "month" = ${hold.month} AND "scope" = ${scope}`
        }
      }
    })
  },

  async expire(now) {
    const stale = await prisma.aiSpendHold.findMany({
      where: { status: 'reserved', expiresAt: { lt: now } },
      select: { id: true, month: true, scopes: true, amountUsd: true },
      take: 100,
    })
    for (const h of stale) {
      await postgresSpendLedger.settle(
        { id: h.id, month: h.month, scopes: h.scopes as SpendScope[], amountUsd: Number(h.amountUsd) },
        'unknown',
        0,
      )
    }
    return stale.length
  },
}

// ── Memory (unit tests) ─────────────────────────────────────────────────────

export interface MemorySpendLedger extends SpendLedger {
  periods: Map<string, { reserved: number; settled: number; unknown: number }>
  holds: Map<string, Hold & { status: Settlement | 'reserved'; expiresAt: number; charged: number }>
}

export function memorySpendLedger(): MemorySpendLedger {
  const periods: MemorySpendLedger['periods'] = new Map()
  const holds: MemorySpendLedger['holds'] = new Map()
  let next = 0
  const period = (month: string, scope: SpendScope) => {
    const key = `${month}:${scope}`
    if (!periods.has(key)) periods.set(key, { reserved: 0, settled: 0, unknown: 0 })
    return periods.get(key)!
  }
  const ledger: MemorySpendLedger = {
    periods,
    holds,
    async reserve(input, limits, now) {
      const month = monthOf(now)
      const scopes = scopesFor(input.payer)
      for (const scope of scopes) {
        const p = period(month, scope)
        const limit = limitFor(scope, limits)
        if (limit !== null && p.reserved + p.settled + p.unknown + input.amountUsd > limit + 1e-9) throw limitReached(scope)
      }
      for (const scope of scopes) period(month, scope).reserved += input.amountUsd
      const hold = { id: `hold_${++next}`, month, scopes, amountUsd: input.amountUsd }
      holds.set(hold.id, { ...hold, status: 'reserved', expiresAt: now.getTime() + input.expiresInMs, charged: 0 })
      return hold
    },
    async settle(hold, outcome, chargedUsd) {
      const h = holds.get(hold.id)
      if (!h || h.status !== 'reserved') return
      h.status = outcome
      h.charged = outcome === 'settled' ? chargedUsd : 0
      for (const scope of hold.scopes) {
        const p = period(hold.month, scope)
        p.reserved -= hold.amountUsd
        if (outcome === 'settled') p.settled += h.charged
        if (outcome === 'unknown') p.unknown += hold.amountUsd
      }
    },
    async expire(now) {
      let n = 0
      for (const h of holds.values()) {
        if (h.status === 'reserved' && h.expiresAt < now.getTime()) {
          await ledger.settle(h, 'unknown', 0)
          n++
        }
      }
      return n
    },
  }
  return ledger
}

// ── Customer billing hook ───────────────────────────────────────────────────

/**
 * How a deployment that bills customers holds and charges their credits for a
 * call. Throw an AiError (kind `credits_exhausted`) from `reserve` to refuse.
 */
export interface CustomerSpendHook {
  /**
   * `maxTokens` is the call's worst case in effective tokens, the unit AI
   * credits count; `expiresInMs` is when the gateway books an unsettled call
   * as unknown.
   */
  reserve(input: { purpose: AiPurpose; model: string; maxUsd: number; maxTokens: number; expiresInMs: number; billingAccountId?: string; projectId?: string }): Promise<{ id: string }>
  /** `chargeUsd` and `tokens` (effective) are 0 unless inference ran and returned usage. */
  settle(id: string, input: { chargeUsd: number; tokens: number; outcome: 'ran' | 'none' | 'unknown'; usage?: NormalizedUsage }): Promise<void>
}

// Undefined until set: the credit hold (lib/entitlements/credit-holds.ts), a
// no-op wherever there are no finite credits to protect. Null turns it off.
let customerHook: CustomerSpendHook | null | undefined
let ledger: SpendLedger = postgresSpendLedger
let lastExpiry = 0

/** Replace the customer hook. `null` turns customer holds off; `undefined` restores the credit hold. */
export function setCustomerSpendHook(hook: CustomerSpendHook | null | undefined): void {
  customerHook = hook
}

export function setSpendLedgerForTests(next: SpendLedger | null): void {
  ledger = next ?? postgresSpendLedger
  lastExpiry = 0
}

export interface Reservation {
  hold: Hold
  model: string
  customerHoldId?: string
}

async function currentCustomerHook(): Promise<CustomerSpendHook | null> {
  if (customerHook === undefined) customerHook = (await import('@/lib/entitlements/credit-holds')).creditHoldHook
  return customerHook
}

export async function reserveSpend(
  input: ReserveInput & { maxTokens?: number; billingAccountId?: string; projectId?: string },
  now = new Date(),
): Promise<Reservation> {
  // Book abandoned reservations as unknown before checking the limit, at most
  // once a minute per process. They are what a crash mid-call leaves behind.
  if (now.getTime() - lastExpiry > 60_000) {
    lastExpiry = now.getTime()
    await ledger.expire(now).catch((err) => console.warn('[AiSpend] expiring stale reservations failed:', err?.message ?? err))
  }

  const hold = await ledger.reserve(input, spendLimits(), now)
  if (input.payer !== 'customer') return { hold, model: input.model }
  try {
    const hook = await currentCustomerHook()
    if (!hook) return { hold, model: input.model }
    const { id } = await hook.reserve({
      purpose: input.purpose,
      model: input.model,
      maxUsd: input.amountUsd,
      maxTokens: input.maxTokens ?? 0,
      expiresInMs: input.expiresInMs,
      billingAccountId: input.billingAccountId,
      projectId: input.projectId,
    })
    return { hold, model: input.model, customerHoldId: id }
  } catch (err) {
    await ledger.settle(hold, 'released', 0).catch(() => {})
    throw err instanceof AiError
      ? err
      : new AiError('spend_unavailable', `The customer credit hold could not be written: ${String(err)}`, { consumption: 'none' })
  }
}

/**
 * Settle a reservation. Never throws: the call it accounts for has already
 * happened. A settlement that fails leaves the reservation open, which counts
 * against the limits until it expires as unknown — the conservative direction.
 */
export async function settleSpend(
  r: Reservation,
  outcome: { consumption: 'ran'; costUsd: number; usage: NormalizedUsage } | { consumption: 'none' } | { consumption: 'unknown' },
): Promise<void> {
  const settlement: Settlement = outcome.consumption === 'ran' ? 'settled' : outcome.consumption === 'none' ? 'released' : 'unknown'
  const charged = outcome.consumption === 'ran' ? outcome.costUsd : 0
  if (settlement === 'unknown') {
    console.warn(
      `[AiSpend] booked $${r.hold.amountUsd.toFixed(4)} as unknown usage: the answer was lost after the request was sent.`,
    )
  }
  await ledger.settle(r.hold, settlement, charged).catch((err) => {
    console.error('[AiSpend] settlement failed; the reservation stays open until it expires:', err?.message ?? err)
  })
  if (r.customerHoldId && customerHook) {
    await customerHook
      .settle(r.customerHoldId, {
        chargeUsd: charged,
        tokens: outcome.consumption === 'ran' ? effectiveTokensOf(r.model, outcome.usage) : 0,
        outcome: outcome.consumption,
        ...(outcome.consumption === 'ran' ? { usage: outcome.usage } : {}),
      })
      .catch((err) => console.error('[AiSpend] customer settlement failed:', err?.message ?? err))
  }
}
