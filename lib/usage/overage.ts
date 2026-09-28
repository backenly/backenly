/**
 * How far past its quotas an account may go, and what that is estimated to cost.
 *
 * The rule, per axis: usage may exceed the included quota only while the
 * account's overage mode is `enforce`, its plan allows overage, the axis can be
 * charged at all (catalog axisBillable: egress only once its billing is
 * switched on), and the month's estimated overage across ALL axes is still
 * below the owner's spend limit.
 * The remaining budget is what the next unit on any axis may spend, so the cap
 * on each axis is
 *
 *     max(used, included) + floor(remaining budget / unit price)
 *
 * and once the estimate reaches the limit, every axis is back to a hard cap.
 * With the default limit of $0 (or any mode but enforce) nothing changes: the
 * cap is the included quota, exactly as before overage existed.
 *
 * The estimate prices counters at their month-to-date total and storage at its
 * current size as if held all month. That overstates a storage bill (the close
 * bills the month's average), which is the safe direction for a limit the owner
 * set: Backenly stops early rather than charging past it.
 *
 * Whether overage exists at all is commercial (getOveragePolicy); everything
 * here is public policy and runs identically whoever answers it.
 */
import { getOveragePolicy, getUserEntitlements, type OveragePolicy, type UserEntitlements } from '@/lib/entitlements'
import {
  OVERAGE_AXES,
  axisBillable,
  egressBillable,
  egressTerms,
  overageCents,
  planAllowsOverage,
  unitsForCents,
  type EgressTerms,
  type OverageAxis,
} from '@/lib/pricing/catalog'
import { accountUsage, type AccountUsage } from './pool'

const MB = 1024 * 1024

export interface AxisLimit {
  axis: OverageAxis
  used: number
  /** The plan's included quantity in the axis's unit; null = unlimited. */
  included: number | null
  /** Units past max(used, included) the remaining spend limit still buys. */
  headroom: number
  /** The most this axis may reach this month; null = unlimited. */
  cap: number | null
  /** Units past the included quantity so far. */
  overUnits: number
  /**
   * Usage past the quota can be charged on this axis (catalog axisBillable).
   * False for egress until egress billing is switched on: then it has no
   * estimate and no headroom, whatever the spend limit.
   */
  billable: boolean
  /** Estimated cents for those units (fractional); 0 when not billable. */
  estimatedCents: number
}

export interface AccountLimits {
  billingAccountId: string
  period: string
  planName: string
  policy: OveragePolicy | null
  /** Usage may pass the included quota right now (enforce, allowed, limit > 0). */
  overageActive: boolean
  /** The spend limit in force, 0 when overage is not active. */
  spendLimitCents: number
  /** Month-to-date estimated overage across axes, before any limit cap. */
  estimatedCents: number
  terms: EgressTerms
  axes: Record<OverageAxis, AxisLimit>
}

/** An axis's included quantity in its own unit (users, runs, bytes), or null. */
export function includedQuantity(axis: OverageAxis, ent: UserEntitlements): number | null {
  const mb = (v: number | null) => (v === null || v === undefined ? null : v * MB)
  switch (axis) {
    case 'mau':
      return ent.maxMonthlyActiveUsers ?? null
    case 'fn_runs':
      return ent.maxAiFunctionInvocationsPerMonth ?? null
    case 'db_bytes':
      return mb(ent.maxPostgresStorageMb)
    case 'file_bytes':
      return mb(ent.maxFileStorageMb)
    case 'egress_bytes':
      return mb(ent.includedEgressMb)
  }
}

export function usedQuantity(axis: OverageAxis, usage: AccountUsage): number {
  switch (axis) {
    case 'mau':
      return usage.mau
    case 'fn_runs':
      return usage.fnRuns
    case 'db_bytes':
      return Number(usage.dbBytes)
    case 'file_bytes':
      return Number(usage.fileBytes)
    case 'egress_bytes':
      return Number(usage.egressBytes)
  }
}

/** Pure: the limits that follow from entitlements, usage and policy. */
export function computeAccountLimits(
  ent: UserEntitlements,
  usage: AccountUsage,
  policy: OveragePolicy | null,
  terms: EgressTerms = egressTerms(),
  egressCharged: boolean = egressBillable(),
): AccountLimits {
  const rows = OVERAGE_AXES.map((axis) => {
    const used = usedQuantity(axis, usage)
    const included = includedQuantity(axis, ent)
    const overUnits = included === null ? 0 : Math.max(0, used - included)
    const billable = axisBillable(ent.planName, axis, egressCharged)
    const estimatedCents = billable ? overageCents(axis, overUnits, terms) : 0
    return { axis, used, included, overUnits, billable, estimatedCents }
  })
  const estimatedCents = rows.reduce((sum, r) => sum + r.estimatedCents, 0)

  const overageActive =
    planAllowsOverage(ent.planName) && policy !== null && policy.mode === 'enforce' && policy.spendLimitCents > 0
  const spendLimitCents = overageActive ? policy!.spendLimitCents : 0
  const remaining = Math.max(0, spendLimitCents - estimatedCents)

  const axes = {} as Record<OverageAxis, AxisLimit>
  for (const r of rows) {
    // An axis that cannot be charged (egress until its billing is switched on)
    // keeps its hard cap even while the spend limit opens the others.
    const headroom =
      overageActive && r.billable && r.included !== null ? unitsForCents(r.axis, remaining, terms) : 0
    // Past the quota, the units already used are inside the estimate, so the
    // cap exceeds current usage only by what the remaining budget buys.
    const cap = r.included === null ? null : Math.max(r.used, r.included) + headroom
    axes[r.axis] = { ...r, headroom, cap }
  }

  return {
    billingAccountId: usage.billingAccountId,
    period: usage.period,
    planName: ent.planName,
    policy,
    overageActive,
    spendLimitCents,
    estimatedCents,
    terms,
    axes,
  }
}

// ─── Cached reads for the gates ──────────────────────────────────────────────
//
// The gates run on requests, so the account-wide reading is cached briefly per
// process. The cost is the overshoot the spend-limit copy already states: a
// limit is checked every few minutes, not on every byte.

const CACHE_MS = 30_000
const cache = new Map<string, { at: number; limits: AccountLimits | null }>()

export async function accountLimits(
  billingAccountId: string,
  opts: { fresh?: boolean; ent?: UserEntitlements | null } = {},
): Promise<AccountLimits | null> {
  const hit = cache.get(billingAccountId)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.limits

  const ent = opts.ent === undefined ? await getUserEntitlements(billingAccountId) : opts.ent
  let limits: AccountLimits | null = null
  if (ent) {
    // A plan with no finite quota (self-host, a contract plan) has nothing to
    // compare usage against, so it is not read at all.
    const metered = OVERAGE_AXES.some((axis) => includedQuantity(axis, ent) !== null)
    const usage = metered ? await accountUsage(billingAccountId) : unmeteredUsage(billingAccountId)
    const policy = await getOveragePolicy(billingAccountId)
    limits = computeAccountLimits(ent, usage, policy)
  }
  if (cache.size > 10_000) cache.clear()
  cache.set(billingAccountId, { at: Date.now(), limits })
  return limits
}

/**
 * The cap a gate compares its own fresh reading against: the included quota,
 * raised only when the account's spend limit allows overage.
 *
 * A gate calls this only once its reading has reached the included quota, so
 * the common case costs nothing. Any failure answers the included quota: the
 * behaviour before overage existed, never a silent grant.
 */
export async function effectiveCap(
  billingAccountId: string,
  axis: OverageAxis,
  included: number,
  ent?: UserEntitlements | null,
): Promise<number> {
  try {
    const limits = await accountLimits(billingAccountId, { ent })
    if (!limits?.overageActive) return included
    return limits.axes[axis].cap ?? included
  } catch {
    return included
  }
}

function unmeteredUsage(billingAccountId: string): AccountUsage {
  const zero = BigInt(0)
  return {
    billingAccountId,
    period: new Date().toISOString().slice(0, 7),
    mau: 0,
    fnRuns: 0,
    egressBytes: zero,
    dbBytes: zero,
    fileBytes: zero,
  }
}

/** Forget cached limits (after the owner changes the spend limit, and in tests). */
export function invalidateAccountLimits(billingAccountId?: string): void {
  if (billingAccountId) cache.delete(billingAccountId)
  else cache.clear()
}
