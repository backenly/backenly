/**
 * Usage alerts: each threshold an account crosses, recorded and sent once.
 *
 * Levels, per axis with an included quota: 50%, 80% and 100% of it. When the
 * spend limit allows overage, the same three levels of the spend limit (axis
 * "spend") and "cap" when an axis reaches the most the limit allows.
 *
 * Exactly once: a crossed level is inserted into usage_alerts with ON CONFLICT
 * DO NOTHING, and only a row this call inserted sends anything. Many processes
 * evaluating the same account, a restart, or a re-run of the sweep cannot send
 * a second copy. When several levels are crossed at once (a big upload goes
 * from 40% to 120%), they are all recorded and one message names the highest.
 *
 * The sweep also keeps usage_limit_states: since when an account has been at
 * or over its cap on the axes whose limit behaviour starts with a grace period.
 *
 * Alerts replace the in-process 80% warning the quota kernel used to send,
 * which was typed `credits_low`: its email said "AI credits running low" whatever
 * the limit was, showed the limit as "-", and one warning of any kind that
 * month suppressed the real AI-credit warning.
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createPlatformNotification } from '@/lib/notifications/platform'
import { OVERAGE_AXES, overagePrice, type OverageAxis } from '@/lib/pricing/catalog'
import { accountLimits, type AccountLimits } from './overage'
import { GRACE_DAYS } from './restrictions'

export const INCLUDED_LEVELS = [50, 80, 100] as const
export const SPEND_LEVELS = [50, 80, 100] as const

/** Axes whose limit behaviour starts with a grace period rather than a refusal. */
export const GRACE_AXES: readonly OverageAxis[] = ['db_bytes', 'egress_bytes']

const RESOURCE: Record<OverageAxis | 'spend', string> = {
  mau: 'monthly active users',
  db_bytes: 'database storage',
  file_bytes: 'file storage',
  fn_runs: 'function runs',
  egress_bytes: 'egress',
  spend: 'spend limit',
}

function formatQuantity(axis: OverageAxis | 'spend', n: number): string {
  if (axis === 'spend') return `$${(n / 100).toFixed(2)}`
  if (axis === 'db_bytes' || axis === 'file_bytes' || axis === 'egress_bytes') {
    const gib = n / (1024 * 1024 * 1024)
    return gib >= 10 ? `${gib.toFixed(0)} GB` : `${gib.toFixed(2)} GB`
  }
  return Math.round(n).toLocaleString('en-US')
}

/** What happens at 100% of an axis when nothing past the quota is allowed. */
function atQuotaBehaviour(axis: OverageAxis): string {
  switch (axis) {
    case 'mau':
      return 'New end users cannot sign up until the 1st; existing users keep working.'
    case 'db_bytes':
      return `Schema changes and bulk writes that grow the database are paused. If usage is still over in ${GRACE_DAYS} days, the data API becomes read-only (reads and deletes keep working) until it is back under.`
    case 'file_bytes':
      return 'New uploads are refused; existing files stay available.'
    case 'fn_runs':
      return 'Function invocations are refused until the 1st.'
    case 'egress_bytes':
      return `Nothing is cut off yet. If usage is still over in ${GRACE_DAYS} days, files stop being served to end users until the month resets or the limit is raised. API responses are never cut.`
  }
}

async function recordLevels(
  billingAccountId: string,
  period: string,
  axis: string,
  levels: string[],
  observed: number,
  limit: number,
): Promise<string[]> {
  const inserted: string[] = []
  for (const level of levels) {
    const rows = await prisma.$queryRaw<Array<{ level: string }>>`
      INSERT INTO "usage_alerts" ("id", "billingAccountId", "period", "axis", "level", "observed", "limit", "createdAt")
      VALUES (${randomUUID()}, ${billingAccountId}, ${period}, ${axis}, ${level},
              ${BigInt(Math.round(observed))}, ${BigInt(Math.round(limit))}, (now() AT TIME ZONE 'UTC'))
      ON CONFLICT ("billingAccountId", "period", "axis", "level") DO NOTHING
      RETURNING "level"`
    if (rows.length) inserted.push(rows[0].level)
  }
  return inserted
}

async function notify(
  billingAccountId: string,
  limits: AccountLimits,
  axis: OverageAxis | 'spend',
  level: string,
  used: number,
  limit: number,
): Promise<void> {
  const resource = RESOURCE[axis]
  const usedLabel = formatQuantity(axis, used)
  const limitLabel = formatQuantity(axis, limit)
  let title: string
  let body: string

  if (axis === 'spend') {
    title = `You've reached ${level}% of your ${resource}`
    body =
      level === '100'
        ? `Estimated usage beyond your plan this month is ${usedLabel}, your full ${limitLabel} spend limit. Every quota is a hard cap again until the 1st, unless you raise the limit.`
        : `Estimated usage beyond your plan this month is ${usedLabel} of your ${limitLabel} spend limit.`
  } else if (level === 'cap') {
    title = `Your ${resource} reached what your spend limit allows`
    body = `You've used ${usedLabel} of ${resource} this month, the most your spend limit allows. ${atQuotaBehaviour(axis)} Raise the spend limit to continue.`
  } else if (level === '100') {
    const price = overagePrice(axis, limits.terms)
    title = `You've used all of your included ${resource}`
    body = limits.overageActive && limits.axes[axis].billable
      ? `You've used ${usedLabel} of the ${limitLabel} included this month. Usage past it is billed at $${(price.cents / 100).toFixed(price.cents < 1 ? 4 : 2)} ${price.label}, within your $${(limits.spendLimitCents / 100).toFixed(0)} spend limit.`
      : `You've used ${usedLabel} of the ${limitLabel} included this month. ${atQuotaBehaviour(axis)}`
  } else {
    title = `You've used ${level}% of your included ${resource}`
    body = `You've used ${usedLabel} of the ${limitLabel} included this month (${limits.period}).`
  }

  await createPlatformNotification({
    userId: billingAccountId,
    type: 'usage_limit',
    title,
    body,
    metadata: { axis, level, used, limit, usedLabel, limitLabel, period: limits.period },
  })
}

function highest(levels: string[]): string {
  if (levels.includes('cap')) return 'cap'
  return levels.map(Number).sort((a, b) => b - a)[0].toString()
}

export interface AlertEvaluation {
  recorded: number
  sent: number
}

/** Evaluate one account now: record crossed levels, send new ones, keep grace state. */
export async function evaluateAccountAlerts(billingAccountId: string, now: Date = new Date()): Promise<AlertEvaluation> {
  const limits = await accountLimits(billingAccountId, { fresh: true })
  const result: AlertEvaluation = { recorded: 0, sent: 0 }
  if (!limits) return result

  for (const axis of OVERAGE_AXES) {
    const a = limits.axes[axis]
    if (a.included === null || a.included <= 0) continue

    const pct = (a.used / a.included) * 100
    const levels: string[] = INCLUDED_LEVELS.filter((l) => pct >= l).map(String)
    // "The most your spend limit allows" only means something on an axis the
    // limit can buy: an axis that cannot be charged stops at its quota, which
    // the 100% level already reports.
    if (limits.overageActive && a.billable && a.cap !== null && a.cap > a.included && a.used >= a.cap) levels.push('cap')
    if (levels.length) {
      const inserted = await recordLevels(billingAccountId, limits.period, axis, levels, a.used, a.included)
      result.recorded += inserted.length
      if (inserted.length) {
        const top = highest(inserted)
        await notify(billingAccountId, limits, axis, top, a.used, top === 'cap' ? a.cap! : a.included)
        result.sent++
      }
    }

    if (GRACE_AXES.includes(axis) && a.cap !== null) {
      await setOverState(billingAccountId, axis, a.used >= a.cap, now)
    }
  }

  if (limits.overageActive && limits.spendLimitCents > 0) {
    const pct = (limits.estimatedCents / limits.spendLimitCents) * 100
    const levels = SPEND_LEVELS.filter((l) => pct >= l).map(String)
    if (levels.length) {
      const inserted = await recordLevels(
        billingAccountId,
        limits.period,
        'spend',
        levels,
        limits.estimatedCents,
        limits.spendLimitCents,
      )
      result.recorded += inserted.length
      if (inserted.length) {
        await notify(billingAccountId, limits, 'spend', highest(inserted), limits.estimatedCents, limits.spendLimitCents)
        result.sent++
      }
    }
  }

  return result
}

async function setOverState(billingAccountId: string, axis: OverageAxis, over: boolean, now: Date): Promise<void> {
  if (over) {
    // Keep the earliest overSince of a continuous stretch. The columns are
    // timestamp without time zone holding UTC (Prisma's convention), so every
    // value is converted to UTC explicitly rather than by the session zone.
    await prisma.$executeRaw`
      INSERT INTO "usage_limit_states" ("billingAccountId", "axis", "overSince", "updatedAt")
      VALUES (${billingAccountId}, ${axis}, (${now}::timestamptz AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
      ON CONFLICT ("billingAccountId", "axis") DO UPDATE
        SET "overSince" = COALESCE("usage_limit_states"."overSince", EXCLUDED."overSince"),
            "updatedAt" = (now() AT TIME ZONE 'UTC')`
  } else {
    await prisma.$executeRaw`
      UPDATE "usage_limit_states" SET "overSince" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "billingAccountId" = ${billingAccountId} AND "axis" = ${axis} AND "overSince" IS NOT NULL`
  }
}

/**
 * The sweep: every account that owns a project. Runs every few minutes from
 * instrumentation.ts; one account's failure never stops the rest.
 */
export async function evaluateUsageAlerts(now: Date = new Date()): Promise<AlertEvaluation & { accounts: number; failed: number }> {
  // A self-hosted install has no quotas, so there is nothing to alert on.
  const { currentEdition } = await import('@/lib/edition')
  if (currentEdition() === 'single-tenant') return { accounts: 0, recorded: 0, sent: 0, failed: 0 }
  const owners = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT DISTINCT "userId" FROM "projects" WHERE "userId" IS NOT NULL`
  const total = { accounts: owners.length, recorded: 0, sent: 0, failed: 0 }
  for (const { userId } of owners) {
    try {
      const r = await evaluateAccountAlerts(userId, now)
      total.recorded += r.recorded
      total.sent += r.sent
    } catch (err: any) {
      total.failed++
      console.warn(`[usage-alerts] ${userId}: ${err?.message}`)
    }
  }
  return total
}

const WARNING_RESOURCE = {
  realtime_connections: 'concurrent realtime connections',
} as const

/**
 * The 80% warning for a quota that is never billed (realtime connections),
 * recorded once per account and period and sent once. `period` is YYYY-MM.
 */
export async function recordQuotaWarning(
  billingAccountId: string,
  axis: keyof typeof WARNING_RESOURCE,
  used: number,
  max: number,
  period: string,
): Promise<boolean> {
  if (max <= 0 || used / max < 0.8) return false
  const inserted = await recordLevels(billingAccountId, period, axis, ['80'], used, max)
  if (!inserted.length) return false
  const resource = WARNING_RESOURCE[axis]
  const pct = Math.min(100, Math.round((used / max) * 100))
  await createPlatformNotification({
    userId: billingAccountId,
    type: 'usage_limit',
    title: `You're at ${pct}% of your ${resource}`,
    body: `You've used ${Math.round(used).toLocaleString('en-US')} of the ${max.toLocaleString('en-US')} ${resource} this month (${period}), across all of your projects.`,
    metadata: {
      axis,
      level: '80',
      used,
      limit: max,
      usedLabel: Math.round(used).toLocaleString('en-US'),
      limitLabel: max.toLocaleString('en-US'),
      period,
    },
  })
  return true
}
