/**
 * The one place the product signals Backenly's business machinery.
 *
 * Public product code imports this module. It must never import lib/billing,
 * lib/trust, lib/platform/controls or lib/analytics/logger, all of which are
 * Backenly's own implementation and move to the private Cloud overlay.
 *
 * The edition decides who answers:
 *
 *   single-tenant  ->  nothing happens, and that is the correct behaviour
 *   cloud          ->  @cloud/platform-signals
 *
 * `@cloud/*` resolves overlay-first, so the private implementation answers when
 * the Cloud overlay has been applied and the public fallback answers when it
 * has not. Same build-time mechanism the entitlements seam uses.
 *
 * Why single-tenant short-circuits HERE rather than in a no-op provider: a
 * self-hosted install should not need the Cloud module to exist at all, not
 * even to call a stub. Returning before the provider is consulted is what makes
 * that true.
 */
import {
  onSignupCompleted as cloudOnSignupCompleted,
  runScheduledBackOfficeMaintenance as cloudRunBackOfficeMaintenance,
} from '@cloud/platform-signals'
import { currentEdition } from '@/lib/edition'
import type { SignupCompleted } from './types'

export type { SignupCompleted, PlatformSignalsProvider } from './types'

/**
 * Report a completed signup.
 *
 * Never throws and never rejects. Callers are in the signup path, the account
 * already exists, and no business reaction is worth failing a registration
 * that has already succeeded. Errors are swallowed here rather than at each of
 * the three call sites, so a new signup flow cannot forget to.
 */
export async function onSignupCompleted(event: SignupCompleted): Promise<void> {
  if (currentEdition() === 'single-tenant') return
  try {
    await cloudOnSignupCompleted(event)
  } catch {
    /* a business reaction cannot un-create the account */
  }
}

/**
 * Run Backenly's scheduled commercial maintenance, if there is any.
 *
 * The public scheduler in instrumentation.ts calls this on its daily tick. It
 * decides WHEN; what runs is the private half's business. In single-tenant
 * nothing runs, because a self-hosted install has no subscriptions to dun.
 *
 * Never throws. A failed maintenance pass must not take down the scheduler
 * that also runs autonomy, backups and workspace observation.
 */
export async function runScheduledBackOfficeMaintenance(): Promise<void> {
  if (currentEdition() === 'single-tenant') return
  try {
    await cloudRunBackOfficeMaintenance()
  } catch (err: any) {
    console.error('[BackOfficeMaintenance] Error:', err?.message)
  }
}
