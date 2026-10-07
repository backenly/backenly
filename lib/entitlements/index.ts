/**
 * The one place the product asks what a billing account is allowed to do.
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
 *
 * ---- WHO HAS A PLAN -----------------------------------------------------
 *
 * A billing account, not a person (lib/usage/account.ts). On Backenly Cloud
 * that is an organization, so a Free teammate working in a Pro organization
 * works on the organization's Pro plan, and their own plan never comes into
 * it. Ask with the account the work belongs to: the project's, for anything
 * done in a project.
 */
import { currentEdition } from '@/lib/edition'
import {
  accountForCaller as cloudAccountForCaller,
  accountOfUser as cloudAccountOfUser,
  accountOwner as cloudAccountOwner,
  cloudEntitlements,
  initializeAccountEntitlements as cloudInitialize,
  overagePolicy as cloudOveragePolicy,
} from '@cloud/entitlements'
import { selfHostedEntitlements } from './self-hosted'
import type { OveragePolicy, UserEntitlements } from './types'

export type { UserEntitlements, CloudEntitlementsProvider, OveragePolicy } from './types'
export { selfHostedEntitlements } from './self-hosted'

/**
 * A billing account's entitlements, or `null` when it has none.
 *
 * `null` is a Cloud-only outcome and means "no active subscription". Callers
 * already treat it as a block, so it must not be used to signal an
 * infrastructure failure. Single-tenant never returns it.
 *
 * The edition is read per call rather than captured at module load, so a test
 * that changes it does not end up holding a stale provider.
 */
export async function getAccountEntitlements(billingAccountId: string): Promise<UserEntitlements | null> {
  if (currentEdition() === 'single-tenant') return selfHostedEntitlements()
  return cloudEntitlements(billingAccountId)
}

/**
 * The entitlements of a person's OWN billing account: their own organization
 * on Cloud. For the few questions that are genuinely about the person rather
 * than about work in a project or an organization; anything done in a project
 * asks getAccountEntitlements with the project's account instead.
 */
export async function getUserEntitlements(userId: string): Promise<UserEntitlements | null> {
  if (currentEdition() === 'single-tenant') return selfHostedEntitlements()
  return cloudEntitlements(await cloudAccountOfUser(userId))
}

/** A person's own billing account: their own organization on Cloud, themselves elsewhere. */
export async function accountOfUser(userId: string): Promise<string> {
  if (currentEdition() === 'single-tenant') return userId
  return cloudAccountOfUser(userId)
}

/**
 * The billing account a caller is asking about, for account-level reads (the
 * Usage page, the spend limit): the one they name, if they may read it (on
 * Cloud, an organization they belong to), otherwise their own. Null when they
 * named an account they may not read, which callers answer as not found.
 */
export async function accountForCaller(userId: string, requested?: string | null): Promise<string | null> {
  if (currentEdition() === 'single-tenant') return !requested || requested === userId ? userId : null
  return cloudAccountForCaller(userId, requested ?? null)
}

/**
 * The person an account's notices go to (credits running low, a quota
 * reached): an organization's owner on Cloud, the account itself elsewhere.
 * Null when the account no longer exists.
 */
export async function accountOwner(billingAccountId: string): Promise<string | null> {
  if (currentEdition() === 'single-tenant') return billingAccountId
  return cloudAccountOwner(billingAccountId)
}

/**
 * Give a newly created account whatever it needs to have entitlements.
 *
 * Cloud creates a free Subscription row. Single-tenant does nothing at all,
 * and that is the point rather than an omission: entitlements there come from
 * the edition, and creating a Subscription row would drag back the Plan seed
 * requirement that a self-host install deliberately does without.
 *
 * Signup calls this and does not know which happened.
 */
export async function initializeAccountEntitlements(userId: string): Promise<void> {
  if (currentEdition() === 'single-tenant') return
  await cloudInitialize(userId)
}

/**
 * Whether an account may go past its quotas, and within what spend limit.
 *
 * `null` means never: every quota is a hard cap. Single-tenant answers `null`
 * without a database read; its quotas are unlimited anyway.
 */
export async function getOveragePolicy(billingAccountId: string): Promise<OveragePolicy | null> {
  if (currentEdition() === 'single-tenant') return null
  return cloudOveragePolicy(billingAccountId)
}
