/**
 * DRIFT EVENT UPKEEP, PER REGION
 * ==============================
 * Schema drift events live in each region's own database (founders,
 * 2026-10-16; lib/data-plane/regional.ts projectDriftEvents). Moving them there
 * is only safe if three things are watched there too:
 *
 *   driftCaptureHealth(region)   is the capture apparatus present and able to
 *                                write? The capture triggers deliberately never
 *                                break a developer's DDL, so a missing table or
 *                                a lost privilege would otherwise drop every
 *                                event without a trace.
 *   driftEventBacklog(region)    how many events are pending, and the age of the
 *                                oldest: adoption normally runs within minutes,
 *                                so an old pending event means the loop is stuck.
 *   pruneResolvedDriftEvents()   retention: adopted or ignored events older than
 *                                the window are deleted. Pending events are
 *                                never pruned; they are unfinished work.
 *
 * runDriftEventUpkeep() runs all three for every region this process has a
 * database connection to, and logs one JSON line per region. CloudWatch metric
 * filters turn those lines into alarms (backenly-infra
 * aws/REGIONS_REFERENCE_ARCHITECTURE.md, section 8); the capture triggers also
 * log BACKENLY_DRIFT_CAPTURE_FAILED to the database log when a write fails.
 */

import { connectedRegions, regionDriftEvents, regionRawClient } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'

/** The two event triggers scripts/setup-direct-access.sql installs, and their functions. */
const CAPTURE = [
  { trigger: 'backenly_ddl_watch', fn: 'backenly_capture_ddl' },
  { trigger: 'backenly_drop_watch', fn: 'backenly_capture_drop' },
] as const

const DEFAULT_RETENTION_DAYS = 90

export interface DriftCaptureHealth {
  /**
   * healthy  every piece is present and the capture functions can write
   * absent   no capture apparatus at all (direct database access not installed)
   * broken   some of it is there but events would be lost
   */
  status: 'healthy' | 'absent' | 'broken'
  problems: string[]
}

/** Is the capture apparatus in this region's database complete and able to write? */
export async function driftCaptureHealth(region: CloudRegionId): Promise<DriftCaptureHealth> {
  const db = regionRawClient(region)
  const triggers = await db.$queryRawUnsafe<Array<{ name: string; enabled: string }>>(
    `SELECT evtname::text AS name, evtenabled::text AS enabled FROM pg_event_trigger
      WHERE evtname = ANY($1::text[])`,
    CAPTURE.map((c) => c.trigger),
  )
  const functions = await db.$queryRawUnsafe<Array<{ name: string; owner: string }>>(
    `SELECT p.proname::text AS name, pg_get_userbyid(p.proowner)::text AS owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    CAPTURE.map((c) => c.fn),
  )
  const [{ present }] = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public.schema_drift_events') IS NOT NULL AS present`,
  )

  if (triggers.length === 0 && functions.length === 0) {
    return { status: 'absent', problems: ['direct database access is not installed in this database'] }
  }

  const problems: string[] = []
  for (const { trigger, fn } of CAPTURE) {
    const t = triggers.find((row) => row.name === trigger)
    if (!t) problems.push(`event trigger ${trigger} is missing`)
    else if (t.enabled === 'D') problems.push(`event trigger ${trigger} is disabled`)
    if (!functions.some((row) => row.name === fn)) problems.push(`capture function ${fn} is missing`)
  }
  if (!present) {
    problems.push('public.schema_drift_events is missing, so every captured event is dropped')
  } else {
    // The functions are SECURITY DEFINER: they insert as their owner.
    for (const { name, owner } of functions) {
      const [{ allowed }] = await db.$queryRawUnsafe<Array<{ allowed: boolean }>>(
        `SELECT has_table_privilege($1, 'public.schema_drift_events', 'INSERT') AS allowed`,
        owner,
      )
      if (!allowed) problems.push(`${name} runs as ${owner}, which cannot insert into public.schema_drift_events`)
    }
  }
  return { status: problems.length === 0 ? 'healthy' : 'broken', problems }
}

export interface DriftEventBacklog {
  pending: number
  /** Seconds since the oldest pending event was captured; null when none is pending. */
  oldestPendingSeconds: number | null
}

export async function driftEventBacklog(region: CloudRegionId, now: Date = new Date()): Promise<DriftEventBacklog> {
  const events = regionDriftEvents(region)
  const [pending, oldest] = await Promise.all([
    events.count({ where: { status: 'pending' } }),
    events.findFirst({ where: { status: 'pending' }, orderBy: { capturedAt: 'asc' }, select: { capturedAt: true } }),
  ])
  return {
    pending,
    oldestPendingSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.capturedAt.getTime()) / 1000)) : null,
  }
}

/** Retention window in days: DRIFT_EVENT_RETENTION_DAYS, at least 7, default 90. */
export function driftEventRetentionDays(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number.parseInt(env.DRIFT_EVENT_RETENTION_DAYS ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 7 ? parsed : DEFAULT_RETENTION_DAYS
}

/** Delete adopted or ignored events resolved more than `days` ago. Pending events stay. */
export async function pruneResolvedDriftEvents(
  region: CloudRegionId,
  days: number = driftEventRetentionDays(),
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const { count } = await regionDriftEvents(region).deleteMany({
    where: { status: { in: ['adopted', 'ignored'] }, resolvedAt: { lt: cutoff } },
  })
  return count
}

export interface DriftUpkeepReport {
  region: CloudRegionId
  health: DriftCaptureHealth | null
  backlog: DriftEventBacklog | null
  pruned: number | null
  /** Steps that failed, with the error, so a failing step is reported rather than skipped. */
  errors: string[]
}

/**
 * One upkeep pass over every region this process can reach. Each step's
 * failure is recorded in its region's report and logged; one region's problem
 * never hides another's.
 */
export async function runDriftEventUpkeep(now: Date = new Date()): Promise<DriftUpkeepReport[]> {
  const reports: DriftUpkeepReport[] = []
  for (const region of connectedRegions()) {
    const report: DriftUpkeepReport = { region, health: null, backlog: null, pruned: null, errors: [] }
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run()
      } catch (err) {
        report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    }
    report.health = await step('health', () => driftCaptureHealth(region))
    report.backlog = await step('backlog', () => driftEventBacklog(region, now))
    report.pruned = await step('prune', () => pruneResolvedDriftEvents(region, driftEventRetentionDays(), now))

    // One line per region, in a fixed shape the metric filters match on.
    console.log(JSON.stringify({
      event: 'drift_event_upkeep',
      region,
      capture: report.health?.status ?? 'unknown',
      problems: report.health?.problems ?? [],
      pending: report.backlog?.pending ?? null,
      oldestPendingSeconds: report.backlog?.oldestPendingSeconds ?? null,
      pruned: report.pruned,
      errors: report.errors,
    }))
    reports.push(report)
  }
  return reports
}
