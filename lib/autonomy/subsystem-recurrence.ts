/**
 * SUBSYSTEM RECURRENCE — shadow evaluator
 * =======================================
 *
 * The loop already escalates a flapping gap: reconciler.ts counts recurrences
 * of one exact `gapIdentity` (`type::location`) inside a 24-hour window and
 * hands the still-open repeat to a human. What it cannot see is four DIFFERENT
 * gaps repaired across `users` / `sessions` / `verification_tokens` — four
 * independent stories to the loop, one story to an engineer.
 *
 * This module asks that question and, for now, only records the answer.
 *
 * ── Why shadow first ────────────────────────────────────────────────────────
 *
 * The firing contract below is deliberately strict, and strict contracts can be
 * strict enough never to fire. Nobody knows yet whether Backenly-managed
 * projects actually exhibit subsystem-level repeated failure often enough to
 * justify building diagnosis, planning and structural execution on top of it.
 * Writing findings before that is known would be building six phases on an
 * input that may not exist. So this writes ONE audit row per tick, changes
 * nothing a user sees, and exists to answer four questions:
 *
 *   1. does the predicate ever fire?
 *   2. is the clustering sane, or is everything one blob?
 *   3. how many projects have no FK skeleton at all?
 *   4. do inferred edges help, or just merge everything?
 *
 * ── The evidence rule ───────────────────────────────────────────────────────
 *
 * Churn is an AMPLIFIER, never a detector. "This table changed 14 times" is not
 * evidence of harm — it is usually evidence that someone is actively building
 * there, and a system that files findings against the healthiest part of a
 * backend trains its owner to ignore findings. `firesSubsystemRecurrence` below
 * therefore does not take churn as a parameter at all. A comment saying "do not
 * use churn in the gate" can be ignored by the next edit; a signature that
 * cannot see it cannot be.
 *
 * Read-only. Writes no findings and mutates nothing.
 */

import { prisma } from '@/lib/db/prisma'
import { gapIdentity } from './desired-state'
import {
  computeSubsystems,
  membershipHash,
  type ClusteringKind,
  type EdgeProvenance,
  type SubsystemMap,
} from './subsystem'

// ── Firing contract ───────────────────────────────────────────────────────────

/** Confirmed repairs in the window before an area is even a candidate. */
export const SUBSYSTEM_REPAIR_THRESHOLD = 3

/**
 * Distinct `gapIdentity` values those repairs must span.
 *
 * Two is the line between this and the recurrence check the reconciler already
 * does. One identity repeating is a flapping fix and reconciler.ts owns it;
 * reporting it here as well would be the same fact told twice.
 */
export const MIN_DISTINCT_IDENTITIES = 2

/** Harm signals independent of the repairs themselves. */
export const MIN_INDEPENDENT_HARM = 1

export const DEFAULT_WINDOW_DAYS = 30

/**
 * The gate, as a pure predicate.
 *
 * Extracted so it can be tested without a database, and so the set of inputs is
 * visible in one place. Note what is absent: churn, change count, table count,
 * naming shape. Those are amplifiers or context and none of them may create a
 * claim.
 */
export function firesSubsystemRecurrence(input: {
  confirmedRepairCount: number
  distinctGapIdentityCount: number
  independentHarmCount: number
  eligible: boolean
}): boolean {
  return (
    input.eligible &&
    input.confirmedRepairCount >= SUBSYSTEM_REPAIR_THRESHOLD &&
    input.distinctGapIdentityCount >= MIN_DISTINCT_IDENTITIES &&
    input.independentHarmCount >= MIN_INDEPENDENT_HARM
  )
}

// ── Evidence shapes ───────────────────────────────────────────────────────────

export interface ConfirmedRepair {
  findingId: string
  type: string
  gapKey: string
  table: string
  at: string
}

export type HarmKind = 'escalation' | 'server_error'

export interface HarmSignal {
  kind: HarmKind
  detail: string
  at: string
  /**
   * The finding this signal came from, when it came from one.
   *
   * Load-bearing for the independence rule below, and the reason `detail` is
   * not used for it: `detail` is prose for a human, and filtering a set of
   * finding ids against a set of sentences excludes nothing while looking
   * exactly like a filter that does.
   */
  sourceFindingId?: string
}

export interface SubsystemEvidence {
  fingerprint: string
  membershipHash: string
  membership: string[]
  provenance: EdgeProvenance
  eligible: boolean
  ineligibleReason?: string
  confirmedRepairs: ConfirmedRepair[]
  distinctGapIdentities: string[]
  independentHarm: HarmSignal[]
  /** Amplifier only. Present for reporting; never consulted by the gate. */
  changeCount: number
  fires: boolean
}

export interface SubsystemRecurrenceReport {
  projectId: string
  kind: ClusteringKind
  windowDays: number
  noConstraintSkeleton: boolean
  tableCount: number
  componentCount: number
  eligibleComponentCount: number
  largestComponentShare: number
  /**
   * Share of in-window auto-fixed findings that could be attributed to a table.
   *
   * Reported rather than hidden. Findings located by workflow or by runtime
   * surface carry no table at all, so they can never join a subsystem's
   * evidence — and a firing rate computed from partial attribution needs that
   * caveat attached to it, not discovered later.
   */
  attributionCoverage: number
  subsystems: SubsystemEvidence[]
  firing: SubsystemEvidence[]
}

// ── Attribution ───────────────────────────────────────────────────────────────

/** The table a finding is about, or null when it is not located by table. */
export function findingTable(details: Record<string, unknown> | null | undefined): string | null {
  const d = details ?? {}
  const direct = (d.tableName ?? d.table) as string | undefined
  if (typeof direct === 'string' && direct) return direct

  // `location` is `table` or `table.column` for the probes that set it. Workflow
  // and runtime-surface findings put something else there entirely, which is
  // why this returns null rather than guessing.
  const loc = d.location
  if (typeof loc === 'string' && loc && !loc.includes('/') && !loc.includes(':')) {
    return loc.split('.')[0]
  }
  return null
}

/**
 * The table an API request touched, from its path.
 *
 * Covers the generated data plane (`/api/v1/{projectId}/db/{table}`) only.
 * Function invocations and custom routes are not attributable this way, which
 * is part of why `attributionCoverage` is reported.
 */
export function requestTable(path: string): string | null {
  const m = /\/db\/([A-Za-z0-9_]+)/.exec(path)
  return m ? m[1] : null
}

/**
 * Only the kernel's own positive re-probe counts as a confirmed repair.
 *
 * Same accessor the trust scoreboard uses (`rollbackData.verification`), on
 * purpose: two definitions of "this fix was verified" would drift, and the one
 * that drifts low is the one that quietly inflates a firing rate.
 */
export function isConfirmedRepair(details: Record<string, unknown> | null | undefined): boolean {
  const rb = (details ?? {}).rollbackData as Record<string, unknown> | undefined
  return rb?.verification === 'confirmed'
}

// ── Evaluation ────────────────────────────────────────────────────────────────

export async function evaluateSubsystemRecurrence(
  projectId: string,
  opts: { windowDays?: number; kind?: ClusteringKind; map?: SubsystemMap } = {},
): Promise<SubsystemRecurrenceReport> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS
  const kind = opts.kind ?? 'attached'
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const map = opts.map ?? (await computeSubsystems(projectId, kind))

  const [fixed, escalated, serverErrors] = await Promise.all([
    prisma.healthFinding.findMany({
      where: { projectId, status: 'auto_fixed', fixAppliedAt: { gte: since } },
      select: { id: true, type: true, details: true, fixAppliedAt: true },
      orderBy: { fixAppliedAt: 'desc' },
      take: 500,
    }),
    prisma.healthFinding.findMany({
      where: { projectId, status: 'pending_approval', detectedAt: { gte: since } },
      select: { id: true, type: true, details: true, detectedAt: true },
      take: 200,
    }),
    prisma.apiRequestLog.findMany({
      where: { projectId, timestamp: { gte: since }, statusCode: { gte: 500 } },
      select: { path: true, statusCode: true, timestamp: true },
      take: 500,
    }),
  ])

  // ── Attribution coverage, measured on the repairs that matter ──────────────
  const attributable = fixed.filter(f =>
    findingTable(f.details as Record<string, unknown>) !== null,
  )
  const attributionCoverage = fixed.length === 0 ? 1 : attributable.length / fixed.length

  const repairsByTable = new Map<string, ConfirmedRepair[]>()
  for (const f of fixed) {
    const details = (f.details ?? {}) as Record<string, unknown>
    if (!isConfirmedRepair(details)) continue
    const table = findingTable(details)
    if (!table) continue
    const entry: ConfirmedRepair = {
      findingId: f.id,
      type: f.type,
      gapKey: gapIdentity(f.type, details),
      table,
      at: (f.fixAppliedAt ?? new Date()).toISOString(),
    }
    const list = repairsByTable.get(table)
    if (list) list.push(entry)
    else repairsByTable.set(table, [entry])
  }

  const harmByTable = new Map<string, HarmSignal[]>()
  const pushHarm = (table: string, signal: HarmSignal) => {
    const list = harmByTable.get(table)
    if (list) list.push(signal)
    else harmByTable.set(table, [signal])
  }

  for (const f of escalated) {
    const table = findingTable(f.details as Record<string, unknown>)
    if (!table) continue
    pushHarm(table, {
      kind: 'escalation',
      detail: `${f.type} escalated for review`,
      at: f.detectedAt.toISOString(),
      sourceFindingId: f.id,
    })
  }

  for (const r of serverErrors) {
    const table = requestTable(r.path)
    if (!table) continue
    pushHarm(table, {
      kind: 'server_error',
      detail: `${r.statusCode} on ${r.path}`,
      at: r.timestamp.toISOString(),
    })
  }

  // Amplifier: how much this area changed at all. Reported, never gated on.
  const changes = await prisma.backendEvent
    .findMany({
      where: { projectId, createdAt: { gte: since } },
      select: { beforeState: true },
      take: 1000,
    })
    .catch(() => [] as Array<{ beforeState: unknown }>)

  const changeByTable = new Map<string, number>()
  for (const c of changes) {
    const before = (c.beforeState ?? {}) as Record<string, unknown>
    const res = before.resource
    if (typeof res !== 'string' || !res) continue
    changeByTable.set(res, (changeByTable.get(res) ?? 0) + 1)
  }

  const subsystems: SubsystemEvidence[] = map.subsystems.map(s => {
    const confirmedRepairs = s.membership.flatMap(t => repairsByTable.get(t) ?? [])
    const distinctGapIdentities = [...new Set(confirmedRepairs.map(r => r.gapKey))].sort()

    // Independence: a harm signal produced BY one of the counted repairs would
    // make the loop's own activity the evidence for its own escalation.
    const repairIds = new Set(confirmedRepairs.map(r => r.findingId))
    const independentHarm = s.membership
      .flatMap(t => harmByTable.get(t) ?? [])
      .filter(h => !(h.sourceFindingId && repairIds.has(h.sourceFindingId)))

    const changeCount = s.membership.reduce((n, t) => n + (changeByTable.get(t) ?? 0), 0)

    return {
      fingerprint: s.fingerprint,
      membershipHash: membershipHash(s.membership),
      membership: s.membership,
      provenance: s.provenance,
      eligible: s.eligible,
      ineligibleReason: s.ineligibleReason,
      confirmedRepairs,
      distinctGapIdentities,
      independentHarm,
      changeCount,
      fires: firesSubsystemRecurrence({
        confirmedRepairCount: confirmedRepairs.length,
        distinctGapIdentityCount: distinctGapIdentities.length,
        independentHarmCount: independentHarm.length,
        eligible: s.eligible,
      }),
    }
  })

  const largest = map.subsystems.reduce((n, s) => Math.max(n, s.membership.length), 0)

  return {
    projectId,
    kind,
    windowDays,
    noConstraintSkeleton: map.noConstraintSkeleton,
    tableCount: map.tables.length,
    componentCount: map.subsystems.length,
    eligibleComponentCount: map.subsystems.filter(s => s.eligible).length,
    largestComponentShare: map.tables.length === 0 ? 0 : largest / map.tables.length,
    attributionCoverage,
    subsystems,
    firing: subsystems.filter(s => s.fires),
  }
}

/**
 * The one row this slice writes.
 *
 * An `AuditLog` row, not a `HealthFinding`: shadow means the owner sees nothing
 * and no queue grows. The shape is chosen so the four questions in the module
 * header can be answered by querying this action alone.
 */
export interface ShadowTelemetry {
  kind: ClusteringKind
  windowDays: number
  noConstraintSkeleton: boolean
  tableCount: number
  componentCount: number
  eligibleComponentCount: number
  largestComponentShare: number
  attributionCoverage: number
  firedCount: number
  /** Membership hashes only. No table names, so the row stays small. */
  firedMemberships: string[]
  maxConfirmedRepairs: number
  maxDistinctIdentities: number
}

export function toShadowTelemetry(report: SubsystemRecurrenceReport): ShadowTelemetry {
  return {
    kind: report.kind,
    windowDays: report.windowDays,
    noConstraintSkeleton: report.noConstraintSkeleton,
    tableCount: report.tableCount,
    componentCount: report.componentCount,
    eligibleComponentCount: report.eligibleComponentCount,
    largestComponentShare: Number(report.largestComponentShare.toFixed(3)),
    attributionCoverage: Number(report.attributionCoverage.toFixed(3)),
    firedCount: report.firing.length,
    firedMemberships: report.firing.map(f => f.membershipHash),
    maxConfirmedRepairs: report.subsystems.reduce(
      (n, s) => Math.max(n, s.confirmedRepairs.length),
      0,
    ),
    maxDistinctIdentities: report.subsystems.reduce(
      (n, s) => Math.max(n, s.distinctGapIdentities.length),
      0,
    ),
  }
}
