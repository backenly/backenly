/**
 * The Cloud side of the Entitlements seam.
 *
 * Six operations, each one a thing the public product genuinely needs from
 * Backenly's commercial implementation and cannot answer for itself. The list
 * is deliberately short and deliberately concrete: this is a seam for the calls
 * that actually exist, not a plugin framework.
 *
 *   cloudEntitlements            what may this account do?
 *   bonusCredits                 granted credits that extend the monthly cap
 *   purchasedCredits             bought credits, spent after plan + bonus
 *   recordAiConsumption          charge a completed turn to the usage ledger
 *   initializeAccountEntitlements  set a new account up to have entitlements
 *   overagePolicy                may this account go past its quotas, and how far
 *
 * The split follows one rule: deciding whether something MAY happen is public
 * policy, and recording commercial consumption is Cloud's. So enforceAiCredits
 * lives in the public policy layer and asks this provider only for the
 * commercial facts it cannot derive (the plan, and the bonus and purchased
 * balances).
 *
 * Every implementation must be safe to call in single-tenant, where the honest
 * answers are "no bonus", "nothing bought", "nothing to record" and "nothing to
 * initialize".
 */
import type { OveragePolicy, UserEntitlements } from './types'

export interface CloudEntitlementsProvider {
  /** `null` means no active subscription. It does not mean unlimited. */
  cloudEntitlements(userId: string): Promise<UserEntitlements | null>

  /**
   * Granted credits (referral or promo) that extend the monthly cap.
   * Zero in single-tenant, where the cap is already unlimited.
   */
  bonusCredits(userId: string): Promise<number>

  /**
   * Credits the account bought outright. They extend the cap like bonus
   * credits, but month rollover never expires them: only usage beyond plan +
   * bonus spends them. Zero wherever nothing is sold.
   */
  purchasedCredits(userId: string): Promise<number>

  /**
   * Record a completed AI turn's token usage.
   *
   * This mutates a commercial ledger, so the implementation is Cloud's. Public
   * code calls it, but only after the public policy layer has already decided
   * the turn was allowed. Never throws and never blocks the caller.
   */
  recordAiConsumption(userId: string, tokensUsed: number): Promise<void>

  /**
   * Give a newly created account whatever it needs to have entitlements.
   *
   * In Cloud that is a free Subscription row. In single-tenant it is nothing at
   * all: entitlements come from the edition, and creating a Subscription row
   * would reintroduce the seed requirement that self-host exists without.
   */
  initializeAccountEntitlements(userId: string): Promise<void>

  /**
   * The account's overage mode and spend limit, or `null` when usage past a
   * quota can never be charged (every quota is then a hard cap).
   *
   * Only the two commercial facts. What they allow, per axis, is public policy
   * (lib/usage/overage.ts), so the same arithmetic runs whoever answers here.
   */
  overagePolicy(billingAccountId: string): Promise<OveragePolicy | null>
}
