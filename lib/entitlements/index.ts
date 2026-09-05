/**
 * The one place the product asks what a user is allowed to do.
 *
 * Public product code imports this module. It must never import
 * `@/lib/billing`, which is Backenly's commercial implementation and moves to
 * the private Cloud overlay. The edition decides which provider answers:
 *
 *   single-tenant  ->  selfHostedEntitlements(), no database read at all
 *   cloud          ->  @cloud/entitlements, the billing-backed resolver
 *
 * `@cloud/*` resolves overlay-first (see the `paths` entry in tsconfig.json):
 * the private implementation when the Cloud overlay has been applied, and the
 * public fallback when it has not. That is a BUILD-time decision, because the
 * overlay is composed into the source tree before anything is compiled, which
 * is what makes one alias work identically under tsc, next build, tsx and jest.
 */
import { currentEdition } from '@/lib/edition'
import { cloudEntitlements } from '@cloud/entitlements'
import { selfHostedEntitlements } from './self-hosted'
import type { UserEntitlements } from './types'

export type { UserEntitlements, CloudEntitlementsProvider } from './types'
export { selfHostedEntitlements } from './self-hosted'

/**
 * Resolve a user's entitlements, or `null` when they have none.
 *
 * `null` is a Cloud-only outcome and means "no active subscription". Callers
 * already treat it as a block, so it must not be used to signal an
 * infrastructure failure. Single-tenant never returns it.
 *
 * The edition is read per call rather than captured at module load, so a test
 * that changes it does not end up holding a stale provider.
 */
export async function getUserEntitlements(userId: string): Promise<UserEntitlements | null> {
  if (currentEdition() === 'single-tenant') return selfHostedEntitlements()
  return cloudEntitlements(userId)
}
