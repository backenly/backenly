/**
 * Usage anomalies: a project whose daily usage jumped far past its own normal.
 *
 * The spend guard's detector. An agent-built backend can start sending ten
 * times its usual egress because one file went viral, a loop re-fetches a
 * list, or a function retries forever; the owner should hear about it the day
 * it happens, from the Autonomy queue, not from the month's bill.
 *
 * Evidence (the finding policy: runtime evidence, never schema shape):
 *   the usage ledger (usage_daily) for one project, axis and UTC day, against
 *   the median of the same project's previous fourteen days, and, for egress,
 *   the request paths that carried the most traffic that day (api_request_logs).
 *   Backenly's own synthetic traffic is never in the ledger, so the platform's
 *   probes cannot raise one.
 *
 * Fires only when the day is both RELATIVELY large (at least SPIKE_RATIO times
 * the baseline) and ABSOLUTELY large (a floor per axis), so a quiet project
 * going from 3 requests to 40 is not an anomaly.
 *
 * Auto-resolves: the next evaluation whose day is back under RESOLVE_RATIO
 * times the baseline marks the open finding resolved. One finding type per
 * project and axis (`usage_anomaly_<axis>`), updated rather than duplicated
 * while the spike lasts.
 */
import { prisma } from '@/lib/db/prisma'
import type { OverageAxis } from '@/lib/pricing/catalog'
import { utcDay } from '@/lib/usage/axes'
import { egressSources } from '@/lib/usage/close'

const DAY_MS = 86_400_000
const BASELINE_DAYS = 14
export const SPIKE_RATIO = 5
export const RESOLVE_RATIO = 2

/** Axes watched, and the least a day must reach before it can be an anomaly. */
export const ANOMALY_FLOOR: Partial<Record<OverageAxis, number>> = {
  egress_bytes: 1024 ** 3, // 1 GB in a day
  fn_runs: 50_000,
  mau: 1_000, // first-seen end users in a day
}

const LABEL: Partial<Record<OverageAxis, string>> = {
  egress_bytes: 'egress',
  fn_runs: 'function runs',
  mau: 'new monthly active users',
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function fmt(axis: OverageAxis, n: number): string {
  return axis === 'egress_bytes' ? `${(n / 1024 ** 3).toFixed(2)} GB` : Math.round(n).toLocaleString('en-US')
}

export interface AnomalyVerdict {
  projectId: string
  axis: OverageAxis
  day: string
  observed: number
  baseline: number
  spike: boolean
  cleared: boolean
}

/** Pure: judge one project-axis-day against its baseline. */
export function judge(axis: OverageAxis, observed: number, history: number[]): { spike: boolean; cleared: boolean; baseline: number } {
  const baseline = median(history)
  const floor = ANOMALY_FLOOR[axis] ?? Infinity
  // A baseline of zero has no "normal" to compare against; the floor alone
  // then decides, at the same ratio against a baseline of one floor unit.
  const reference = Math.max(baseline, floor / SPIKE_RATIO)
  return {
    baseline,
    spike: observed >= floor && observed >= SPIKE_RATIO * reference,
    cleared: observed < RESOLVE_RATIO * Math.max(baseline, 1),
  }
}

/**
 * Evaluate one UTC day (normally yesterday, the last complete one) for every
 * project with ledger usage that day, raising, refreshing or resolving the
 * `usage_anomaly_<axis>` finding of each.
 */
export async function evaluateUsageAnomalies(day: Date = new Date(utcDay().getTime() - DAY_MS)): Promise<{ raised: number; resolved: number }> {
  const target = utcDay(day)
  const from = new Date(target.getTime() - BASELINE_DAYS * DAY_MS)
  const axes = Object.keys(ANOMALY_FLOOR) as OverageAxis[]
  const sources = egressSources()

  const rows = await prisma.$queryRaw<Array<{ projectId: string; axis: string; day: Date; quantity: bigint }>>`
    SELECT d."projectId", d."axis", d."day", SUM(d."quantity")::bigint AS quantity
    FROM "usage_daily" d
    JOIN "projects" p ON p."id" = d."projectId"
    WHERE d."day" >= (${from}::timestamptz AT TIME ZONE 'UTC')::date
      AND d."day" <= (${target}::timestamptz AT TIME ZONE 'UTC')::date
      AND d."axis" = ANY(${axes}::text[])
      AND (d."axis" <> 'egress_bytes' OR d."source" = ANY(${sources}::text[]))
    GROUP BY d."projectId", d."axis", d."day"`

  const series = new Map<string, Map<number, number>>()
  for (const r of rows) {
    const key = `${r.projectId}\u0000${r.axis}`
    const m = series.get(key) ?? new Map<number, number>()
    m.set(new Date(r.day).getTime(), Number(r.quantity))
    series.set(key, m)
  }

  let raised = 0
  let resolved = 0
  const dayIso = target.toISOString().slice(0, 10)
  for (const [key, points] of series) {
    const [projectId, axis] = key.split('\u0000') as [string, OverageAxis]
    const observed = points.get(target.getTime()) ?? 0
    const history: number[] = []
    for (let i = 1; i <= BASELINE_DAYS; i++) history.push(points.get(target.getTime() - i * DAY_MS) ?? 0)
    const v = judge(axis, observed, history)
    const type = `usage_anomaly_${axis}`

    if (v.spike) {
      const evidence = axis === 'egress_bytes' ? await topPaths(projectId, target) : []
      const ratio = observed / Math.max(v.baseline, 1)
      const where = evidence.length
        ? ` Most of the day's API traffic went to ${evidence.slice(0, 3).map((e) => `${e.path} (${e.requests.toLocaleString('en-US')} requests)`).join(', ')}.`
        : axis === 'egress_bytes'
          ? ' It did not go through the API: file downloads or direct storage links carried it.'
          : ''
      const details = {
        title: `${LABEL[axis]} ${ratio >= 10 ? `${Math.round(ratio)}x` : `${ratio.toFixed(1)}x`} its usual level on ${dayIso}`,
        description:
          `This project used ${fmt(axis, observed)} of ${LABEL[axis]} on ${dayIso}, against a usual ` +
          `${fmt(axis, v.baseline)} a day (the median of the previous ${BASELINE_DAYS} days).${where} ` +
          'If this was not expected, find what drove it before it runs into the plan limit or the spend limit.',
        source: 'usage_monitor',
        axis,
        day: dayIso,
        observed,
        baseline: v.baseline,
        topPaths: evidence,
        requiresApproval: false,
      }
      const open = await prisma.healthFinding.findFirst({ where: { projectId, type, status: 'open' }, select: { id: true } })
      if (open) {
        await prisma.healthFinding.update({ where: { id: open.id }, data: { details: details as any } })
      } else {
        await prisma.healthFinding.create({
          data: {
            projectId,
            type,
            severity: 'warning',
            category: 'reliability',
            source: 'usage_monitor',
            details: details as any,
            status: 'open',
          },
        })
        raised++
      }
    } else if (v.cleared) {
      const done = await prisma.healthFinding.updateMany({
        where: { projectId, type, status: 'open' },
        data: { status: 'resolved' },
      })
      resolved += done.count
    }
  }
  // A spike whose project has no usage left in the window at all is over too;
  // it simply produced no reading to judge above.
  const open = await prisma.healthFinding.findMany({
    where: { status: 'open', type: { startsWith: 'usage_anomaly_' } },
    select: { id: true, projectId: true, type: true },
  })
  const quiet = open.filter((f) => !series.has(`${f.projectId}\u0000${f.type.slice('usage_anomaly_'.length)}`))
  if (quiet.length) {
    const done = await prisma.healthFinding.updateMany({
      where: { id: { in: quiet.map((f) => f.id) }, status: 'open' },
      data: { status: 'resolved' },
    })
    resolved += done.count
  }

  return { raised, resolved }
}

/** The request paths that carried the most of a project's API traffic on a day. */
async function topPaths(projectId: string, day: Date): Promise<Array<{ path: string; requests: number }>> {
  const rows = await prisma.$queryRaw<Array<{ path: string; n: number }>>`
    SELECT "path", count(*)::int AS n
    FROM "api_request_logs"
    WHERE "projectId" = ${projectId}
      AND "timestamp" >= (${day}::timestamptz AT TIME ZONE 'UTC')
      AND "timestamp" < (${new Date(day.getTime() + DAY_MS)}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY "path"
    ORDER BY n DESC
    LIMIT 5`
  return rows.map((r) => ({ path: r.path, requests: r.n }))
}
