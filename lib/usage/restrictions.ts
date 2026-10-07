/**
 * Limit behaviours that begin with a grace period.
 *
 * Two quotas are not refused the moment they are reached, because refusing
 * would break a live app for something the owner can fix at leisure:
 *
 *   database  at the cap, schema changes and bulk writes pause at once
 *             (lib/quota/kernel.ts enforceDbStorage). After GRACE_DAYS still
 *             over, the project's data API refuses writes that add or change
 *             rows (POST, PUT, PATCH). Reads and DELETE keep working, so the
 *             owner can always get back under, and no data is ever deleted.
 *   egress    nothing is cut during the grace period. After GRACE_DAYS still
 *             over, files stop being served to end users and the public (the
 *             project's own members and export links still work). API
 *             responses are never cut.
 *
 * "Over" is the account's pooled usage at or past its effective cap (the
 * included quota, raised only by the owner's spend limit), as the usage-alert
 * sweep last saw it (usage_limit_states, lib/usage/alerts.ts). The sweep
 * clears the state as soon as usage is back under, so the restriction lifts
 * within minutes of the owner deleting data, raising the limit or a new month
 * resetting egress.
 *
 * Fail open: a lookup error is never a restriction. A billing fault must not
 * take down a customer's API.
 */
import { prisma } from '@/lib/db/prisma'
import { billingAccountOf } from '@/lib/usage/account'

export const GRACE_DAYS = 7
const DAY_MS = 86_400_000

export type RestrictedAxis = 'db_bytes' | 'egress_bytes'

export interface Restriction {
  restricted: boolean
  overSince: Date | null
  /** When the grace period ends (or ended); null when not over. */
  graceEndsAt: Date | null
}

const NONE: Restriction = { restricted: false, overSince: null, graceEndsAt: null }
const CACHE_MS = 60_000
const cache = new Map<string, { at: number; value: Restriction }>()

/** Whether an account is past its grace period on an axis. */
export async function accountRestriction(
  billingAccountId: string,
  axis: RestrictedAxis,
  now: Date = new Date(),
): Promise<Restriction> {
  const key = `${billingAccountId}:${axis}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return evaluate(hit.value.overSince, now)
  try {
    const row = await prisma.usageLimitState.findUnique({
      where: { billingAccountId_axis: { billingAccountId, axis } },
      select: { overSince: true },
    })
    const value = evaluate(row?.overSince ?? null, now)
    if (cache.size > 10_000) cache.clear()
    cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    return NONE
  }
}

function evaluate(overSince: Date | null, now: Date): Restriction {
  if (!overSince) return NONE
  const graceEndsAt = new Date(overSince.getTime() + GRACE_DAYS * DAY_MS)
  return { restricted: now >= graceEndsAt, overSince, graceEndsAt }
}

/** The restriction on the account that owns a project. */
export async function projectRestriction(projectId: string, axis: RestrictedAxis, now: Date = new Date()): Promise<Restriction> {
  try {
    const account = await billingAccountOf(projectId)
    if (!account) return NONE
    return await accountRestriction(account, axis, now)
  } catch {
    return NONE
  }
}

/** Methods that add or change rows. DELETE is never restricted: it is how an owner gets back under. */
export function isGrowingWrite(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH'
}

export const RESTRICTED_CODE = 'PLAN_LIMIT_EXCEEDED'

export function restrictionMessage(axis: RestrictedAxis, r: Restriction): string {
  const since = r.overSince ? r.overSince.toISOString().slice(0, 10) : 'recently'
  return axis === 'db_bytes'
    ? `The account this project bills to has been over its database storage limit since ${since}, past the ${GRACE_DAYS}-day grace period, so the data API is read-only. Reads and deletes still work. It becomes writable again once usage is back under the limit or the limit is raised.`
    : `The account this project bills to has been over its egress limit since ${since}, past the ${GRACE_DAYS}-day grace period, so files are not being served. Downloads resume when the limit is raised or the month resets.`
}

export function restrictionDetails(axis: RestrictedAxis, r: Restriction): Record<string, unknown> {
  return {
    limit: axis === 'db_bytes' ? 'database_storage' : 'egress',
    overSince: r.overSince?.toISOString() ?? null,
    graceEndedAt: r.graceEndsAt?.toISOString() ?? null,
  }
}

/** Forget cached restrictions (tests, and after the owner raises a limit). */
export function invalidateRestrictions(): void {
  cache.clear()
}
