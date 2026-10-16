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
 *                                Events no adoption can clear (no project, or one
 *                                this region does not hold) are counted apart as
 *                                orphaned, so they cannot fake a stuck loop.
 *   pruneResolvedDriftEvents()   retention: adopted or ignored events older than
 *                                the window are deleted. Pending events are
 *                                never pruned; they are unfinished work.
 *   pruneOrphanedDriftEvents()   except orphans, which no work will finish: past
 *                                the window they are deleted too.
 *
 * runDriftEventUpkeep() runs all three for every region this process has a
 * database connection to, and logs one JSON line per region. CloudWatch metric
 * filters turn those lines into alarms (backenly-infra
 * aws/REGIONS_REFERENCE_ARCHITECTURE.md, section 8); the capture triggers also
 * log BACKENLY_DRIFT_CAPTURE_FAILED to the database log when a write fails.
 */

import { prisma } from '@/lib/db/prisma'
import { connectedRegions, regionDriftEvents, regionOfRecord, regionRawClient } from '@/lib/data-plane/regional'
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
  /** Pending events adoption is expected to clear: those of a project this region holds. */
  pending: number
  /** Seconds since the oldest of those was captured; null when none is pending. */
  oldestPendingSeconds: number | null
  /**
   * Pending events no adoption can clear: they name no project, or one this
   * region does not hold. Counted apart, so they never age the backlog that
   * means "adoption is stuck", and pruned past the retention window.
   */
  orphaned: number
}

export async function driftEventBacklog(region: CloudRegionId, now: Date = new Date()): Promise<DriftEventBacklog> {
  const groups = await pendingByProject(region)
  const held = await projectsHeldIn(region, namedProjects(groups))
  let pending = 0
  let orphaned = 0
  let oldest: Date | null = null
  for (const group of groups) {
    if (group.projectId !== null && held.has(group.projectId)) {
      pending += group._count._all
      const first = group._min.capturedAt
      if (first && (!oldest || first < oldest)) oldest = first
    } else {
      orphaned += group._count._all
    }
  }
  return {
    pending,
    oldestPendingSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null,
    orphaned,
  }
}

/** Pending events, grouped by the project they name, with the oldest capture of each. */
async function pendingByProject(region: CloudRegionId, capturedBefore?: Date) {
  return regionDriftEvents(region).groupBy({
    by: ['projectId'],
    where: { status: 'pending', ...(capturedBefore ? { capturedAt: { lt: capturedBefore } } : {}) },
    _count: { _all: true },
    _min: { capturedAt: true },
  })
}

function namedProjects(groups: Array<{ projectId: string | null }>): string[] {
  return groups.flatMap((group) => (group.projectId === null ? [] : [group.projectId]))
}

/**
 * Which of these projects this region holds. Adoption runs per project, in its
 * region, so a pending event naming any other project (one since deleted,
 * typically) or none at all is never cleared by it.
 */
async function projectsHeldIn(region: CloudRegionId, projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set()
  const rows = await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, region: true } })
  return new Set(rows.filter((row) => regionOfRecord(row.id, row.region) === region).map((row) => row.id))
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

/**
 * Delete orphaned pending events captured more than `days` ago. Within the
 * window they are kept and counted (driftEventBacklog().orphaned), so they are
 * seen; past it they record a change nobody can adopt, for a project this
 * region no longer holds.
 */
export async function pruneOrphanedDriftEvents(
  region: CloudRegionId,
  days: number = driftEventRetentionDays(),
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const groups = await pendingByProject(region, cutoff)
  const named = namedProjects(groups)
  const held = await projectsHeldIn(region, named)
  const gone = named.filter((projectId) => !held.has(projectId))
  const unnamed = groups.some((group) => group.projectId === null)
  if (gone.length === 0 && !unnamed) return 0
  const { count } = await regionDriftEvents(region).deleteMany({
    where: {
      status: 'pending',
      capturedAt: { lt: cutoff },
      OR: [...(unnamed ? [{ projectId: null }] : []), ...(gone.length > 0 ? [{ projectId: { in: gone } }] : [])],
    },
  })
  return count
}

export interface DriftUpkeepReport {
  region: CloudRegionId
  health: DriftCaptureHealth | null
  backlog: DriftEventBacklog | null
  pruned: number | null
  prunedOrphans: number | null
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
    const report: DriftUpkeepReport = { region, health: null, backlog: null, pruned: null, prunedOrphans: null, errors: [] }
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
    report.prunedOrphans = await step('prune orphans', () => pruneOrphanedDriftEvents(region, driftEventRetentionDays(), now))

    // One line per region, in a fixed shape the metric filters match on.
    console.log(JSON.stringify({
      event: 'drift_event_upkeep',
      region,
      capture: report.health?.status ?? 'unknown',
      problems: report.health?.problems ?? [],
      pending: report.backlog?.pending ?? null,
      oldestPendingSeconds: report.backlog?.oldestPendingSeconds ?? null,
      orphaned: report.backlog?.orphaned ?? null,
      pruned: report.pruned,
      prunedOrphans: report.prunedOrphans,
      errors: report.errors,
    }))
    reports.push(report)
  }
  return reports
}
