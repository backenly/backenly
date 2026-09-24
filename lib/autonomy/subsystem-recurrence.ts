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
 * ── How this is validated, and how it is NOT ────────────────────────────────
 *
 * The firing contract below is deliberately strict, and strict contracts can be
 * strict enough never to fire. The original plan was to settle that by watching
 * production. That plan was abandoned once it became clear the accounts on
 * production belong to the founder and a relative: a detector that never fires
 * proves nothing when nobody is generating real workloads, and one that fires
 * proves nothing when its author caused the firing.
 *
 * Correctness is therefore established against the scenario bank in
 * `tests/lab/`, which builds real schemas in a real PostgreSQL and asserts both
 * halves — that the evaluator fires on constructed recurrence, and stays silent
 * on every near-miss. PREVALENCE is a separate question that cannot be answered
 * yet, and nothing here should be read as an answer to it.
 *
 * The shadow telemetry still exists and is still worth collecting, but it is
 * now descriptive rather than a gate.
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
import { isVerifiedFix } from '@/lib/core/fix-verification'
import type { RawFinding, FindingSeverity } from '@/lib/core/types'
import { FLAGS } from '@/lib/config/flags'
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

/**
 * The kinds of harm that can be attributed to a subsystem.
 *
 * ── What is deliberately absent, and why ────────────────────────────────────
 *
 * `RollbackExecution` looks like the obvious rollback source and is NOT used:
 * nothing in the product writes that model. The only `rollbackExecution`
 * symbols in the tree are a same-named function in
 * `lib/ai/execution-journal.ts`. Reading it would add a harm source that can
 * never fire — coverage that looks real in a type and is empty at runtime,
 * which is the exact shape of scaffolding this codebase refuses to ship.
 *
 * Rollbacks come instead from the audit ledger, using the same
 * `ROLLBACK_`-prefixed action set the trust scoreboard counts. Two definitions
 * of "a rollback happened" would drift, and the one that drifts low is the one
 * that quietly inflates a firing rate.
 *
 * Runtime telemetry (`computeHealthSignal`) is also absent from this list, and
 * that is a limitation rather than an oversight: it aggregates `ApiRequestLog`
 * per PROJECT, so it cannot say which subsystem degraded. It is reported
 * alongside as project-level context and never counted as subsystem harm.
 */
export type HarmKind = 'escalation' | 'server_error' | 'rollback' | 'incident'

/** Audit actions the trust scoreboard counts as a rollback. Kept in step with it. */
const ROLLBACK_PREFIX = 'ROLLBACK_'

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
  /** Amplifier only: DDL that arrived outside Backenly, over a direct connection. */
  externalDdlCount: number
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
 * The table named by a `SchemaDriftEvent.objectIdentity`.
 *
 * Identities arrive schema-qualified and sometimes quoted
 * (`workspace_<id>."orders"`). Same parse `drift-watch.ts` applies when it
 * decides which externally-altered tables to re-register, so the two agree
 * about what an identity names.
 */
export function driftTable(objectIdentity: string | null | undefined): string | null {
  const ident = objectIdentity ?? ''
  if (!ident) return null
  const name = ident.includes('.')
    ? ident.slice(ident.indexOf('.') + 1).replace(/"/g, '')
    : ident.replace(/"/g, '')
  return name || null
}

/**
 * Which member tables an audit row's payload names, if any.
 *
 * Audit `details` is a JSON STRING column with no consistent schema across
 * actions, so this matches member names inside it rather than reading a field
 * that may not exist. Word-boundary matched to keep `orders` from matching
 * `order_items`, which would silently move one subsystem's harm into another.
 */
export function tablesNamedIn(details: string | null | undefined, members: readonly string[]): string[] {
  if (!details) return []
  return members.filter(m => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(details))
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
  return isVerifiedFix(rb?.verification)
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

  const [fixed, escalated, serverErrors, rollbackRows, incidents, driftRows] = await Promise.all([
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
    prisma.auditLog.findMany({
      where: { projectId, timestamp: { gte: since }, action: { startsWith: ROLLBACK_PREFIX } },
      select: { id: true, action: true, details: true, timestamp: true },
      take: 200,
    }),
    prisma.incident.findMany({
      where: { projectId, startedAt: { gte: since } },
      select: { id: true, title: true, affectedServices: true, startedAt: true },
      take: 200,
    }),
    prisma.schemaDriftEvent.findMany({
      where: { projectId, capturedAt: { gte: since } },
      select: { objectIdentity: true },
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

  // Rollbacks and incidents are attributed per SUBSYSTEM rather than per table,
  // because neither source carries a single table: an audit payload may name
  // several, and an incident's affectedServices is a free-form list. Held aside
  // and matched against each component's membership below.
  const allMembers = [...new Set(map.subsystems.flatMap(s => s.membership))]

  const rollbackHarm: Array<{ tables: string[]; signal: HarmSignal }> = []
  for (const r of rollbackRows) {
    const tables = tablesNamedIn(r.details, allMembers)
    if (tables.length === 0) continue
    rollbackHarm.push({
      tables,
      signal: {
        kind: 'rollback',
        detail: `${r.action} touched ${tables.join(', ')}`,
        at: r.timestamp.toISOString(),
      },
    })
  }

  const incidentHarm: Array<{ tables: string[]; signal: HarmSignal }> = []
  for (const inc of incidents) {
    const tables = allMembers.filter(m => inc.affectedServices.includes(m))
    if (tables.length === 0) continue
    incidentHarm.push({
      tables,
      signal: {
        kind: 'incident',
        detail: `incident: ${inc.title}`,
        at: inc.startedAt.toISOString(),
      },
    })
  }

  // External DDL is an AMPLIFIER, not harm. Someone running ALTER TABLE from
  // psql is a person working, not a backend failing, and counting it as harm
  // would make the most actively maintained backend look the sickest.
  const externalDdlByTable = new Map<string, number>()
  for (const d of driftRows) {
    const t = driftTable(d.objectIdentity)
    if (!t) continue
    externalDdlByTable.set(t, (externalDdlByTable.get(t) ?? 0) + 1)
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
    const memberSet = new Set(s.membership)
    const independentHarm = [
      ...s.membership.flatMap(t => harmByTable.get(t) ?? []),
      // Subsystem-scoped sources. Deduplicated by signal rather than by table:
      // one rollback naming three member tables is ONE piece of evidence, and
      // counting it three times would let a single event clear the harm gate on
      // its own.
      ...rollbackHarm.filter(r => r.tables.some(t => memberSet.has(t))).map(r => r.signal),
      ...incidentHarm.filter(i => i.tables.some(t => memberSet.has(t))).map(i => i.signal),
    ].filter(h => !(h.sourceFindingId && repairIds.has(h.sourceFindingId)))

    const changeCount = s.membership.reduce((n, t) => n + (changeByTable.get(t) ?? 0), 0)
    const externalDdlCount = s.membership.reduce(
      (n, t) => n + (externalDdlByTable.get(t) ?? 0),
      0,
    )

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
      externalDdlCount,
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

// ── The probe ─────────────────────────────────────────────────────────────────

/**
 * How long a human dismissal suppresses this finding for that exact membership.
 *
 * Long on purpose. The condition it reports is slow-moving — a subsystem whose
 * repairs are not holding stays that way for weeks — so a short window would
 * re-raise a decision the owner already made, every tick, forever. That is the
 * "permanent nuisance finding" shape `invariant-probes.ts` names, and the only
 * thing it teaches an owner is to stop reading the queue.
 */
export const DISMISSAL_SUPPRESSION_DAYS = 90

/**
 * Membership snapshots a human has dismissed recently enough to stay silent on.
 *
 * Reaper withdrawals are deliberately NOT suppression. Both land as
 * `status: 'dismissed'`, but the reaper stamps `details.withdrawnBy` and a human
 * dismissal does not — so the marker is the discriminator. Treating a withdrawal
 * as a decision would mean a finding that resolved itself could never be raised
 * again when the condition returned.
 */
async function suppressedMemberships(projectId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - DISMISSAL_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000)
  const rows = await prisma.healthFinding
    .findMany({
      where: {
        projectId,
        type: 'subsystem_repeat_failure',
        status: 'dismissed',
        detectedAt: { gte: since },
      },
      select: { details: true },
      take: 200,
    })
    .catch(() => [] as Array<{ details: unknown }>)

  const out = new Set<string>()
  for (const r of rows) {
    const d = (r.details ?? {}) as Record<string, unknown>
    if (d.withdrawnBy) continue // reaper, not a human decision
    const h = d.membershipHash
    if (typeof h === 'string' && h) out.add(h)
  }
  return out
}

/**
 * Invariant probe: areas whose repairs are not holding.
 *
 * Emits at most one finding per eligible subsystem. `autoFixable` is false and
 * no `fix` closure is attached, so the kernel cannot route this anywhere that
 * would try to repair it — the claim is that repairing is what stopped working.
 *
 * Located by `subsystem:<fingerprint>:<membershipHash>` rather than by table.
 * Putting the membership hash inside the identity is what makes recurrence
 * continuity reset when a table joins or leaves the component: the identity
 * changes, the reaper withdraws the old finding because its gap is no longer
 * detected, and a new one opens against the new membership. No separate reset
 * bookkeeping to get wrong.
 */
export async function detectSubsystemRecurrence(projectId: string): Promise<RawFinding[]> {
  if (!FLAGS.ENABLE_SUBSYSTEM_RECURRENCE_FINDING) return []

  // Cheap pre-check before the expensive path.
  //
  // The full evaluation reads the catalog and six ledgers. This probe runs on
  // every project on every tick, and the gate needs at least
  // SUBSYSTEM_REPAIR_THRESHOLD confirmed repairs to have any chance of firing —
  // so a single indexed count rules out the overwhelming majority of projects
  // before any of that work happens.
  //
  // The count is deliberately loose (it does not check the verification stamp
  // or attribution): being wrong here can only cause the full evaluation to run
  // and find nothing, never cause a finding to be missed.
  const candidateRepairs = await prisma.healthFinding.count({
    where: {
      projectId,
      status: 'auto_fixed',
      fixAppliedAt: { gte: new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000) },
    },
  })
  if (candidateRepairs < SUBSYSTEM_REPAIR_THRESHOLD) return []

  const report = await evaluateSubsystemRecurrence(projectId)
  if (report.firing.length === 0) return []

  const suppressed = await suppressedMemberships(projectId)

  return report.firing
    .filter(s => !suppressed.has(s.membershipHash))
    .map(s => ({
      type: 'subsystem_repeat_failure' as const,
      severity: 'warning' as FindingSeverity,
      autoFixable: false,
      details: {
        location: `subsystem:${s.fingerprint}:${s.membershipHash}`,
        // The table the maintenance planner resolves the subsystem from
        // (lib/autonomy/maintenance/resolve.ts). Without it every real finding
        // was refused as "names no table", so no restructuring plan could ever
        // be built from what this detector writes. The member that took the
        // most confirmed repairs is where the patching concentrated.
        tableName: anchorTable(s.membership, s.confirmedRepairs),
        fingerprint: s.fingerprint,
        membershipHash: s.membershipHash,
        membership: s.membership,
        provenance: s.provenance,
        confirmedRepairCount: s.confirmedRepairs.length,
        distinctGapIdentities: s.distinctGapIdentities,
        repairs: s.confirmedRepairs.map(r => ({ type: r.type, table: r.table, at: r.at })),
        harm: s.independentHarm.map(h => ({ kind: h.kind, detail: h.detail, at: h.at })),
        // Amplifiers, recorded for the reader. Neither took part in the decision.
        changeCount: s.changeCount,
        externalDdlCount: s.externalDdlCount,
        windowDays: report.windowDays,
      },
    }))
}

/** The member with the most confirmed repairs; ties broken by name, for stability. */
function anchorTable(membership: readonly string[], repairs: ReadonlyArray<{ table?: string | null }>): string {
  const counts = new Map<string, number>()
  for (const r of repairs) {
    if (r.table && membership.includes(r.table)) counts.set(r.table, (counts.get(r.table) ?? 0) + 1)
  }
  return [...membership].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))[0]
}

/**
 * The one row this slice writes.
 *
 * An `AuditLog` row, not a `HealthFinding`: shadow means the owner sees nothing
 * and no queue grows. The shape is chosen so the four questions in the module
 * header can be answered by querying this action alone.
 */
/**
 * Enough of one firing case to judge it later without re-deriving it.
 *
 * An earlier version of this recorded membership HASHES only, to keep customer
 * table names out of shared operational data. That was the wrong trade, for a
 * reason worth stating: "the predicate fired at least once" is not evidence
 * that it fired USEFULLY. Five technically-valid but worthless correlations
 * would look identical to five real ones in a bare count, and the decision this
 * telemetry exists to inform is whether to build six more phases.
 *
 * So a firing case carries what a human needs to say "yes, that really was one
 * area whose repairs were not holding" or "no, those four repairs were
 * unrelated". Non-firing components stay aggregate. Firings are rare by
 * construction, so the row stays small, and `AUTONOMY_RECURRENCE_ESCALATED`
 * already records `tableName` to the same log.
 */
export interface FiringEvidence {
  membershipHash: string
  membership: string[]
  provenance: EdgeProvenance
  /** The distinct gaps repaired. The heart of "several DIFFERENT things". */
  gapIdentities: string[]
  repairs: Array<{ type: string; table: string; at: string }>
  harm: Array<{ kind: HarmKind; detail: string; at: string }>
  /** Amplifier, recorded for context. Played no part in the decision to fire. */
  changeCount: number
}

export interface ShadowTelemetry {
  kind: ClusteringKind
  windowDays: number
  noConstraintSkeleton: boolean
  tableCount: number
  componentCount: number
  eligibleComponentCount: number
  /** Components of exactly one table, the statistic views used to distort. */
  singletonComponentCount: number
  largestComponentShare: number
  attributionCoverage: number
  firedCount: number
  firedMemberships: string[]
  /** Inspectable evidence, firing components only. */
  firingEvidence: FiringEvidence[]
  maxConfirmedRepairs: number
  maxDistinctIdentities: number
}

/** Bound on recorded evidence, so one pathological project cannot bloat the log. */
const MAX_EVIDENCE_ITEMS = 10

export function toShadowTelemetry(report: SubsystemRecurrenceReport): ShadowTelemetry {
  return {
    kind: report.kind,
    windowDays: report.windowDays,
    noConstraintSkeleton: report.noConstraintSkeleton,
    tableCount: report.tableCount,
    componentCount: report.componentCount,
    eligibleComponentCount: report.eligibleComponentCount,
    largestComponentShare: Number(report.largestComponentShare.toFixed(3)),
    singletonComponentCount: report.subsystems.filter(s => s.membership.length === 1).length,
    attributionCoverage: Number(report.attributionCoverage.toFixed(3)),
    firedCount: report.firing.length,
    firedMemberships: report.firing.map(f => f.membershipHash),
    firingEvidence: report.firing.slice(0, MAX_EVIDENCE_ITEMS).map(f => ({
      membershipHash: f.membershipHash,
      membership: f.membership,
      provenance: f.provenance,
      gapIdentities: f.distinctGapIdentities,
      repairs: f.confirmedRepairs
        .slice(0, MAX_EVIDENCE_ITEMS)
        .map(r => ({ type: r.type, table: r.table, at: r.at })),
      harm: f.independentHarm
        .slice(0, MAX_EVIDENCE_ITEMS)
        .map(h => ({ kind: h.kind, detail: h.detail, at: h.at })),
      changeCount: f.changeCount,
    })),
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
