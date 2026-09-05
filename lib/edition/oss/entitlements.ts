/**
 * The Cloud entitlements provider, as resolved WITHOUT the private overlay.
 *
 * `@cloud/entitlements` resolves here only when `lib/cloud/entitlements.ts` is
 * absent, which means no Cloud overlay has been applied. This is what a public
 * checkout gets, and there is no commercial implementation left in it to
 * delegate to: Backenly's billing left the repository in Phase 6.
 *
 * ── Why this is permissive rather than fail-closed ──────────────────────────
 *
 * A real Cloud deployment can never reach this file. It sets
 * BACKENLY_EDITION=cloud explicitly, and assertEditionCompositionOrExit in
 * lib/edition/cloud-extension.ts makes such a process REFUSE TO START when the
 * overlay is missing. That is where fail-closed lives: at startup, before a
 * single request is served.
 *
 * What reaches here is the unset-edition default, which is CI, local
 * development and any public checkout that never asked for cloud. Throwing
 * would break all three and buy nothing, because the case it would guard
 * against has already exited.
 *
 * So the answers below describe a deployment with no commercial half, and they
 * are the same answers the old code produced against an unseeded database: no
 * subscription, no bonus, nothing to record, nothing to initialize.
 */
import type { UserEntitlements } from '@/lib/entitlements/types'

/**
 * `null` means "no active subscription", which every caller already treats as a
 * block. It does not mean unlimited, and it does not mean the lookup failed.
 *
 * Single-tenant never gets here: lib/entitlements answers from the edition
 * before the provider is consulted, which is what lets a self-host install run
 * with no Plan and no Subscription row at all.
 */
export async function cloudEntitlements(_userId: string): Promise<UserEntitlements | null> {
  return null
}

/** No commercial ledger, so no granted credits. */
export async function bonusCredits(_userId: string): Promise<number> {
  return 0
}

/** Nothing to charge. */
export async function recordAiConsumption(_userId: string, _tokensUsed: number): Promise<void> {
  // no-op
}

/**
 * Nothing to initialize.
 *
 * Creating a Subscription row here would be worse than doing nothing. It would
 * reintroduce the Plan seed requirement that a public checkout deliberately
 * does without, and manufacture a commercial record on a deployment that has no
 * commercial half.
 */
export async function initializeAccountEntitlements(_userId: string): Promise<void> {
  // no-op
}
