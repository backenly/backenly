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

/** Performance-agent finding families (`${category}_${location}` types). */
const PERFORMANCE_REAPABLE_PREFIXES = [
  'unbounded_pagination_',
  'n_plus_one_risk_',
  'missing_index_',
] as const

async function withdraw(
  rows: Array<{ id: string; details: unknown }>,
  marker: 'evolution_reaper' | 'agent_reaper' | 'invariant_reaper',
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

/**
 * Withdraw open/pending performance findings the agent no longer detects.
 * Pass `detected` when a fresh agent run is already in hand (background
 * monitor); otherwise this runs the (deterministic, LLM-free) performance
 * agent itself. Returns the number withdrawn; 0 when the agent skipped or
 * errored — silence must never reap real findings.
 */
export async function reapPerformanceFindings(
  projectId: string,
  detected?: Set<string>,
): Promise<number> {
  let detectedSet = detected
  if (!detectedSet) {
    try {
      const { runPerformanceAgent } = await import('@/lib/ai/agents/performance-agent')
      const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
      const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
      const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        postgresSchema,
      )
      const run = await runPerformanceAgent({ projectId, tables: rows.map(r => r.table_name) })
      if (run.skipped) return 0
      detectedSet = new Set(run.findings.map(f => `${f.category}_${f.location}`))
    } catch {
      return 0
    }
  }

  const open = await prisma.healthFinding.findMany({
    where: {
      projectId,
      status: { in: ['open', 'pending_approval'] },
      OR: PERFORMANCE_REAPABLE_PREFIXES.map(p => ({ type: { startsWith: p } })),
    },
    select: { id: true, type: true, details: true },
  }).catch(() => [] as Array<{ id: string; type: string; details: unknown }>)

  return withdraw(open.filter(f => !detectedSet!.has(f.type)), 'agent_reaper')
}

/**
 * Migration-agent finding families (`${category}_${location}` types, written
 * by storeHealthFindings in background-monitor.ts from migration-agent.ts's
 * DRIFT_CATEGORY_MAP). Deliberately excludes 'missing_index_' and
 * 'missing_rls_' — those prefixes are shared with the performance agent /
 * the bare invariant 'missing_rls' type and are already reaped on their own
 * paths; adding them here would race two different detectors' opinions about
 * the same finding.
 */
const MIGRATION_REAPABLE_PREFIXES = [
  'missing_table_',
  'missing_column_',
  'type_mismatch_',
  'extra_table_',
  'extra_column_',
] as const

/**
 * Withdraw open/pending migration-agent findings (missing_table, missing_column,
 * type_mismatch, extra_table, extra_column) the schema-drift detector no
 * longer supports. Pass `detected` when a fresh migration-agent run is
 * already in hand (background monitor); otherwise this runs detectSchemaDrift
 * itself.
 *
 * detectSchemaDrift swallows its own errors into an empty report indistinguishable
 * from "genuinely no drift" (same shape, no error field) — UNLESS it never found a
 * snapshot to compare against, in which case `report.snapshotVersion` is absent.
 * `snapshotVersion` is present ONLY on the real success path, so it doubles as the
 * "this scan actually compared against something" signal this reaper needs: without
 * it we cannot tell a clean scan from a silent failure, and reaping on that
 * ambiguity risks withdrawing real findings the probe simply failed to re-detect.
 *
 * This is what was missing for the class of finding a project's own load-test /
 * fuzz harness leaves behind: it builds tables through the AI (captured in a
 * snapshot), drops them when the run ends, and nothing ever re-baselines the
 * snapshot — so `missing_table_<name>` sat open forever with no path back to
 * healthy, inflating "needs attention" counts the reconciler's own invariant
 * probes never touch (this is a different detector entirely).
 */
export async function reapMigrationFindings(
  projectId: string,
  detected?: Set<string>,
): Promise<number> {
  let detectedSet = detected
  if (!detectedSet) {
    try {
      const { detectSchemaDrift } = await import('@/lib/ai/schema-reconciler')
      const report = await detectSchemaDrift(projectId)
      if (report.snapshotVersion === undefined) return 0 // no confirmed clean compare
      // Mirror migration-agent.ts's own location join exactly (tableName, or
      // tableName.columnName for column-level drift) — the persisted finding
      // type is `${category}_${location}`, so a mismatched join here would
      // silently never match a real row.
      detectedSet = new Set(
        report.drifts.map(d => `${d.type}_${[d.tableName, d.columnName].filter(Boolean).join('.')}`),
      )
    } catch {
      return 0
    }
  }

  const open = await prisma.healthFinding.findMany({
    where: {
      projectId,
      status: { in: ['open', 'pending_approval'] },
      OR: MIGRATION_REAPABLE_PREFIXES.map(p => ({ type: { startsWith: p } })),
    },
    select: { id: true, type: true, details: true },
  }).catch(() => [] as Array<{ id: string; type: string; details: unknown }>)

  return withdraw(open.filter(f => !detectedSet!.has(f.type)), 'agent_reaper')
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
 * detectAuthSpike, detectDeployFailure, checkIntegrationHealth,
 * detectContractViolations) and by no other pipeline — verified by grepping
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
  'contract_surface_broken',
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
): Promise<{ arch: number; performance: number; drift: number; invariants: number; migration: number }> {
  const [arch, performance, drift, invariants, migration] = await Promise.all([
    reapArchFindings(projectId).catch(() => 0),
    reapPerformanceFindings(projectId).catch(() => 0),
    // Open-loop drift: withdraw external_schema_change once nothing is pending
    // (adopted or ignored) — the claim no longer describes current state.
    import('@/lib/autonomy/drift-watch')
      .then(m => m.reapDriftFindings(projectId))
      .catch(() => 0),
    reapInvariantFindings(projectId).catch(() => 0),
    reapMigrationFindings(projectId).catch(() => 0),
  ])
  return { arch, performance, drift, invariants, migration }
}
