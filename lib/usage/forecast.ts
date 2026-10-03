/**
 * Where an account's usage is heading by the end of the month.
 *
 * Read from the usage ledger (usage_daily), the record the month is billed
 * from, so the forecast and the eventual bill describe the same quantities:
 *
 *   counters (MAU, function runs, egress)
 *     month to date, plus the average of the last seven full days for every
 *     day left in the month. The trend window crosses into the previous month
 *     when this one is young, so the 2nd of the month is not a guess from one
 *     day.
 *   gauges (database, file storage)
 *     billed as the month's average of daily maxima, so the projection is that
 *     average with today's size held for the days left.
 *
 * A projection, and labelled as one wherever it is shown. MAU in particular
 * over-projects: returning users are first-seen once, so the daily count
 * falls through a month while this holds it level. That is the conservative
 * direction for a number an owner sets a spend limit against.
 */
import { prisma } from '@/lib/db/prisma'
import { OVERAGE_AXES, type OverageAxis } from '@/lib/pricing/catalog'
import { USAGE_AXES, periodBounds, utcDay, utcPeriod } from '@/lib/usage/axes'
import { egressSources } from '@/lib/usage/close'

const DAY_MS = 86_400_000
const TREND_DAYS = 7

export interface AxisForecast {
  axis: OverageAxis
  /** Counters: the total so far. Gauges: the average of daily maxima so far. */
  monthToDate: number
  /** The same quantity projected to the end of the month. */
  projected: number
}

export async function forecastAccount(
  billingAccountId: string,
  now: Date = new Date(),
): Promise<Record<OverageAxis, AxisForecast>> {
  const period = utcPeriod(now)
  const { start, end, days } = periodBounds(period)
  const today = utcDay(now)
  const trendStart = new Date(today.getTime() - TREND_DAYS * DAY_MS)
  const from = trendStart < start ? trendStart : start
  const sources = egressSources()

  // One row per axis and day, summed across the account's projects (and, for
  // egress, only the sources the close bills).
  const rows = await prisma.$queryRaw<Array<{ axis: string; day: Date; quantity: bigint }>>`
    SELECT "axis", "day", SUM("quantity")::bigint AS quantity
    FROM "usage_daily"
    WHERE "billingAccountId" = ${billingAccountId}
      AND "day" >= ${from}::date AND "day" < ${end}::date
      AND ("axis" <> 'egress_bytes' OR "source" = ANY(${sources}::text[]))
    GROUP BY "axis", "day"`

  const byAxis = new Map<string, Array<{ day: number; q: number }>>()
  for (const r of rows) {
    const list = byAxis.get(r.axis) ?? []
    list.push({ day: new Date(r.day).getTime(), q: Number(r.quantity) })
    byAxis.set(r.axis, list)
  }

  const elapsedDays = Math.floor((today.getTime() - start.getTime()) / DAY_MS) + 1 // today included
  const remainingDays = Math.max(0, days - elapsedDays)
  const out = {} as Record<OverageAxis, AxisForecast>

  for (const axis of OVERAGE_AXES) {
    const points = byAxis.get(axis) ?? []
    const inMonth = points.filter((p) => p.day >= start.getTime())
    if (USAGE_AXES[axis].kind === 'counter') {
      const monthToDate = inMonth.reduce((s, p) => s + p.q, 0)
      const trend = points.filter((p) => p.day >= trendStart.getTime() && p.day < today.getTime())
      const dailyAverage = trend.reduce((s, p) => s + p.q, 0) / TREND_DAYS
      out[axis] = { axis, monthToDate, projected: Math.round(monthToDate + dailyAverage * remainingDays) }
    } else {
      const latest = inMonth.length ? inMonth.reduce((a, b) => (b.day > a.day ? b : a)).q : 0
      const byteDays = inMonth.reduce((s, p) => s + p.q, 0)
      const averageSoFar = inMonth.length ? byteDays / elapsedDays : 0
      out[axis] = { axis, monthToDate: Math.round(averageSoFar), projected: Math.round((byteDays + latest * remainingDays) / days) }
    }
  }
  return out
}
