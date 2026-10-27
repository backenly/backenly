/**
 * AI CREDIT HOLDS
 * ===============
 * Every customer-paid model call holds its worst case against the account's AI
 * credits before it is sent. Each hold is its own row (ai_credit_holds) with
 * its own expiry, so one leaked hold never lives on because the account stays
 * busy, and holds can be counted, settled and closed one by one.
 *
 * The life of a hold:
 *
 *   reserved  taken before the call, under a per-account lock, while any
 *             credit is left once the credits already charged and every live
 *             hold are counted. Otherwise the call is refused unsent. The hold
 *             counts this call's worst case, so the call after it waits for it
 *             to settle: an account goes over its credits by at most one call,
 *             the last, and only by what that call actually used.
 *   used      the call ran: the hold shrinks to the tokens it actually used and
 *             KEEPS COUNTING until its turn is charged. This is what closes the
 *             gap where a finished call was neither held nor charged.
 *   charged   the turn was charged (closeCreditTurn): the usage now lives in
 *             the charged total, so the hold stops counting.
 *   released  the call never ran or its answer was lost (the customer pays
 *             nothing for either), the turn was not charged, or nothing will
 *             ever charge it (a call made outside any turn).
 *
 * Charge first, then close: closeCreditTurn records the charge and only then
 * marks the turn's holds charged. In between, usage is counted twice, which is
 * the safe direction; it is never counted zero times. If the charge fails, the
 * holds stay counted until they expire, so a billing fault can cost revenue but
 * never frees credits a call used. The charge itself is Cloud's commercial
 * write (recordAiConsumption), which is why the two are ordered rather than
 * one transaction.
 *
 * Settling only moves a hold out of `reserved`, so a late settlement after its
 * turn closed changes nothing. Holds past their expiry count as nothing: a
 * reserved hold expires with the gateway's own reservation, a used one
 * USED_HOLD_TTL_MINUTES after its call, which bounds what a crash can strand.
 *
 * Fail-open where it always was: no account, no entitlements, unlimited credits
 * or a failed entitlement read mean no hold. A hold that cannot be WRITTEN
 * refuses the call, because sending it then would spend credits nobody checked.
 *
 * Holding is policy, not commercial recording, so it is public (see
 * lib/entitlements/provider.ts for that split).
 */

import { prisma } from '@/lib/db/prisma'
import { AiError } from '@/lib/ai/llm/errors'
import type { CustomerSpendHook } from '@/lib/ai/llm/spend'
import { activeTokenScope, type TokenScope } from '@/lib/ai/token-meter'
import { creditAccountOf } from '@/lib/usage/account'
import { aiCreditCap, chargeAiCredits, creditsFromTokens, thisMonth } from './policy'
import { invalidateUsageCache } from './usage-cache'

/** How long a used hold keeps counting while its turn finishes and is charged. */
export const USED_HOLD_TTL_MINUTES = 15

/** A call nobody needs to hold credits for. */
const NO_HOLD = { id: 'none' }

export const creditHoldHook: CustomerSpendHook = {
  async reserve({ maxTokens, expiresInMs, billingAccountId, projectId }) {
    const account = billingAccountId ?? (projectId ? await creditAccountOf(projectId) : null)
    if (!account) return NO_HOLD
    const cap = await aiCreditCap(account).catch(() => null)
    if (cap === null) return NO_HOLD

    const month = thisMonth()
    const tokens = Math.max(0, Math.ceil(maxTokens))
    const scope = activeTokenScope()
    let id: string | null
    let spent = false
    try {
      id = await prisma.$transaction(async (tx) => {
        // Serialises holds for one account and month, so two calls racing for
        // the last credits cannot both read the total without the other.
        // Prisma stores DateTime as a UTC timestamp without a zone, so expiry
        // is compared with UTC now; a bare now() would read it in the
        // session's zone and, east of UTC, see live holds as expired.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-credit-hold:${account}:${month}`}, 0))`
        const [row] = await tx.$queryRaw<Array<{ charged: bigint; held: bigint }>>`
          SELECT
            COALESCE((SELECT "tokenCount" FROM "account_ai_usage"
                       WHERE "billingAccountId" = ${account} AND "date" = ${month}), 0)::bigint AS charged,
            COALESCE((SELECT SUM(CASE WHEN "status" = 'reserved' THEN "tokens" ELSE COALESCE("usedTokens", "tokens") END)
                        FROM "ai_credit_holds"
                       WHERE "billingAccountId" = ${account} AND "month" = ${month}
                         AND "status" IN ('reserved', 'used') AND "expiresAt" > (now() AT TIME ZONE 'UTC')), 0)::bigint AS held`
        // A call starts while any credit is left, rather than only when its
        // worst case fits: a whole call's worst case is far more than a call
        // uses, so requiring it stranded the last part of every allowance. The
        // hold below still counts that worst case, so the next call waits for
        // this one to settle.
        if (creditsFromTokens(Number(row.charged) + Number(row.held)) >= cap) {
          spent = creditsFromTokens(Number(row.charged)) >= cap
          return null
        }
        const hold = await tx.aiCreditHold.create({
          data: {
            billingAccountId: account,
            month,
            tokens,
            turnScoped: scope !== undefined,
            expiresAt: new Date(Date.now() + Math.max(expiresInMs, 60_000)),
          },
          select: { id: true },
        })
        return hold.id
      })
    } catch (err) {
      throw new AiError(
        'spend_unavailable',
        `Your AI credits could not be checked for this call, so it was not sent (${err instanceof Error ? err.message : String(err)}).`,
        { consumption: 'none' },
      )
    }
    if (id === null) {
      throw new AiError(
        'credits_exhausted',
        spent
          ? 'This account has used all its AI credits this month, so this call was not sent. ' +
              'Credits reset on the 1st, or upgrade for more.'
          : "The rest of this account's AI credits this month are held by work still in progress, so this call was not " +
              'sent. Try again when it finishes. Credits reset on the 1st, or upgrade for more.',
        { consumption: 'none' },
      )
    }
    scope?.holds.push(id)
    invalidateUsageCache(account)
    return { id }
  },

  async settle(id, { outcome, tokens }) {
    if (id === NO_HOLD.id) return
    const now = new Date()
    // A call that ran inside a turn keeps counting at what it used until the
    // turn is charged. Anything else is released: it never ran, its answer was
    // lost (the customer pays nothing), or no turn will ever charge it.
    await prisma.aiCreditHold.updateMany({
      where: { id, status: 'reserved', turnScoped: true },
      data:
        outcome === 'ran'
          ? { status: 'used', usedTokens: Math.max(0, Math.ceil(tokens ?? 0)), settledAt: now, expiresAt: new Date(now.getTime() + USED_HOLD_TTL_MINUTES * 60_000) }
          : { status: 'released', settledAt: now },
    })
    await prisma.aiCreditHold.updateMany({
      where: { id, status: 'reserved', turnScoped: false },
      data: { status: 'released', settledAt: now },
    })
  },
}

/**
 * End a turn's credit accounting: charge `chargeTokens` to the account, then
 * stop counting the turn's settled holds. A turn charged nothing releases
 * them. Holds still in flight (a call outlived the turn, as on a timeout) are
 * left to settle and expire on their own, so they keep counting meanwhile.
 *
 * Never throws: it runs after the turn's answer is decided.
 */
export async function closeCreditTurn(account: string | null, scope: TokenScope, chargeTokens: number): Promise<void> {
  const charging = account !== null && Number.isFinite(chargeTokens) && chargeTokens > 0
  if (charging) {
    try {
      await chargeAiCredits(account, chargeTokens)
    } catch (err) {
      // The holds stay counted until they expire: never uncounted.
      console.error('[AiCredits] charging the turn failed; its holds stay counted until they expire:', err instanceof Error ? err.message : err)
      return
    }
  }
  if (scope.holds.length === 0) return
  await prisma.aiCreditHold
    .updateMany({
      where: { id: { in: scope.holds }, status: 'used' },
      data: { status: charging ? 'charged' : 'released' },
    })
    .catch((err) => console.error('[AiCredits] closing the turn’s holds failed; they expire on their own:', err instanceof Error ? err.message : err))
  if (account) invalidateUsageCache(account)
}
