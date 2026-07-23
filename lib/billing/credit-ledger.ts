/**
 * CREDIT LEDGER — bonus assistant credits (referral / promo grants)
 * =================================================================
 * The monthly plan allowance (`plan.monthlyAiCredits`) is the base budget.
 * Bonus credits are a SEPARATE, persistent, spendable balance
 * (`User.bonusCredits`) granted outside the plan — referral rewards, promos,
 * admin grants. The whole point of this module is that a granted credit is
 * REAL: it raises the effective monthly cap and is actually consumable.
 *
 * Accounting model (chosen to avoid double-counting):
 *   • Within a month, `bonusCredits` is constant (grants only ever raise it).
 *   • Effective cap for the month = plan.monthlyAiCredits + bonusCredits.
 *   • `UserAiUsage.tokenCount` counts ALL spend (allowance + bonus-funded).
 *   • At month rollover we reconcile ONCE: the credits used beyond the plan
 *     allowance last month are burned from `bonusCredits`. Reconciliation is
 *     idempotent, guarded by `User.bonusReconciledThrough` — no cron needed.
 *
 * This module is intentionally low-level (prisma + crypto only) so
 * lib/billing/index.ts can import it without an import cycle.
 */

import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'

// Must match lib/billing/index.ts. Duplicated (2 lines) to keep this module
// free of an import cycle with index.ts.
const TOKENS_PER_CREDIT = 1_000

function creditsFromTokens(tokens: number): number {
  if (tokens <= 0) return 0
  return Math.ceil(tokens / TOKENS_PER_CREDIT)
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1)) // m is 1-based → m-2 = previous month
  return d.toISOString().slice(0, 7)
}

/** userId-scoped advisory lock (month-independent) — serialises grant + reconcile. */
function userLockKeys(userId: string): [number, number] {
  const hash = crypto.createHash('sha256').update(`credit-ledger:${userId}`).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}

export interface GrantResult {
  granted: boolean
  balance: number
  reason?: string
}

/**
 * Grant bonus assistant credits. Atomic (advisory-locked), writes a ledger
 * entry, returns the new balance. When `idempotencyKey` is provided the grant
 * is applied at most once — a repeat call (e.g. a retried webhook) is a no-op.
 */
export async function grantCredits(
  userId: string,
  amount: number,
  opts: {
    reason: string
    description?: string
    referenceId?: string
    /** When set, a ledger entry with this (reason, referenceId) is created at most once. */
    idempotencyKey?: string
  },
): Promise<GrantResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { granted: false, balance: await getRawBalance(userId), reason: 'non-positive amount' }
  }

  const [k1, k2] = userLockKeys(userId)

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, k1, k2)

    if (opts.idempotencyKey) {
      const existing = await tx.creditLedgerEntry.findFirst({
        where: { userId, reason: opts.reason, referenceId: opts.idempotencyKey },
        select: { id: true },
      })
      if (existing) {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { bonusCredits: true } })
        return { granted: false, balance: user?.bonusCredits ?? 0, reason: 'already granted' }
      }
    }

    const user = await tx.user.update({
      where: { id: userId },
      data: { bonusCredits: { increment: amount } },
      select: { bonusCredits: true },
    })

    await tx.creditLedgerEntry.create({
      data: {
        userId,
        amount,
        balanceAfter: user.bonusCredits,
        reason: opts.reason,
        description: opts.description ?? null,
        referenceId: opts.idempotencyKey ?? opts.referenceId ?? null,
      },
    })

    return { granted: true, balance: user.bonusCredits }
  })
}

async function getRawBalance(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { bonusCredits: true } })
  return u?.bonusCredits ?? 0
}

/**
 * Current spendable bonus balance, after folding in any elapsed-month
 * consumption. Cheap in the common case — the locked reconcile transaction
 * only runs when the month-rollover marker is stale.
 */
export async function getBonusCredits(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { bonusCredits: true, bonusReconciledThrough: true },
  })
  if (!user) return 0
  if (needsReconcile(user.bonusReconciledThrough)) {
    await reconcileBonusRollover(userId)
    return getRawBalance(userId)
  }
  return user.bonusCredits
}

function needsReconcile(marker: string | null): boolean {
  const target = prevMonth(thisMonth())
  return marker == null || marker < target
}

/**
 * Fold fully-elapsed months' bonus consumption into `bonusCredits`. Idempotent:
 * advances `bonusReconciledThrough` to last month and never reprocesses a month.
 * Burns are recorded in the ledger with the month as referenceId.
 */
export async function reconcileBonusRollover(userId: string): Promise<void> {
  const cur = thisMonth()
  const target = prevMonth(cur) // reconcile up to and including last month
  const [k1, k2] = userLockKeys(userId)

  // Plan allowance used as the per-month threshold. Current plan is a fair
  // approximation; plan changes are rare and this only affects bonus burn pacing.
  const planCredits = await currentPlanMonthlyCredits(userId)

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, k1, k2)

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { bonusCredits: true, bonusReconciledThrough: true },
    })
    if (!user) return
    if (user.bonusReconciledThrough != null && user.bonusReconciledThrough >= target) return

    let bonus = user.bonusCredits

    // Only bother scanning usage when there's a balance that could be consumed
    // and the plan actually has a finite allowance to exceed.
    if (bonus > 0 && planCredits != null) {
      const rows = await tx.userAiUsage.findMany({
        where: {
          userId,
          date: { lte: target, gt: user.bonusReconciledThrough ?? '' },
        },
        select: { date: true, tokenCount: true },
        orderBy: { date: 'asc' },
      })

      for (const row of rows) {
        if (bonus <= 0) break
        const creditsUsed = creditsFromTokens(row.tokenCount)
        const overage = Math.max(0, creditsUsed - planCredits)
        const burn = Math.min(overage, bonus)
        if (burn > 0) {
          bonus -= burn
          await tx.creditLedgerEntry.create({
            data: {
              userId,
              amount: -burn,
              balanceAfter: bonus,
              reason: 'monthly_bonus_burn',
              description: `Bonus credits used in ${row.date} beyond the ${planCredits}-credit plan allowance`,
              referenceId: row.date,
            },
          })
        }
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: { bonusCredits: bonus, bonusReconciledThrough: target },
    })
  })
}

async function currentPlanMonthlyCredits(userId: string): Promise<number | null> {
  const sub = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
    include: { plan: { select: { monthlyAiCredits: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return sub?.plan?.monthlyAiCredits ?? null
}

export interface CreditLedgerRow {
  id: string
  amount: number
  balanceAfter: number
  reason: string
  description: string | null
  createdAt: Date
}

/** Recent ledger entries for the Billing "Credit activity" history. */
export async function getCreditLedger(userId: string, take = 50): Promise<CreditLedgerRow[]> {
  await getBonusCredits(userId) // ensure rollover burns are materialised first
  return prisma.creditLedgerEntry.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, amount: true, balanceAfter: true, reason: true, description: true, createdAt: true },
  })
}
