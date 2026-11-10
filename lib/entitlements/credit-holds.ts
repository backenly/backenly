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
 *             to settle: only one call, the last, can use more than is left,
 *             and what it uses past the cap is not charged.
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
 * Some work is charged a price, not the tokens its calls used: a confirmed
 * build is charged the architect's tokens its proposal deferred plus a fixed
 * price per step. That price is held whole before the work starts, or the work
 * does not start (holdTurnPrice).
 *
 * A charge never takes an account past its cap. What a turn used beyond the
 * credits it had left (the last call's overrun, which a call may make because
 * it starts while any credit is left) is not charged: Backenly absorbs it, and
 * logs it. The usage page reads the charged total, so it never shows more
 * credits used than the account has.
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
import { aiCreditCap, chargeAiCredits, creditsFromTokens, thisMonth, TOKENS_PER_CREDIT } from './policy'
import { invalidateUsageCache } from './usage-cache'

/** How long a used hold keeps counting while its turn finishes and is charged. */
export const USED_HOLD_TTL_MINUTES = 15

/** A call nobody needs to hold credits for. */
const NO_HOLD = { id: 'none' }

export const creditHoldHook: CustomerSpendHook = {
  async reserve({ maxTokens, expiresInMs, billingAccountId, projectId }) {
    const account = billingAccountId ?? (projectId ? await creditAccountOf(projectId) : null)
    if (!account) return NO_HOLD
    const scope = activeTokenScope()
    // The turn's whole price is already held for this account, and this call
    // is part of what the price pays for (holdTurnPrice).
    if (scope?.coveredFor === account) return NO_HOLD
    const cap = await aiCreditCap(account).catch(() => null)
    if (cap === null) return NO_HOLD

    const month = thisMonth()
    const tokens = Math.max(0, Math.ceil(maxTokens))
    let id: string | null
    let spent = false
    try {
      id = await prisma.$transaction(async (tx) => {
        // Serialises holds for one account and month, so two calls racing for
        // the last credits cannot both read the total without the other.
        await lockCredits(tx, account, month)
        const { charged, inFlight, used } = await creditsInUse(tx, account, month, [])
        // A call starts while any credit is left, rather than only when its
        // worst case fits: a whole call's worst case is far more than a call
        // uses, so requiring it stranded the last part of every allowance. The
        // hold below still counts that worst case, so the next call waits for
        // this one to settle.
        if (creditsFromTokens(charged + inFlight + used) >= cap) {
          spent = creditsFromTokens(charged) >= cap
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

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * Serialises everything that reads or moves one account's credits in a month:
 * holds, prices and charges. Each reads the total the one before it left.
 */
async function lockCredits(tx: Tx, account: string, month: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-credit-hold:${account}:${month}`}, 0))`
}

/**
 * Under the lock: the tokens charged this month, and what the live holds count
 * (leaving out `ownHolds`), split into calls still in flight (at their worst
 * case) and calls that ran (at what they used, until their turn is charged).
 *
 * Prisma stores DateTime as a UTC timestamp without a zone, so expiry is
 * compared with UTC now; a bare now() would read it in the session's zone and,
 * east of UTC, see live holds as expired.
 */
async function creditsInUse(
  tx: Tx,
  account: string,
  month: string,
  ownHolds: string[],
): Promise<{ charged: number; inFlight: number; used: number }> {
  const [row] = await tx.$queryRaw<Array<{ charged: bigint; in_flight: bigint; used: bigint }>>`
    SELECT
      COALESCE((SELECT "tokenCount" FROM "account_ai_usage"
                 WHERE "billingAccountId" = ${account} AND "date" = ${month}), 0)::bigint AS charged,
      COALESCE(SUM("tokens") FILTER (WHERE "status" = 'reserved'), 0)::bigint AS in_flight,
      COALESCE(SUM(COALESCE("usedTokens", "tokens")) FILTER (WHERE "status" = 'used'), 0)::bigint AS used
      FROM "ai_credit_holds"
     WHERE "billingAccountId" = ${account} AND "month" = ${month}
       AND "status" IN ('reserved', 'used') AND "expiresAt" > (now() AT TIME ZONE 'UTC')
       AND NOT ("id" = ANY(${ownHolds}::text[]))`
  return { charged: Number(row.charged), inFlight: Number(row.in_flight), used: Number(row.used) }
}

/** Why a turn's price was not held. */
export type PriceRefusal =
  | {
      reason: 'credits'
      /** Credits the work needs at most, rounded up. */
      neededCredits: number
      /** Credits left this month once what is already charged is counted. */
      leftCredits: number
      /** Enough are left, but work still in progress holds them. */
      heldByOtherWork: boolean
    }
  | { reason: 'unavailable'; detail: string }

/**
 * Hold a price a turn knows before it does the work: a confirmed build's, the
 * architect's tokens its proposal deferred plus a fixed price per step
 * (lib/ai/brain/agent.ts). A turn's model calls are held one by one as they
 * are sent. This price is not a model call, and it was charged when the build
 * ended without ever being held, so a build ran with fewer credits left than
 * it cost and charged the account past its cap.
 *
 * Unlike a call's worst case, this price is known, so all of it must fit: the
 * credits already charged, every other turn's live holds and the price stay
 * within the cap, or nothing is held and the work does not start. This turn's
 * own holds are left out of the sum, since the price is all a build is charged.
 *
 * The hold is taken as used, at the price, and closes with the turn's charge
 * like any other. It lasts while the work can run (`runsForMs`) and then
 * USED_HOLD_TTL_MINUTES, like a used hold. The turn is then covered: a model
 * call it makes for the same account (a function a step generates, the
 * post-build check) is part of what the price pays for and holds nothing more,
 * so a build that takes the last credits is not refused its own steps.
 *
 * Null when the price is held, or there is nothing to hold: a price of
 * nothing, and, fail-open where holds are, no turn to charge it (no scope), no
 * account, no cap or a failed entitlement read. A hold that cannot be
 * written refuses the work, as it refuses a call.
 */
export async function holdTurnPrice(
  projectId: string,
  priceTokens: number,
  { runsForMs = 0 }: { runsForMs?: number } = {},
): Promise<PriceRefusal | null> {
  const scope = activeTokenScope()
  if (!scope || !(priceTokens > 0)) return null
  const account = scope.billing?.billingAccountId ?? (await creditAccountOf(projectId))
  if (!account) return null
  const cap = await aiCreditCap(account).catch(() => null)
  if (cap === null) return null

  const month = thisMonth()
  const price = Math.max(0, Math.ceil(priceTokens))
  const capTokens = cap * TOKENS_PER_CREDIT
  try {
    const refusal = await prisma.$transaction(async (tx) => {
      await lockCredits(tx, account, month)
      const { charged, inFlight, used } = await creditsInUse(tx, account, month, scope.holds)
      const held = inFlight + used
      if (charged + held + price > capTokens) {
        return {
          reason: 'credits' as const,
          neededCredits: creditsFromTokens(price),
          leftCredits: Math.max(0, Math.floor((capTokens - charged) / TOKENS_PER_CREDIT)),
          heldByOtherWork: charged + price <= capTokens,
        }
      }
      const now = Date.now()
      const hold = await tx.aiCreditHold.create({
        data: {
          billingAccountId: account,
          month,
          tokens: price,
          status: 'used',
          usedTokens: price,
          turnScoped: true,
          settledAt: new Date(now),
          expiresAt: new Date(now + Math.max(0, runsForMs) + USED_HOLD_TTL_MINUTES * 60_000),
        },
        select: { id: true },
      })
      scope.holds.push(hold.id)
      return null
    })
    if (refusal) return refusal
  } catch (err) {
    return { reason: 'unavailable', detail: err instanceof Error ? err.message : String(err) }
  }
  scope.coveredFor = account
  invalidateUsageCache(account)
  return null
}

/**
 * True when the project's account has AI credits to count: a plan with a cap.
 * False where nothing is enforced, or when the account cannot be read.
 */
export async function creditsAreCapped(projectId: string): Promise<boolean> {
  const account = await creditAccountOf(projectId)
  if (!account) return false
  return (await aiCreditCap(account).catch(() => null)) !== null
}

/**
 * Charge a turn, but never past the account's cap: at most the credits left
 * once the total charged and what other turns' calls have used (and are not
 * yet charged for) are counted. Read under the account's lock; the charge is
 * Cloud's own write, made after, outside any transaction.
 *
 * Two turns closing at once cannot both charge the same last credits. A turn's
 * charge is never more than what its own holds count (its calls' usage, or a
 * price it held whole), and those keep counting until it is charged, so the
 * other turn reads them in place of a charge that has not landed yet.
 *
 * Calls still in flight are not counted against the turn being charged: a
 * worst case is far more than a call uses, and counting it would charge this
 * turn less than it used while the account still had credits for it.
 *
 * Where nothing is enforced (no cap) the whole charge is made. So it is when
 * the cap cannot be read, as no hold is taken then either.
 */
async function chargeWithinCap(account: string, scope: TokenScope, tokens: number): Promise<void> {
  const cap = await aiCreditCap(account).catch((err) => {
    console.error('[AiCredits] the credit cap could not be read, so the turn is charged in full:', err instanceof Error ? err.message : err)
    return null
  })
  let charge = tokens
  if (cap !== null) {
    const month = thisMonth()
    const room = await prisma.$transaction(async (tx) => {
      await lockCredits(tx, account, month)
      const { charged, used } = await creditsInUse(tx, account, month, scope.holds)
      return Math.max(0, cap * TOKENS_PER_CREDIT - charged - used)
    })
    charge = Math.min(tokens, room)
    if (charge < tokens) {
      console.warn(
        `[AiCredits] A turn used ${tokens - charge} tokens past account ${account}'s ${cap}-credit cap. They were not charged.`,
      )
    }
  }
  if (charge > 0) await chargeAiCredits(account, charge)
}

/**
 * End a turn's credit accounting: charge `chargeTokens` to the account, never
 * past its cap, then stop counting the turn's settled holds. A turn charged
 * nothing releases them. Holds still in flight (a call outlived the turn, as on
 * a timeout) are left to settle and expire on their own, so they keep counting
 * meanwhile.
 *
 * Never throws: it runs after the turn's answer is decided.
 */
export async function closeCreditTurn(account: string | null, scope: TokenScope, chargeTokens: number): Promise<void> {
  const charging = account !== null && Number.isFinite(chargeTokens) && chargeTokens > 0
  if (charging) {
    try {
      await chargeWithinCap(account, scope, chargeTokens)
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
