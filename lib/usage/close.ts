/**
 * The monthly close: turn a finished UTC month of UsageDaily rows into one
 * immutable UsagePeriodClose row per billing account and axis.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *
 *  • Only a finished month can close. Closing the current or a future month is
 *    refused, so a partial month can never become a billing fact.
 *  • Insert-only. Every row is written with ON CONFLICT DO NOTHING against
 *    (billingAccountId, period, axis), so running the close again, or two
 *    processes running it at once, cannot add a second total or change the
 *    first. The table also refuses UPDATE (migration trigger).
 *  • An axis is closed from whatever has been recorded by the time it closes.
 *    Usage recorded for that month AFTER its axis closed (a late access log) is
 *    not billed: late data errs in the customer's favour, never the reverse.
 *  • Nothing here is a price. The close says how much; pricing is elsewhere.
 *
 * ── Per axis ────────────────────────────────────────────────────────────────
 *
 *  counters (egress_bytes, mau, fn_runs)  sum of the month's daily quantities
 *      egress uses only the sources in USAGE_EGRESS_SOURCES (default
 *      app,s3,cloudfront). Cloud switches to alb,s3,cloudfront once load
 *      balancer logs are ingested: 'app' and 'alb' measure the same responses
 *      (app before compression, alb on the wire), so counting both would bill
 *      them twice. Every source is still recorded in `detail`.
 *  gauges (db_bytes, file_bytes)          byte-months: for each day, the sum of
 *      every project's daily maximum; then the average over EVERY day of the
 *      month (a day with no sample counts as zero), rounded down.
 *  ai_tokens                              AccountAiUsage.tokenCount for the month,
 *      the same number the AI credit meter already enforces.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { AI_TOKENS_AXIS, USAGE_AXES, periodBounds, utcPeriod, type UsageAxisName } from './axes'

const DEFAULT_EGRESS_SOURCES = ['app', 's3', 'cloudfront']

export function egressSources(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.USAGE_EGRESS_SOURCES?.trim()
  if (!raw) return DEFAULT_EGRESS_SOURCES
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (list.includes('app') && list.includes('alb')) {
    throw new Error('USAGE_EGRESS_SOURCES must not contain both app and alb: they measure the same responses')
  }
  return list
}

export interface CloseRow {
  billingAccountId: string
  axis: UsageAxisName | typeof AI_TOKENS_AXIS
  quantity: bigint
  unit: string
  detail: Record<string, unknown>
}

export interface CloseSummary {
  period: string
  accounts: number
  inserted: number
  alreadyClosed: number
}

type Db = typeof prisma

/**
 * What the close WOULD write for a period, computed from the ledger. Pure read.
 * Exported so shadow billing and the usage page can show the same numbers the
 * close will produce.
 */
export async function computePeriodTotals(period: string, db: Db = prisma): Promise<CloseRow[]> {
  const { start, end, days } = periodBounds(period)
  const egress = egressSources()

  const counters = await db.$queryRaw<Array<{ billingAccountId: string; axis: string; source: string; q: bigint }>>`
    SELECT "billingAccountId", "axis", "source", SUM("quantity")::bigint AS q
    FROM "usage_daily"
    WHERE "day" >= ${start}::date AND "day" < ${end}::date
      AND "axis" = ANY(${['egress_bytes', 'mau', 'fn_runs']}::text[])
    GROUP BY 1, 2, 3`

  const gauges = await db.$queryRaw<Array<{ billingAccountId: string; axis: string; day: Date; q: bigint }>>`
    SELECT "billingAccountId", "axis", "day", SUM("quantity")::bigint AS q
    FROM "usage_daily"
    WHERE "day" >= ${start}::date AND "day" < ${end}::date
      AND "axis" = ANY(${['db_bytes', 'file_bytes']}::text[])
    GROUP BY 1, 2, 3`

  const ai = await db.accountAiUsage.findMany({
    where: { date: period, tokenCount: { gt: 0 } },
    select: { billingAccountId: true, tokenCount: true },
  })

  const rows = new Map<string, CloseRow>()
  const key = (a: string, axis: string) => `${a}|${axis}`

  for (const r of counters) {
    const axis = r.axis as UsageAxisName
    const k = key(r.billingAccountId, axis)
    const row =
      rows.get(k) ??
      { billingAccountId: r.billingAccountId, axis, quantity: BigInt(0), unit: USAGE_AXES[axis].closedUnit, detail: { sources: {} as Record<string, string> } }
    ;(row.detail.sources as Record<string, string>)[r.source] = r.q.toString()
    const counts = axis !== 'egress_bytes' || egress.includes(r.source)
    if (counts) row.quantity += BigInt(r.q)
    rows.set(k, row)
  }
  for (const row of rows.values()) {
    if (row.axis === 'egress_bytes') row.detail.billedSources = egress
  }

  const dailyTotals = new Map<string, bigint>()
  const sampledDays = new Map<string, number>()
  for (const r of gauges) {
    const k = key(r.billingAccountId, r.axis)
    dailyTotals.set(k, (dailyTotals.get(k) ?? BigInt(0)) + BigInt(r.q))
    sampledDays.set(k, (sampledDays.get(k) ?? 0) + 1)
  }
  for (const [k, total] of dailyTotals) {
    const [billingAccountId, axis] = k.split('|') as [string, UsageAxisName]
    rows.set(k, {
      billingAccountId,
      axis,
      quantity: total / BigInt(days), // BigInt division floors
      unit: USAGE_AXES[axis].closedUnit,
      detail: { daysInPeriod: days, daysSampled: sampledDays.get(k) ?? 0, byteDays: total.toString() },
    })
  }

  for (const r of ai) {
    rows.set(key(r.billingAccountId, AI_TOKENS_AXIS), {
      billingAccountId: r.billingAccountId,
      axis: AI_TOKENS_AXIS,
      quantity: BigInt(r.tokenCount),
      unit: 'tokens',
      detail: { source: 'account_ai_usage' },
    })
  }

  return Array.from(rows.values())
}

/**
 * Close a finished month. Idempotent: returns how many rows it inserted and how
 * many were already closed.
 */
export async function closePeriod(period: string, db: Db = prisma, now: Date = new Date()): Promise<CloseSummary> {
  const { end } = periodBounds(period)
  if (end.getTime() > now.getTime()) {
    throw new Error(`Refusing to close ${period}: the month has not finished (it ends ${end.toISOString()})`)
  }
  const totals = await computePeriodTotals(period, db)
  let inserted = 0
  for (const row of totals) {
    const n = await db.$executeRaw`
      INSERT INTO "usage_period_closes" ("id", "billingAccountId", "period", "axis", "quantity", "unit", "detail")
      VALUES (${randomUUID()}, ${row.billingAccountId}, ${period}, ${row.axis}, ${row.quantity}, ${row.unit}, ${JSON.stringify(row.detail)}::jsonb)
      ON CONFLICT ("billingAccountId", "period", "axis") DO NOTHING`
    inserted += n
  }
  return {
    period,
    accounts: new Set(totals.map((r) => r.billingAccountId)).size,
    inserted,
    alreadyClosed: totals.length - inserted,
  }
}

/**
 * The scheduled job: close the month before `now`. Runs daily; the first run in
 * a month does the work and every later one is a no-op, which also covers a day
 * the scheduler was down.
 */
export async function closePreviousPeriod(now: Date = new Date()): Promise<CloseSummary> {
  const current = utcPeriod(now)
  const { start } = periodBounds(current)
  const previous = utcPeriod(new Date(start.getTime() - 86_400_000))
  const { usageLedger } = await import('./ledger')
  await usageLedger().flush().catch(() => {})
  return closePeriod(previous, prisma, now)
}
