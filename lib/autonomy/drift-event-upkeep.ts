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
 * runDriftEventUpkeep() runs all three for the region this process serves (each
 * region's scheduler upkeeps its own database, in that region), and logs one
 * JSON line per region. CloudWatch metric
 * filters turn those lines into alarms (backenly-infra
 * aws/REGIONS_REFERENCE_ARCHITECTURE.md, section 8); the capture triggers also
 * log BACKENLY_DRIFT_CAPTURE_FAILED to the database log when a write fails.
 *
 * A project with a database of its own captures its events in that database,
 * so each pass also walks every project database of the region, a few at a
 * time (lib/data-plane/project-databases.ts forEachProjectDatabase), each with
 * a report and a line of its own that names it (`database`). The region's own
 * line keeps its shape. An event in a project database is held when the
 * project's row names that database; one in the region's own database, when
 * the project is in the region and shares it.
 */

import { prisma } from '@/lib/db/prisma'
import {
  DriftEventStore,
  databaseClient,
  regionDriftEvents,
  regionOfRecord,
  regionRawClient,
  type PendingGroup,
  type WorkspaceRawClient,
} from '@/lib/data-plane/regional'
import { forEachProjectDatabase } from '@/lib/data-plane/project-databases'
import { serviceRegion } from '@/lib/data-plane/serving'
import type { CloudRegionId } from '@/lib/regions'

/**
 * The database a pass reads: a region's own (a region id alone), or a
 * project's own database in it.
 */
export type DriftTarget = CloudRegionId | { region: CloudRegionId; database: string | null }

function partsOf(target: DriftTarget): { region: CloudRegionId; database: string | null } {
  return typeof target === 'string' ? { region: target, database: null } : target
}

function driftClient(target: DriftTarget): WorkspaceRawClient {
  const { region, database } = partsOf(target)
  return database === null ? regionRawClient(region) : databaseClient(region, database)
}

function driftStore(target: DriftTarget): DriftEventStore {
  const { region, database } = partsOf(target)
  return database === null ? regionDriftEvents(region) : new DriftEventStore(databaseClient(region, database))
}

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

/** Is the capture apparatus in this database complete and able to write? */
export async function driftCaptureHealth(target: DriftTarget): Promise<DriftCaptureHealth> {
  const db = driftClient(target)
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

export async function driftEventBacklog(target: DriftTarget, now: Date = new Date()): Promise<DriftEventBacklog> {
  const groups = await pendingByProject(target)
  const held = await projectsHeldIn(target, namedProjects(groups))
  let pending = 0
  let orphaned = 0
  let oldest: Date | null = null
  for (const group of groups) {
    if (group.projectId !== null && held.has(group.projectId)) {
      pending += group.count
      const first = group.oldestCapturedAt
      if (first && (!oldest || first < oldest)) oldest = first
    } else {
      orphaned += group.count
    }
  }
  return {
    pending,
    oldestPendingSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null,
    orphaned,
  }
}

/** Pending events, grouped by the project they name, with the oldest capture of each. */
async function pendingByProject(target: DriftTarget, capturedBefore?: Date): Promise<PendingGroup[]> {
  return driftStore(target).pendingByProject({ capturedBefore })
}

function namedProjects(groups: Array<{ projectId: string | null }>): string[] {
  return groups.flatMap((group) => (group.projectId === null ? [] : [group.projectId]))
}

/**
 * Which of these projects this database holds. Adoption runs per project, on
 * the database holding its data, so a pending event naming any other project
 * (one since deleted, typically) or none at all is never cleared by it. A
 * region's own database holds the projects of the region that share it; a
 * project database, the project whose row names it.
 */
async function projectsHeldIn(target: DriftTarget, projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set()
  const { region, database } = partsOf(target)
  const rows = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, region: true, databaseTenancy: true, databaseName: true },
  })
  return new Set(
    rows
      .filter((row) => regionOfRecord(row.id, row.region) === region)
      .filter((row) => (database === null ? row.databaseTenancy !== 'dedicated' : row.databaseTenancy === 'dedicated' && row.databaseName === database))
      .map((row) => row.id),
  )
}

/** Retention window in days: DRIFT_EVENT_RETENTION_DAYS, at least 7, default 90. */
export function driftEventRetentionDays(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number.parseInt(env.DRIFT_EVENT_RETENTION_DAYS ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 7 ? parsed : DEFAULT_RETENTION_DAYS
}

/** Delete adopted or ignored events resolved more than `days` ago. Pending events stay. */
export async function pruneResolvedDriftEvents(
  target: DriftTarget,
  days: number = driftEventRetentionDays(),
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return driftStore(target).deleteResolvedBefore(cutoff)
}

/**
 * Delete orphaned pending events captured more than `days` ago. Within the
 * window they are kept and counted (driftEventBacklog().orphaned), so they are
 * seen; past it they record a change nobody can adopt, for a project this
 * region no longer holds.
 */
export async function pruneOrphanedDriftEvents(
  target: DriftTarget,
  days: number = driftEventRetentionDays(),
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const groups = await pendingByProject(target, cutoff)
  const named = namedProjects(groups)
  const held = await projectsHeldIn(target, named)
  const gone = named.filter((projectId) => !held.has(projectId))
  const unnamed = groups.some((group) => group.projectId === null)
  if (gone.length === 0 && !unnamed) return 0
  return driftStore(target).deletePendingBefore(cutoff, { projectIds: gone, unnamed })
}

export interface DriftUpkeepReport {
  region: CloudRegionId
  /** The project database this report is about; absent for the region's own database. */
  database?: string
  health: DriftCaptureHealth | null
  backlog: DriftEventBacklog | null
  pruned: number | null
  prunedOrphans: number | null
  /** Steps that failed, with the error, so a failing step is reported rather than skipped. */
  errors: string[]
}

/** One database's upkeep: its report, and its line. */
async function upkeepOne(target: DriftTarget, now: Date): Promise<DriftUpkeepReport> {
  const { region, database } = partsOf(target)
  const report: DriftUpkeepReport = {
    region,
    ...(database === null ? {} : { database }),
    health: null,
    backlog: null,
    pruned: null,
    prunedOrphans: null,
    errors: [],
  }
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (err) {
      report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  report.health = await step('health', () => driftCaptureHealth(target))
  report.backlog = await step('backlog', () => driftEventBacklog(target, now))
  report.pruned = await step('prune', () => pruneResolvedDriftEvents(target, driftEventRetentionDays(), now))
  report.prunedOrphans = await step('prune orphans', () => pruneOrphanedDriftEvents(target, driftEventRetentionDays(), now))

  // One line per database, in a fixed shape the metric filters match on: the
  // region's own as it always was, a project database's naming it.
  console.log(JSON.stringify({
    event: 'drift_event_upkeep',
    region,
    ...(database === null ? {} : { database }),
    capture: report.health?.status ?? 'unknown',
    problems: report.health?.problems ?? [],
    pending: report.backlog?.pending ?? null,
    oldestPendingSeconds: report.backlog?.oldestPendingSeconds ?? null,
    orphaned: report.backlog?.orphaned ?? null,
    pruned: report.pruned,
    prunedOrphans: report.prunedOrphans,
    errors: report.errors,
  }))
  return report
}

/**
 * One upkeep pass over `regions`, by default the one this process serves: each
 * region's own database, then each project database of the region, a few at a
 * time. Each step's failure is recorded in its database's report and logged;
 * one database's problem never hides another's.
 */
export async function runDriftEventUpkeep(
  now: Date = new Date(),
  regions: CloudRegionId[] = [serviceRegion()],
): Promise<DriftUpkeepReport[]> {
  const reports: DriftUpkeepReport[] = []
  for (const region of regions) {
    reports.push(await upkeepOne(region, now))
    try {
      const walked = await forEachProjectDatabase(region, (ref) => upkeepOne({ region, database: ref.database }, now))
      for (const { ref, result } of walked) {
        if (result.status === 'fulfilled') reports.push(result.value)
        else {
          reports.push({
            region,
            database: ref.database,
            health: null,
            backlog: null,
            pruned: null,
            prunedOrphans: null,
            errors: [`upkeep: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`],
          })
        }
      }
    } catch (err) {
      // The list of the region's project databases could not be read: said on the region's report, and logged.
      const message = `project databases: ${err instanceof Error ? err.message : String(err)}`
      reports[reports.length - 1].errors.push(message)
      console.error(`[DriftUpkeep] region=${region} ${message}`)
    }
  }
  return reports
}
