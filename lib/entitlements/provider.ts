/**
 * The Cloud side of the Entitlements seam.
 *
 * Four operations, each one a thing the public product genuinely needs from
 * Backenly's commercial implementation and cannot answer for itself. The list
 * is deliberately short and deliberately concrete: this is a seam for the calls
 * that actually exist, not a plugin framework.
 *
 *   cloudEntitlements            what may this account do?
 *   bonusCredits                 granted credits that extend the monthly cap
 *   recordAiConsumption          charge a completed turn to the usage ledger
 *   initializeAccountEntitlements  set a new account up to have entitlements
 *
 * The split follows one rule: deciding whether something MAY happen is public
 * policy, and recording commercial consumption is Cloud's. So enforceAiCredits
 * lives in the public policy layer and asks this provider only for the two
 * commercial facts it cannot derive.
 *
 * Every implementation must be safe to call in single-tenant, where the honest
 * answers are "no bonus", "nothing to record" and "nothing to initialize".
 */
import type { UserEntitlements } from './types'

export interface CloudEntitlementsProvider {
  /** `null` means no active subscription. It does not mean unlimited. */
  cloudEntitlements(userId: string): Promise<UserEntitlements | null>

  /**
   * Granted credits (referral or promo) that extend the monthly cap.
   * Zero in single-tenant, where the cap is already unlimited.
   */
  bonusCredits(userId: string): Promise<number>

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
}
