/**
 * One read-only description of an account's usage this month: what it used,
 * what the plan includes, the most it may reach, the projection to month end,
 * what past-the-plan usage is estimated to cost, and any grace or restriction
 * in force. Pooled across the account's projects, like the quotas themselves.
 *
 * The usage page and the MCP `get_usage` read (read_backend_state
 * section "usage") both render this, so a person and an agent see the same
 * numbers. It has no write counterpart anywhere: the spend limit is raised only
 * from the owner's mailbox (Cloud), never by an agent.
 *
 * JSON-safe throughout (numbers and strings, no BigInt).
 */
import { getOveragePolicy } from '@/lib/entitlements'
import { OVERAGE_AXES, overageCents, planAllowsOverage, type OverageAxis } from '@/lib/pricing/catalog'
import { accountLimits } from './overage'
import { forecastAccount } from './forecast'
import { accountRestriction, GRACE_DAYS, type RestrictedAxis } from './restrictions'

const LABEL: Record<OverageAxis, string> = {
  mau: 'Monthly active users',
  fn_runs: 'Function runs',
  egress_bytes: 'Egress',
  db_bytes: 'Database storage',
  file_bytes: 'File storage',
}

const UNIT: Record<OverageAxis, 'users' | 'runs' | 'bytes'> = {
  mau: 'users',
  fn_runs: 'runs',
  egress_bytes: 'bytes',
  db_bytes: 'bytes',
  file_bytes: 'bytes',
}

export interface AxisDescription {
  axis: OverageAxis
  label: string
  unit: 'users' | 'runs' | 'bytes'
  /** The enforcement reading: counters this month, storage as stored now. */
  used: number
  /** Included in the plan; null = unlimited. */
  included: number | null
  /** The most this axis may reach this month (spend limit included); null = unlimited. */
  cap: number | null
  /** Projected month-end quantity (storage: the month's average). */
  projected: number
  /** Estimated cost of usage past the plan so far, in cents. */
  estimatedCents: number
  /** Estimated cost at the projected month-end quantity, in cents. */
  projectedCents: number
  /** Database and egress only: the grace period after the cap is reached. */
  grace: { overSince: string; graceEndsAt: string; restricted: boolean } | null
}

export interface AccountUsageDescription {
  period: string
  planName: string
  overage: {
    /** off | shadow | enforce, or null where usage can never be charged. */
    mode: 'off' | 'shadow' | 'enforce' | null
    spendLimitCents: number
    /** Usage may pass the plan right now. */
    active: boolean
    estimatedCents: number
    projectedCents: number
  }
  graceDays: number
  axes: AxisDescription[]
}

export async function describeAccountUsage(
  billingAccountId: string,
  now: Date = new Date(),
): Promise<AccountUsageDescription | null> {
  const limits = await accountLimits(billingAccountId, { fresh: true })
  if (!limits) return null
  const [forecast, policy] = await Promise.all([
    forecastAccount(billingAccountId, now),
    getOveragePolicy(billingAccountId),
  ])
  const billable = planAllowsOverage(limits.planName)

  const axes: AxisDescription[] = []
  for (const axis of OVERAGE_AXES) {
    const a = limits.axes[axis]
    const projected = Math.max(forecast[axis].projected, axis === 'db_bytes' || axis === 'file_bytes' ? 0 : a.used)
    const projectedOver = a.included === null ? 0 : Math.max(0, projected - a.included)
    let grace: AxisDescription['grace'] = null
    if (axis === 'db_bytes' || axis === 'egress_bytes') {
      const r = await accountRestriction(billingAccountId, axis as RestrictedAxis, now)
      if (r.overSince && r.graceEndsAt) {
        grace = { overSince: r.overSince.toISOString(), graceEndsAt: r.graceEndsAt.toISOString(), restricted: r.restricted }
      }
    }
    axes.push({
      axis,
      label: LABEL[axis],
      unit: UNIT[axis],
      used: a.used,
      included: a.included,
      cap: a.cap,
      projected,
      estimatedCents: Math.floor(a.estimatedCents),
      projectedCents: billable ? Math.floor(overageCents(axis, projectedOver, limits.terms)) : 0,
      grace,
    })
  }

  const projectedCents = axes.reduce((s, a) => s + a.projectedCents, 0)
  return {
    period: limits.period,
    planName: limits.planName,
    overage: {
      mode: policy?.mode ?? null,
      spendLimitCents: policy?.spendLimitCents ?? 0,
      active: limits.overageActive,
      estimatedCents: Math.floor(limits.estimatedCents),
      projectedCents,
    },
    graceDays: GRACE_DAYS,
    axes,
  }
}
