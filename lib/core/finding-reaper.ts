/**
 * FINDING REAPER — the one kernel for withdrawing stale health findings.
 * =====================================================================
 * A finding is a claim about CURRENT state. When the evidence stops supporting
 * it (rows shrank, an index landed, a heuristic was corrected, the project
 * regressed a stage), the row must be withdrawn — otherwise it sits in
 * "Waiting on you" / Backend health forever, contradicting the platform.
 *
 * Why a shared kernel: reap logic used to live inline in three writers with
 * three different cadences — workspace-observer (on-demand + cron),
 * architecture-evolution (6h cron / post-build), background-monitor
 * (plan-cadence-gated, 24h on Free). The user-facing Re-scan button only runs
 * the observer, so arch/performance ghosts survived a manual re-scan for up to
 * a day. Every scan path now calls this kernel; it is deterministic SQL only
 * (no LLM), so it is safe and cheap to run on every scan.
 *
 * Withdrawn rows get status 'dismissed' + details.withdrawnBy so they are
 * distinguishable from user dismissals: withdrawn types MAY be re-created when
 * the condition genuinely returns; user-dismissed types never re-nag.
 */

import { prisma } from '@/lib/db/prisma'
import { builtEvidenceWhere } from '@/lib/projects/backend-presence'

export type WithdrawnBy =
  | 'evolution_reaper'
  | 'agent_reaper'
  | 'invariant_reaper'
  | 'detector_retired'
  | 'not_built'
  | 'platform_fault'
  | 'locked_down'
  | 'paused'
  // The workspace observer's own checks no longer see the problem: a workflow
  // that is whole again, a foreign key that now exists (or a column that is
  // gone or was never a key), a verification scenario that passes. Backenly did
  // not repair these, so they are withdrawn, never recorded as its fixes.
  | 'workflow_reaper'
  | 'fk_reaper'
  | 'verification_reaper'
  // A live probe of the surface answers correctly again (contract-verifier.ts).
  | 'contract_reaper'

/**
 * Close findings whose condition is gone without Backenly repairing it:
 * `condition_cleared` in lib/autonomy/resolution.ts, never a fix. Exported as
 * `withdrawFindings` for the writers that reap inline.
 */
async function withdraw(
  rows: Array<{ id: string; details: unknown }>,
  marker: WithdrawnBy,
): Promise<number> {
  let withdrawn = 0
  for (const row of rows) {
    await prisma.healthFinding.update({
      where: { id: row.id },
      data: {
        status: 'dismissed',
        details: {
          ...((row.details as Record<string, unknown> | null) ?? {}),
          withdrawnBy: marker,
          withdrawnAt: new Date().toISOString(),
        } as any,
      },
    }).then(() => { withdrawn++ }).catch(() => {})
  }
  return withdrawn
}

export { withdraw as withdrawFindings }

/**
 * Withdraw what the agent orchestrator filed (rows carrying `details.agentType`),
 * now that it no longer runs (docs/autonomy-orchestrator-parity.md). The real
 * problems among them are found by the canonical detectors, which file their
 * own findings; the rest were not real problems.
 *
 * A finding someone already acted on stays listed, because withdrawing it would
 * erase that: one a repair touched (`appliedUnverified`, `rollbackData`) and one
 * a person approved (a HEALTH_FIX_APPROVED audit row naming it). Summaries label
 * those as coming from a retired check (lib/core/finding-summaries.ts).
 *
 * This replaces the two reapers that withdrew orchestrator findings the agents
 * no longer detected; with the agents gone, nothing would ever re-detect them.
 * Idempotent: a second run finds nothing to withdraw. A run that withdraws
 * anything records one audit row with what it withdrew and what it kept.
 */
export async function retireOrchestratorFindings(
  projectId: string,
): Promise<{ withdrawn: number; kept: number }> {
  const live = await prisma.healthFinding.findMany({
    where: { projectId, status: { in: ['open', 'pending_approval'] } },
    select: { id: true, type: true, details: true },
  })
  const filed = live.filter(
    (f) => typeof (f.details as Record<string, unknown> | null)?.agentType === 'string',
  )
  if (filed.length === 0) return { withdrawn: 0, kept: 0 }

  const approvals = await prisma.auditLog.findMany({
    where: { projectId, action: 'HEALTH_FIX_APPROVED' },
    select: { details: true },
  })
  const approved = new Set<string>()
  for (const a of approvals) {
    try {
      const id = (JSON.parse(a.details ?? '{}') as { findingId?: unknown }).findingId
      if (typeof id === 'string') approved.add(id)
    } catch { /* free-text legacy row */ }
  }

  const actedOn = (f: { id: string; details: unknown }) => {
    const d = (f.details ?? {}) as Record<string, unknown>
    return d.appliedUnverified != null || d.rollbackData != null || approved.has(f.id)
  }
  const retire = filed.filter((f) => !actedOn(f))
  const kept = filed.length - retire.length
  const withdrawn = await withdraw(retire, 'detector_retired')

  if (withdrawn > 0) {
    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'AUTONOMY_DETECTOR_RETIRED',
        type: 'autonomy',
        details: JSON.stringify({
          withdrawn,
          kept,
          types: [...new Set(retire.map((f) => f.type))].slice(0, 25),
          findingIds: retire.map((f) => f.id).slice(0, 100),
        }),
        timestamp: new Date(),
      },
    }).catch(() => {})
  }
  return { withdrawn, kept }
}

/**
 * Withdraw open `coevo_*` findings (lib/ai/frontend-coevolution.ts — frontend
 * usage patterns inferred to need a schema change) the caller's fresh
 * analysis no longer supports. The caller passes the exact `detected` set it
 * is about to persist from (same `coevo_${gapType}_${tableName}_${fieldName}`
 * / `coevo_${sigType}_${tableName}` construction as the writer), so this
 * costs no extra queries.
 *
 * `cleanScan`: analyzeCoevolutionGaps / analyzeAuditLogSignals both swallow
 * internal errors into the same empty shape a genuine "not enough signal yet"
 * result returns, so the caller can only pass a partial safety signal
 * (enough telemetry events existed to reach real analysis, promises did not
 * throw) — this reaper trusts that signal as-is rather than re-deriving a
 * stronger one, since a wrong reap here withdraws a low-stakes advisory
 * finding, not a security/data-integrity one.
 */
export async function reapCoevolutionFindings(
  projectId: string,
  detected: Set<string>,
  cleanScan: boolean,
): Promise<number> {
  if (!cleanScan) return 0

  const open = await prisma.healthFinding.findMany({
    where: { projectId, status: { in: ['open', 'pending_approval'] }, type: { startsWith: 'coevo_' } },
    select: { id: true, type: true, details: true },
  }).catch(() => [] as Array<{ id: string; type: string; details: unknown }>)
  if (open.length === 0) return 0

  return withdraw(open.filter(f => !detected.has(f.type)), 'agent_reaper')
}

/**
 * Withdraw open/pending arch_* proposals the current evidence no longer
 * supports (deterministic re-run of the evolution engine's evidence pass).
 */
export async function reapArchFindings(projectId: string): Promise<number> {
  const { computeValidArchTypes, withdrawUnsupportedArchFindings } =
    await import('@/lib/ai/architecture-evolution')
  const valid = await computeValidArchTypes(projectId)
  return withdrawUnsupportedArchFindings(projectId, valid)
}

/**
 * Finding types whose canonical detector is a desired-state invariant probe —
 * i.e. `computeDesiredStateDiff` re-derives the SAME type from the SAME live
 * state on every tick, so its absence from a clean run is ground truth.
 *
 * `missing_api_definition` is deliberately NOT here even though it is one of
 * the base INVARIANTS' fix targets: `detectTablesWithNoApiDefinition` (the
 * `every_table_has_an_api` probe) always returns `[]` under PostgREST —
 * exposure is decided by the catalog/grants, not by this probe (see the note
 * in lib/core/drift-detector.ts). Every real `missing_api_definition` finding
 * in production comes from lib/core/ai-report-to-health-findings.ts, a
 * separate AI-report pipeline this reaper never re-runs. Including the type
 * here would make every one of those findings vanish on the next autonomy
 * tick, mistaking "the invariant probe doesn't emit this" for "the gap
 * closed". Also excluded for the same reason: orphan_table, integrations,
 * deploys, performance `${category}_${location}` families, and
 * external_schema_change (which owns its own adopted/ignored reaper).
 *
 * `workflow_broken` WAS excluded alongside them, and that was wrong. The
 * exclusion applies to types whose probe cannot testify — `missing_api_crud`'s
 * sibling probe is a stub returning `[]`, so its silence proves nothing. But
 * `verifyWorkflows` IS the `declared_workflows_still_work` invariant probe, it
 * is the ONLY producer of this type, and it reports current state on every
 * tick — exactly the criterion above. A reap did exist for it, but only inside
 * `runObserverForProject`, which is the DAILY cron. So a workflow finding that
 * had genuinely healed sat in "Waiting on you" for up to 24 hours while the
 * dashboard next to it said the loop checks every minute. Reaping it here puts
 * the withdrawal on the same cadence as the claim.
 */
const INVARIANT_REAPABLE_TYPES = [
  // Withdraws when repairs stop recurring in that area, and ALSO when the
  // component's membership changes: the identity carries a membership hash, so
  // a table joining or leaving produces a different gap and leaves the old
  // finding undetected. That is the continuity reset, implemented by the reaper
  // rather than by separate bookkeeping.
  'subsystem_repeat_failure',
  'workflow_broken',
  'missing_rls',
  'unprotected_user_data',
  'rls_expression_invalid',
  'missing_fk',
  'missing_fk_index',
  'missing_api_crud',
  'dead_api_endpoint',
  'shadow_mutation',
  'auth_jwt_missing',
  'auth_users_table_missing',
  'oauth_redirect_uri_missing',
  'realtime_gap',
  'missing_archival_job',
  'missing_token_cleanup_cron',
  'runtime_engine_mismatch',
  // Registered here the moment `tables_are_not_bloated` joined the invariant
  // catalogue. A probe in that catalogue whose type is missing from this list is
  // a finding the loop can raise every minute and only withdraw once a day —
  // so a table vacuumed by autovacuum three seconds later keeps a stale row in
  // the review queue until the next infra scan.
  'infra_table_bloat',
  // Registered alongside `service_role_keys_stay_server_side`. This one MUST be
  // reapable rather than left to age out: the probe is the sole writer, and its
  // evidence is a rolling 24h window of refused requests plus a live re-read of
  // the key. An owner who rotates the key has fixed the problem in that instant,
  // and without a reap entry the critical would sit in their queue for the rest
  // of the day — telling them, on the strength of yesterday's traffic, that a key
  // they already revoked is still exposed.
  'service_role_key_exposed',
  // Its probe reads live planner statistics, so it reports current state on
  // every tick and its silence is meaningful. An owner who runs the stated
  // migration has their finding withdrawn on the next pass rather than looking
  // at advice they already took.
  'schema_design_defect',
  // Its probe re-reads live statistics every tick, so once the index exists the
  // candidate fails the not-already-indexed filter and the finding withdraws
  // itself. Without an entry here the owner would keep seeing a slow-query
  // warning for a query the loop had already fixed.
  'slow_query_missing_index',
  // Registered with the probe that emits it. Its evidence is a live catalog
  // read plus an observation ledger, so an index the owner drops themselves —
  // or one that finally gets used — disappears on the next pass. Without an
  // entry here a "never used" finding would outlive the index it names.
  'unused_index',
  // Its probe reads pg_stat_activity live, so a committed or closed session
  // clears the finding on the next tick rather than leaving the owner chasing a
  // connection that is already gone.
  'idle_in_transaction',
  // Its probe re-measures whenever the index size changes, so a successful
  // REINDEX clears the finding on the next tick instead of leaving the owner
  // looking at bloat that has already been reclaimed.
  'index_bloat',
  // Its probe compares the intent ledger to the live catalog on every tick, so
  // a column the owner migrates back into shape clears on the next pass.
  'intent_drift',
  // Its probe judges the most recent complete hour against the trailing window,
  // so a subject that returns to normal stops being reported on the next hour
  // and the finding withdraws itself. Without this a one-hour spike would sit in
  // the queue forever describing a backend that recovered.
  'behavioural_regression',
  // Every one of its three shapes is read live from the catalog or from
  // pg_prepared_xacts, so a rebuilt index, a validated constraint or a
  // resolved transaction clears the finding on the next tick.
  'migration_residue',
  // Both were probe-covered by the invariant catalogue and named in NO reaper,
  // so neither had any path back to healthy. Each has exactly one write site,
  // and that write site IS the invariant probe, so this reaper is the correct
  // owner and cannot delete another pipeline's findings:
  //
  //   schema_not_registered  ← lib/autonomy/schema-registration.ts
  //                            (the data_plane_is_registered probe)
  //   rls_denies_everything  ← lib/services/workspace-observer.ts
  //                            (the rls_is_not_deny_all probe)
  //
  // Both are auto-rated, so they normally repair rather than linger — but a fix
  // that fails parks the row in pending_approval, and with no reaper it stayed
  // there permanently even once the condition had cleared. schema_not_registered
  // is the one that matters most: it means a customer's entire /db/* plane is
  // dead, and the row outliving the outage is how a resolved incident keeps
  // showing as broken.
  'schema_not_registered',
  'rls_denies_everything',
] as const

/**
 * Withdraw open/pending invariant findings whose gap the probes no longer
 * detect. This is what clears a finding whose TARGET disappeared — a dropped
 * table's `rls_expression_invalid` row otherwise sits in "Waiting on you"
 * forever (prod 2026-07-20: nine findings on dropped harness tables survived
 * every scan, and approving them just re-failed into the same queue).
 *
 * Pass `report` when a fresh diff is already in hand (the reconciler computes
 * one every tick) — otherwise this runs the probes itself.
 *
 * Safety: if ANY probe errored this pass, reap nothing. Unknown state is not
 * "resolved", and we cannot tell which types the failed probe owns.
 */
export async function reapInvariantFindings(
  projectId: string,
  report?: import('@/lib/autonomy/desired-state').DesiredStateReport,
): Promise<number> {
  const { computeDesiredStateDiff, gapIdentity } = await import('@/lib/autonomy/desired-state')
  const current = report ?? await computeDesiredStateDiff(projectId)
  if (current.errors.length > 0) return 0

  const detected = new Set(
    current.violations.map(v => gapIdentity(v.type, v.details as Record<string, unknown>)),
  )

  const open = await prisma.healthFinding.findMany({
    where: {
      projectId,
      status: { in: ['open', 'pending_approval'] },
      type: { in: INVARIANT_REAPABLE_TYPES as unknown as string[] },
    },
    select: { id: true, type: true, details: true },
  }).catch(() => [] as Array<{ id: string; type: string; details: unknown }>)

  const stale = open.filter(
    f => !detected.has(gapIdentity(f.type, (f.details ?? {}) as Record<string, unknown>)),
  )
  return withdraw(stale, 'invariant_reaper')
}

/**
 * Static finding types written exclusively by workspace-observer.ts's own
 * detectors (detectOrphanTables, detectApiDrift, detectBrokenWebhooks,
 * detectAuthSpike, detectDeployFailure, checkIntegrationHealth) and by no
 * other pipeline — verified by grepping
 * every `type: '<value>'` write site in the codebase before adding an entry
 * here. Getting this wrong in either direction is a real bug: omit a type
 * and it ghosts forever like the RLS/migration findings did; include a type
 * another pipeline also writes and this reaper will silently delete THEIR
 * findings out from under them (almost happened here with 'missing_api_definition'
 * and 'verification_failed', both excluded on purpose — see below).
 *
 * Deliberately excludes:
 *   - every type covered by desired-state.ts's INVARIANTS (missing_rls,
 *     missing_fk, missing_fk_index, shadow_mutation, auth_jwt_missing,
 *     auth_users_table_missing, oauth_redirect_uri_missing, rls_expression_invalid,
 *     missing_api_crud, dead_api_endpoint, realtime_gap) — already reaped by
 *     reapInvariantFindings; adding them here would just do the same work twice.
 *   - 'workflow_broken' — already has its own resolve-on-heal block above,
 *     tied to verifyWorkflows' own re-detection, not this generic sweep.
 *   - 'verification_failed' — already has its own resolve-on-pass block,
 *     keyed by scenarioId rather than table location.
 *   - 'missing_api_definition' — LOOKS like it belongs to detectTablesWithNoApiDefinition,
 *     but that probe is a permanent no-op under PostgREST (see the note in
 *     drift-detector.ts); every real finding of this type comes from the
 *     separate lib/core/ai-report-to-health-findings.ts pipeline instead.
 *   - 'contract_surface_broken' — written and resolved only by the contract
 *     sweep now. The observer no longer probes it, so listing it here would
 *     withdraw every live sweep finding as "not detected" on each observer run.
 */
const OBSERVER_LOCATABLE_REAPABLE_TYPES: ReadonlySet<string> = new Set([
  'orphan_table',
  'api_drift',
  'broken_webhook',
  'auth_spike',
  'deploy_failure',
  'integration_key_invalid',
  'integration_webhook_failing',
  'integration_smtp_unreachable',
  'oauth_config_invalid',
  'integration_connected_unused',
])

/**
 * Withdraw stale findings from workspace-observer's own detector sweep, using
 * the SAME fresh results the calling scan already computed this tick — no
 * extra probe queries. The observer runs 14 detectors in one pass and had
 * this generic version of this fix (self-healing when the underlying issue
 * clears) for exactly one of them, `workflow_broken`; every other type in
 * OBSERVER_LOCATABLE_REAPABLE_TYPES had no path back to healthy at all.
 *
 * `cleanScan` mirrors the contract of every other reaper here: only trust
 * "not currently detected" when nothing failed this pass. workspace-observer
 * isolates each detector's own failure (Promise.allSettled), so pass
 * `result.errors.length === 0` from the caller.
 */
export async function reapObserverFindings(
  projectId: string,
  detected: Set<string>,
  cleanScan: boolean,
): Promise<number> {
  if (!cleanScan) return 0

  const open = await prisma.healthFinding.findMany({
    where: {
      projectId,
      status: { in: ['open', 'pending_approval'] },
      type: { in: Array.from(OBSERVER_LOCATABLE_REAPABLE_TYPES) },
    },
    select: { id: true, type: true, details: true },
  }).catch(() => [] as Array<{ id: string; type: string; details: unknown }>)
  if (open.length === 0) return 0

  const { gapIdentity } = await import('@/lib/autonomy/desired-state')
  const stale = open.filter(
    f => !detected.has(gapIdentity(f.type, (f.details ?? {}) as Record<string, unknown>)),
  )
  return withdraw(stale, 'agent_reaper')
}

/**
 * Run every reap family. Called at the end of each observer scan — including
 * the user-facing Re-scan — so one button clears everything stale at once.
 * Best-effort per family; a failure in one never blocks the other.
 */
export async function reapStaleFindings(
  projectId: string,
): Promise<{ arch: number; retired: number; drift: number; invariants: number }> {
  const [arch, retired, drift, invariants] = await Promise.all([
    reapArchFindings(projectId).catch(() => 0),
    // What the retired agent orchestrator filed, so a Re-scan clears it too.
    retireOrchestratorFindings(projectId).then(r => r.withdrawn).catch(() => 0),
    // Open-loop drift: withdraw external_schema_change once nothing is pending
    // (adopted or ignored) — the claim no longer describes current state.
    import('@/lib/autonomy/drift-watch')
      .then(m => m.reapDriftFindings(projectId))
      .catch(() => 0),
    reapInvariantFindings(projectId).catch(() => 0),
  ])
  return { arch, retired, drift, invariants }
}

/**
 * Withdraw, fleet-wide, every open finding that no longer describes something
 * a tenant can act on. Run at the start of each contract sweep, so it is
 * self-cleaning on every deployment and needs no one-off script.
 *
 *   not_built        Every open finding on a project with nothing built. A
 *                    project that was only named has nothing that can be wrong,
 *                    and the observer no longer scans one. This is what clears
 *                    the rows the ungated first-load scan used to write.
 *   platform_fault   Contract rows with `surface: 'runtime'`. That shape meant
 *                    "the monitor could not reach the platform". The sweep
 *                    reports that to the operator now and never files it.
 *   locked_down      Contract rows on a locked-down project. It refuses traffic
 *                    by design, so a refusal is the lockdown working.
 *   paused           Contract rows on a paused project, for the same reason.
 *
 * Deleted projects are left alone; their rows cascade with them.
 */
export async function reapUnattributableFindings(): Promise<{
  notBuilt: number
  platformFault: number
  lockedDown: number
  paused: number
}> {
  const open = { in: ['open', 'pending_approval'] }

  const [unbuilt, runtimeRows, lockedRows, pausedRows] = await Promise.all([
    prisma.healthFinding.findMany({
      where: { status: open, project: { deletedAt: null, NOT: builtEvidenceWhere() } },
      select: { id: true, details: true },
    }),
    prisma.healthFinding.findMany({
      where: {
        status: open,
        type: 'contract_surface_broken',
        details: { path: ['surface'], equals: 'runtime' },
      },
      select: { id: true, details: true },
    }),
    prisma.healthFinding.findMany({
      where: {
        status: open,
        type: 'contract_surface_broken',
        project: { lockedDownAt: { not: null } },
      },
      select: { id: true, details: true },
    }),
    prisma.healthFinding.findMany({
      where: {
        status: open,
        type: 'contract_surface_broken',
        project: { pausedAt: { not: null } },
      },
      select: { id: true, details: true },
    }),
  ])

  const seen = new Set<string>()
  const once = (rows: Array<{ id: string; details: unknown }>) =>
    rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))

  const notBuilt = await withdraw(once(unbuilt), 'not_built')
  const platformFault = await withdraw(once(runtimeRows), 'platform_fault')
  const lockedDown = await withdraw(once(lockedRows), 'locked_down')
  const paused = await withdraw(once(pausedRows), 'paused')
  return { notBuilt, platformFault, lockedDown, paused }
}
