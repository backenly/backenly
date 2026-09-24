/**
 * WORKSPACE OBSERVER
 * ==================
 * The central health-check loop for the platform's "Runs Itself" pillar.
 *
 * Runs once a day (scheduled in instrumentation.ts) AND is triggered
 * immediately by schema changes, fix attempts, and deployment failures via
 * the event bus (lib/events/bus.ts). Only projects with something built are
 * ever scanned; see lib/projects/backend-presence.ts.
 *
 * Per project it:
 *   1. Loads the latest WorkspaceSchemaSnapshot
 *   2. Captures current live state from PostgreSQL (RLS, FKs, orphan tables,
 *      API drift, webhook health, auth error rate)
 *   3. Classifies each finding as safe-to-auto-fix or risky (needs approval)
 *   4. Executes safe fixes inline
 *   5. Writes HealthFinding records for everything found
 *   6. Sends a PlatformNotification for critical findings
 */

import { prisma } from '@/lib/db/prisma'
import { detectSubsystemRecurrence } from '@/lib/autonomy/subsystem-recurrence'
import { probeQueryFailed } from '@/lib/core/drift-detector'
import { queryWorkspaceSchema, executeInWorkspaceSchema } from './workspaceDatabase'
import { applyPermissionPolicy } from './workspace-rls'
import {
  loadOwnershipCatalog,
  inferRlsPlanFromCatalog,
  severityForPlan,
  exposureReason,
} from './rls-ownership'
import { notReservedTableSql, isReservedWorkspaceTable } from '@/lib/security/workspace-schema'
import { createPlatformNotification } from '@/lib/notifications/platform'
import { summariseFinding } from '@/lib/core/finding-summaries'
import {
  detectFkColumnsMissingConstraints,
  detectTablesWithNoApiDefinition,
  detectShadowMutations,
  detectMissingFkIndexes,
  checkAuthIntegrity,
  detectApiCoverageGaps,
} from '@/lib/core/drift-detector'
import { checkIntegrationHealth } from '@/lib/core/integration-health'
import { verifyWorkflows } from '@/lib/core/workflow-verifier'
import {
  runContractVerification,
  probePlatformIngress,
  attributeContractFailures,
  settleTenantContract,
  type ProjectProbeOutcome,
} from '@/lib/services/contract-verifier'
import { isDataPlaneOutage } from '@/lib/core/fix-actions'
import { reportPlatformFault, type PlatformFaultReport } from '@/lib/autonomy/platform-faults'
import { reapUnattributableFindings } from '@/lib/core/finding-reaper'
import { recordContractSweepResult } from '@/lib/autonomy/data-plane-liveness'
import { writeFixHistory, checkEscalation, buildResolutionText } from '@/lib/memory/fix-history'
import { generateFixPlansFromRawFindings, type FixPlan } from '@/lib/core/fix-plan-generator'
import { runBuiltInVerification, type VerificationExecutionResult } from '@/lib/verification/verification-executor'
import { FLAGS } from '@/lib/config/flags'
import { watchableProjectsWhere, isWatchableProject } from '@/lib/projects/backend-presence'

// ─── Types ───────────────────────────────────────────────────────────────────

// Re-export from shared types so existing imports keep working
export type { FindingType, FindingSeverity, FindingStatus, RawFinding } from '@/lib/core/types'
import type { FindingType, FindingSeverity, FindingStatus, RawFinding } from '@/lib/core/types'

export interface ObserverResult {
  projectId: string
  scannedAt: string
  findingsDetected: number
  autoFixed: number
  pendingApproval: number
  critical: number
  errors: string[]
  /** Phase 12 — populated when ENABLE_AUTO_FIX_PLANNER is on */
  fixPlans?: FixPlan[]
  /** Phase 13 — populated when ENABLE_VERIFICATION_EXECUTION + ENABLE_SAFE_VERIFICATION_MODE are on */
  verificationResult?: VerificationExecutionResult
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run the full observer pipeline for every project whose runtime is reachable.
 * Called by the daily cron (00:10 UTC, instrumentation.ts) and by
 * runObserverForProject for event-driven runs.
 *
 * Deliberately NOT gated on `isDeployed`. That flag is platform bookkeeping —
 * it records whether the user ran the deploy flow. It does not gate serving:
 * `/api/v1/{projectId}/auth/*` and `/db/*` answer for any project with tables
 * and an anonKey, deployed or not (only the `/v1/{projectId}` info route and
 * healthz consult it). Gating the observer on it meant a project could take
 * real end-user signups while never being probed again after its first
 * event-driven scan — the platform serving traffic it had stopped watching.
 * Probing must cover exactly what serves, so the gate is "something was
 * built" (watchableProjectsWhere), the same one every entry point asks.
 */
export async function runWorkspaceObserver(): Promise<{
  processed: number
  results: ObserverResult[]
  errors: string[]
}> {
  const projects = await prisma.project.findMany({
    where: watchableProjectsWhere(),
    select: { id: true, userId: true },
  })

  const results: ObserverResult[] = []
  const topLevelErrors: string[] = []

  // Process concurrently with a concurrency cap to avoid overwhelming the DB
  const CONCURRENCY = 5
  for (let i = 0; i < projects.length; i += CONCURRENCY) {
    const batch = projects.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map((p) => runObserverForProject(p.id))
    )
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
      } else {
        topLevelErrors.push(String(outcome.reason?.message ?? outcome.reason))
      }
    }
  }

  return { processed: projects.length, results, errors: topLevelErrors }
}

/**
 * Contract-only sweep: probe every watchable project's live API surfaces and
 * persist the results. Runs far more often than the full observer.
 *
 * Split out because the two have opposite cost profiles. The full observer
 * does deep schema, RLS, drift and workflow analysis — dozens of workspace
 * queries per project, minutes of work, fine once a day. It is deterministic:
 * nothing in this module or its dependencies calls a model, so its cost is DB
 * time, not tokens. (An earlier version of this note said "LLM-backed"; that
 * was never true of this path and it misled a cost investigation.)
 * The contract probes are five HTTP calls, ~1s per project, and
 * they are the only detector that answers "is this backend answering its
 * users right now?". At daily cadence a total outage could run 24 hours
 * before anything noticed; that is the gap that let a signup outage last
 * sixty days. Cheap checks belong on a cheap-check schedule.
 *
 * This is the ONLY writer and resolver of `contract_surface_broken`, and it
 * judges nobody until it has seen everybody:
 *
 *   1. withdraw rows that no longer describe a tenant fault
 *   2. check the ingress once; if it is not there, report the platform and stop
 *   3. probe every watchable project
 *   4. attribute each failure (lib/services/contract-verifier.ts)
 *   5. report platform faults to the operator, heal the shared data plane if
 *      that is what failed, and settle each project with only its own failures
 *
 * It never notifies a tenant. A contract failure reaches the owner through the
 * Autonomy queue, and only when it is theirs.
 */
export async function runContractSweep(options: {
  /**
   * Narrow the pass to these projects (still only the watchable ones). For an
   * operator re-checking specific projects, and for tests. Fleet attribution
   * then compares within this set only.
   */
  projectIds?: string[]
} = {}): Promise<{
  processed: number
  broken: number
  errors: string[]
  platformFaults: PlatformFaultReport[]
}> {
  const errors: string[] = []
  const platformFaults: PlatformFaultReport[] = []
  let broken = 0

  await reapUnattributableFindings().catch((err: any) => {
    errors.push(`[reap] ${err?.message ?? String(err)}`)
  })

  const projects = await prisma.project.findMany({
    where: options.projectIds
      ? { id: { in: options.projectIds }, ...watchableProjectsWhere() }
      : watchableProjectsWhere(),
    select: { id: true },
  })
  if (projects.length === 0) return { processed: 0, broken, errors, platformFaults }

  const ingress = await probePlatformIngress()
  if (!ingress.ok) {
    // Nothing is probed, resolved or heartbeated. Liveness goes stale and
    // reads "unknown" after the heartbeat window, which is the truth.
    const fault: PlatformFaultReport = {
      kind: 'ingress_unreachable',
      detail: ingress.detail,
      origin: ingress.origin,
      projectIds: projects.map(p => p.id),
    }
    reportPlatformFault(fault)
    platformFaults.push(fault)
    return { processed: 0, broken, errors, platformFaults }
  }

  const CONCURRENCY = 5
  const outcomes: ProjectProbeOutcome[] = []
  for (let i = 0; i < projects.length; i += CONCURRENCY) {
    const batch = projects.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (p) => ({ projectId: p.id, results: await runContractVerification(p.id) })),
    )
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') outcomes.push(outcome.value)
      else errors.push(String(outcome.reason?.message ?? outcome.reason))
    }
  }

  const attribution = attributeContractFailures(outcomes)

  for (const f of attribution.platformFaults) {
    const fault: PlatformFaultReport = {
      kind: f.kind,
      detail: f.detail,
      surface: f.surface,
      status: f.status,
      projectIds: f.projectIds,
      origin: ingress.origin,
    }
    reportPlatformFault(fault)
    platformFaults.push(fault)
  }

  // The data plane is shared. When it fails for everyone, the repair is a
  // platform action taken once, not a finding per tenant. healDataPlane is
  // single-flighted and re-verifies against its own PostgREST probe before it
  // restarts anything.
  const dataPlaneDown = attribution.platformFaults.some(
    f =>
      f.kind === 'surface_failing_fleetwide' &&
      isDataPlaneOutage({ surface: f.surface, httpStatus: f.status === 'timeout' ? null : f.status ?? null }),
  )
  if (dataPlaneDown) {
    try {
      const { healDataPlane, describeHeal } = await import('@/lib/postgrest/supervisor')
      const heal = await healDataPlane(null)
      if (!heal.healthy) errors.push(`[data-plane heal] ${describeHeal(heal)}`)
    } catch (err: any) {
      errors.push(`[data-plane heal] ${err?.message ?? String(err)}`)
    }
  }

  for (let i = 0; i < outcomes.length; i += CONCURRENCY) {
    const batch = outcomes.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async ({ projectId, results }) => {
        const findings = await settleTenantContract(
          projectId,
          results,
          attribution.tenantBroken.get(projectId) ?? [],
        )

        // The heartbeat, written on every pass whose outcome is KNOWN.
        //
        // Before it existed a clean sweep recorded nothing, so "no open
        // contract_surface_broken finding" was ambiguous between "verified
        // answering" and "never checked", and reading the second as the first
        // is how detectMissingRls reported green while dead. A surface the
        // platform could not settle this pass is unknown, not healthy, so that
        // project gets no heartbeat and its liveness goes stale rather than
        // green. Written before the findings so a failure while writing them
        // still leaves an accurate record of when the probe last ran.
        if (!attribution.unknown.has(projectId)) {
          await recordContractSweepResult(
            projectId,
            findings.map(f => String((f.details as Record<string, unknown>)?.surface ?? 'unknown')),
          )
        }

        for (const finding of findings) {
          // Most broken surfaces are symptoms whose cause is outside this
          // project's schema (process down, route unmounted, proxy
          // misconfigured), and those go straight to a human rather than
          // getting an invented repair.
          //
          // The data-plane shape carries a real `fix` (see contract-verifier),
          // and this sweep is the path that runs OFTEN — hardcoding
          // `pending_approval` here meant the frequent probe could only ever
          // file the finding, never act on it, so the one detector that notices
          // an outage within a minute was also the one that could not heal it.
          if (finding.autoFixable && finding.fix) {
            try {
              await finding.fix()
              await writeFinding(projectId, finding, 'auto_fixed', true, new Date())
            } catch (err: any) {
              finding.details.fixError = err?.message ?? String(err)
              await writeFinding(projectId, finding, 'pending_approval', false)
            }
          } else {
            await writeFinding(projectId, finding, 'pending_approval', false)
          }
        }
        return findings.length
      }),
    )
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') broken += outcome.value
      else errors.push(String(outcome.reason?.message ?? outcome.reason))
    }
  }

  if (broken > 0 || errors.length > 0 || platformFaults.length > 0) {
    console.warn(
      `[ContractSweep] ${projects.length} projects | ${broken} tenant surfaces broken | ` +
      `${platformFaults.length} platform faults | ${errors.length} scan errors`,
    )
  }

  return { processed: outcomes.length, broken, errors, platformFaults }
}

/**
 * Run the observer for a single project.
 * Safe to call repeatedly — findings are de-duplicated by type+status.
 */
export async function runObserverForProject(projectId: string): Promise<ObserverResult> {
  const result: ObserverResult = {
    projectId,
    scannedAt: new Date().toISOString(),
    findingsDetected: 0,
    autoFixed: 0,
    pendingApproval: 0,
    critical: 0,
    errors: [],
  }

  // Nothing built means nothing can be wrong. This is the only gate, and it is
  // here rather than at the callers because five of them reach this function
  // (the dashboard's first-load kick, Re-scan, the event bus, the cron route
  // and the daily sweep) and the one that did not check is the one that
  // emailed a customer about a project they had only named. Not stamping
  // lastObservedAt is deliberate: "never checked" is the truth.
  if (!(await isWatchableProject(projectId))) return result

  // Gather all raw findings in parallel — each detector is isolated
  const detectors = [
    // ── Existing checks ──────────────────────────────────────────────────────
    detectMissingRls(projectId),
    // The mirror image of detectMissingRls: RLS on with zero policies denies
    // everyone. One probe cannot answer both questions — see the note on the
    // detector.
    detectRlsDeniesEverything(projectId),
    detectApiDrift(projectId),
    detectBrokenWebhooks(projectId),
    detectOrphanTables(projectId),
    detectAuthSpike(projectId),
    detectDeployFailure(projectId),
    // ── 3.1 Schema Drift ─────────────────────────────────────────────────────
    detectFkColumnsMissingConstraints(projectId),
    detectTablesWithNoApiDefinition(projectId),
    detectShadowMutations(projectId),
    detectMissingFkIndexes(projectId),
    // ── 3.2 Auth Integrity ────────────────────────────────────────────────────
    checkAuthIntegrity(projectId),
    // ── 3.3 Integration Health ────────────────────────────────────────────────
    checkIntegrationHealth(projectId),
    // ── 3.4 Workflow Correctness ──────────────────────────────────────────────
    verifyWorkflows(projectId),
    // ── 3.5 API Coverage ─────────────────────────────────────────────────────
    detectApiCoverageGaps(projectId),
    // The runtime contract is NOT probed here. runContractSweep is its only
    // writer and resolver, because only a pass that has seen every project can
    // tell a tenant's broken surface from the platform's. Probing it here as
    // well is what emailed a customer about an outage that was ours.
    // Daily, not per-minute, and deliberately so: this reports that repairs
    // across one area have stopped holding, which is a slow-moving structural
    // signal. It also has no executable fix (notify_only / Tier 3), so the
    // reconciler would never mint a finding for it -- ensureFinding is reached
    // only from the WOULD_AUTO_APPLY branch. The observer is the path that
    // persists non-auto findings, which is what this is.
    detectSubsystemRecurrence(projectId),
  ]

  const settled = await Promise.allSettled(detectors)
  const allFindings: RawFinding[] = []

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      allFindings.push(...outcome.value)
    } else {
      result.errors.push(String(outcome.reason?.message ?? outcome.reason))
    }
  }

  result.findingsDetected = allFindings.length

  // Criticals still unresolved after this pass, with when each was first seen.
  // Only these can reach the owner's inbox (see notifyCritical).
  const outstandingCritical: Array<{ finding: RawFinding; firstDetectedAt: Date }> = []

  // Process each finding: auto-fix safe ones, queue others for approval
  for (const finding of allFindings) {
    // Pillar 5.3: If this finding type was previously fixed and has re-appeared,
    // escalate severity rather than repeating the same auto-fix loop.
    const shouldEscalate = await checkEscalation(projectId, finding.type, finding.details).catch(() => false)
    if (shouldEscalate && finding.severity !== 'critical') {
      finding.severity = 'critical'
      finding.autoFixable = false
      finding.details = {
        ...finding.details,
        escalated: true,
        escalationReason: 'This issue was previously auto-fixed but has re-appeared — requires manual review',
      }
    }

    if (finding.severity === 'critical') result.critical++

    let status: FindingStatus
    let autoFixed = false
    let fixAppliedAt: Date | undefined

    if (finding.autoFixable && finding.fix) {
      try {
        await finding.fix()
        status = 'auto_fixed'
        autoFixed = true
        fixAppliedAt = new Date()
        result.autoFixed++
      } catch (err: any) {
        // Fix failed — demote to pending_approval so a human can review
        status = 'pending_approval'
        result.pendingApproval++
        finding.details.fixError = err?.message ?? String(err)
      }
    } else if (finding.autoFixable === false) {
      status = 'pending_approval'
      result.pendingApproval++
    } else {
      status = 'open'
    }

    const written = await writeFinding(projectId, finding, status, autoFixed, fixAppliedAt)
    if (finding.severity === 'critical' && status !== 'auto_fixed') {
      outstandingCritical.push({ finding, firstDetectedAt: written.firstDetectedAt })
    }
  }

  // Resolve workflow findings whose workflow is no longer broken. The verifier
  // reports CURRENT state each scan, so any open/pending workflow_broken row
  // for a workflow absent from this scan's results is stale — without this
  // reap, a queued workflow finding survived forever once the workflow healed
  // (or once a detector false-positive was corrected). Best-effort.
  try {
    const brokenNow = new Set(
      allFindings
        .filter((f) => f.type === 'workflow_broken')
        .map((f) => String((f.details as { workflow?: unknown })?.workflow ?? '')),
    )
    const workflowRows = await prisma.healthFinding.findMany({
      where: { projectId, type: 'workflow_broken', status: { in: ['open', 'pending_approval'] } },
      select: { id: true, details: true },
    })
    const staleWorkflowIds = workflowRows
      .filter((f) => !brokenNow.has(String((f.details as { workflow?: unknown } | null)?.workflow ?? '')))
      .map((f) => f.id)
    if (staleWorkflowIds.length > 0) {
      await prisma.healthFinding.updateMany({
        where: { id: { in: staleWorkflowIds } },
        data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
      })
    }
  } catch { /* best-effort — a failed cleanup must never fail the scan */ }

  // Reap stale missing_fk findings by POSITIVELY verifying each one against the
  // live schema — never by absence from this scan (the FK probe swallows query
  // errors into an empty result, so "absent" can't be trusted to mean "gone").
  // A queued missing_fk row is closed only when we can prove it no longer holds:
  //   • the FK constraint now exists          → auto_fixed (the loop/approve added it)
  //   • the column no longer exists           → auto_fixed (table was reshaped)
  //   • the column has no resolvable target    → dismissed (external/polymorphic id,
  //                                               e.g. stripe_session_id — never a FK)
  // Anything still genuinely missing its FK is left untouched. Best-effort.
  try {
    const openFk = await prisma.healthFinding.findMany({
      where: { projectId, type: 'missing_fk', status: { in: ['open', 'pending_approval'] } },
      select: { id: true, details: true },
    })
    if (openFk.length > 0) {
      const wsSchema = `workspace_${projectId}`
      // One pass over the live schema: which (table,column) pairs exist, and
      // which already carry a FK constraint.
      const [colRows, fkRows] = await Promise.all([
        queryWorkspaceSchema(projectId,
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
          wsSchema).catch(() => ({ rows: [] })),
        queryWorkspaceSchema(projectId,
          `SELECT tc.table_name, kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
          wsSchema).catch(() => ({ rows: [] })),
      ])
      const colSet = new Set((colRows?.rows ?? colRows ?? []).map((r: any) => `${r.table_name}.${r.column_name}`))
      const fkSet = new Set((fkRows?.rows ?? fkRows ?? []).map((r: any) => `${r.table_name}.${r.column_name}`))
      const { buildWorkspaceTableNameMap, resolveReferencedTable } = await import('@/lib/ai/fk-repair')
      const tableMap = await buildWorkspaceTableNameMap(projectId).catch(() => new Map<string, string>())

      const resolvedIds: string[] = []
      const dismissedIds: string[] = []
      for (const f of openFk) {
        const d = (f.details ?? {}) as { tableName?: unknown; columnName?: unknown }
        const table = typeof d.tableName === 'string' ? d.tableName : ''
        const column = typeof d.columnName === 'string' ? d.columnName : ''
        if (!table || !column) continue
        const key = `${table}.${column}`
        if (fkSet.has(key) || !colSet.has(key)) { resolvedIds.push(f.id); continue }
        if (!resolveReferencedTable(column, tableMap, table)) { dismissedIds.push(f.id) }
      }
      if (resolvedIds.length > 0) {
        await prisma.healthFinding.updateMany({
          where: { id: { in: resolvedIds } },
          data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
        })
      }
      if (dismissedIds.length > 0) {
        await prisma.healthFinding.updateMany({
          where: { id: { in: dismissedIds } },
          data: { status: 'dismissed' },
        })
      }
    }
  } catch { /* best-effort — a failed cleanup must never fail the scan */ }

  // Self-heal stale false positives. `users` (auth-managed via /auth/*) and
  // reserved internal tables are never eligible for a generic REST API or an
  // orphan-table flag (the platform itself creates `users` on first signup),
  // so any lingering finding on them — written before the detectors excluded
  // them — must be closed here. Nothing re-detects them to resolve them
  // otherwise, so they'd show "Critical: No REST API — users" forever. Scoped to
  // exactly those table names, so it can never close a real finding. Best-effort.
  try {
    const staleApiFindings = await prisma.healthFinding.findMany({
      where: {
        projectId,
        type: { in: ['missing_api_definition', 'missing_api_crud', 'orphan_table'] },
        status: { in: ['open', 'pending_approval'] },
      },
      select: { id: true, details: true },
    })
    const staleIds = staleApiFindings
      .filter((f) => {
        const name = (f.details as { tableName?: unknown } | null)?.tableName
        return typeof name === 'string'
          && (name.toLowerCase() === 'users' || isReservedWorkspaceTable(name))
      })
      .map((f) => f.id)
    if (staleIds.length > 0) {
      await prisma.healthFinding.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'dismissed' },
      })
    }
  } catch { /* best-effort — a failed cleanup must never fail the scan */ }

  // Self-heal AI functions stuck in status='error'. lastError only clears on
  // the next successful run, but broken functions stop being invoked — so a
  // function that crashed on a since-fixed platform bug (e.g. the route-module
  // runner's missing params arg) stays red forever without this. Route modules
  // whose stored code re-validates clean and whose error matches a known
  // runner-contract bug are restored outright (no LLM); genuinely broken code
  // is regenerated through the validated fixers, LLM-budget-capped per scan.
  try {
    const { healErroredAiFunctions } = await import('@/lib/services/ai-functions/executor')
    const healed = await healErroredAiFunctions(projectId)
    if (healed.restored > 0 || healed.regenerated > 0) {
      result.autoFixed += healed.restored + healed.regenerated
      console.log(
        `[WorkspaceObserver] healed AI functions for ${projectId}: ` +
        `${healed.restored} restored, ${healed.regenerated} regenerated, ${healed.failed} unfixable`
      )
    }
  } catch { /* best-effort — a failed heal must never fail the scan */ }

  // Tell the owner about criticals that are still theirs to deal with. Counted
  // AFTER the fix attempts: a critical this pass repaired is not news.
  if (outstandingCritical.length > 0) {
    await notifyCritical(projectId, outstandingCritical)
  }

  // Phase 12 — generate fix plans from all collected findings when planner is on
  if (FLAGS.ENABLE_AUTO_FIX_PLANNER && allFindings.length > 0) {
    result.fixPlans = generateFixPlansFromRawFindings(allFindings)
  }

  // Phase 13 — run structural verification after fixes; update findings based on results
  if (FLAGS.ENABLE_VERIFICATION_EXECUTION && FLAGS.ENABLE_SAFE_VERIFICATION_MODE) {
    try {
      const verificationResult = await runBuiltInVerification(projectId)
      result.verificationResult = verificationResult

      // Persist newly failed verifications as open HealthFinding records
      for (const failed of verificationResult.failed) {
        await writeFinding(
          projectId,
          {
            type: 'verification_failed',
            severity: failed.severity === 'critical' ? 'critical'
              : failed.severity === 'high' ? 'warning'
              : 'warning',
            details: {
              scenarioId: failed.scenarioId,
              scenarioName: failed.name,
              category: failed.category,
              reason: failed.reason,
              failedChecks: failed.checks.filter(c => !c.passed).map(c => c.message),
              source: 'verification_executor',
            },
            autoFixable: false,
          },
          'open',
          false,
          undefined,
        )
      }

      // Resolve verification_failed findings whose scenario now passes. A
      // verification finding is a claim about CURRENT structure — once the
      // check passes (the build fixed it, a detector false-positive was
      // corrected, or the user acted), keeping the row open shows the user a
      // problem that no longer exists. Without this, verification findings
      // were a one-way ratchet: written on failure, never closed on success.
      if (verificationResult.passed.length > 0) {
        try {
          const passedScenarioIds = new Set(
            verificationResult.passed.map((s) => s.scenarioId),
          )
          const openVerifications = await prisma.healthFinding.findMany({
            where: {
              projectId,
              type: 'verification_failed',
              status: { in: ['open', 'pending_approval'] },
            },
            select: { id: true, details: true },
          })
          const clearedIds = openVerifications
            .filter((f) => {
              const sid = (f.details as { scenarioId?: unknown } | null)?.scenarioId
              return typeof sid === 'string' && passedScenarioIds.has(sid)
            })
            .map((f) => f.id)
          if (clearedIds.length > 0) {
            await prisma.healthFinding.updateMany({
              where: { id: { in: clearedIds } },
              data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
            })
          }
        } catch { /* best-effort — a failed cleanup must never fail the scan */ }
      }

      // Resolve any open missing_verification findings when structural checks
      // pass. Includes pending_approval rows: a finding whose evidence no
      // longer exists must leave the approval queue, not wait forever for a
      // human to approve a fix for a problem that is already gone.
      if (verificationResult.passed.length > 0) {
        const passedCategories = new Set(verificationResult.passed.map(s => s.category))
        if (passedCategories.has('auth')) {
          await prisma.healthFinding.updateMany({
            where: {
              projectId,
              type: { in: ['auth_jwt_missing', 'auth_users_table_missing'] },
              status: { in: ['open', 'pending_approval'] },
            },
            data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
          })
        }
        if (passedCategories.has('rls')) {
          await prisma.healthFinding.updateMany({
            where: { projectId, type: 'missing_rls', status: { in: ['open', 'pending_approval'] } },
            data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
          })
        }
      }
    } catch (err: any) {
      result.errors.push(`[verification] ${err?.message ?? String(err)}`)
    }
  }

  // Withdraw stale advisory findings (arch proposals, performance heuristics,
  // desired-state invariants, migration-agent drift) whose evidence no longer
  // supports them. This is the ONLY reap that runs on the user-facing Re-scan
  // (PATCH /health) — the other writers reap on their own cron cadences (6h /
  // plan cadence, 24h on Free, once daily), which left condition-cleared
  // findings visible for up to a day after a manual re-scan.
  // Deterministic SQL only, no LLM — cheap and safe on every scan.
  try {
    const { reapStaleFindings } = await import('@/lib/core/finding-reaper')
    const reaped = await reapStaleFindings(projectId)
    const total = reaped.arch + reaped.performance + reaped.invariants + reaped.migration
    if (total > 0) {
      console.log(
        `[WorkspaceObserver] reaped stale findings for ${projectId}: ` +
        `arch=${reaped.arch} performance=${reaped.performance} ` +
        `invariants=${reaped.invariants} migration=${reaped.migration}`,
      )
    }
  } catch { /* best-effort — a failed reap must never fail the scan */ }

  // Withdraw stale findings from THIS scan's own 14 detectors (orphan_table,
  // api_drift, broken_webhook, auth_spike, deploy_failure, integration health,
  // contract violations) — reuses allFindings, the fresh results this exact
  // tick already computed, so it costs nothing extra. Before this, only
  // 'workflow_broken' (handled above) had any way to self-resolve; every one
  // of these other types could sit open/pending forever once its underlying
  // condition cleared (webhook fixed outside the platform, flagged table
  // dropped, integration reconnected) with no user action able to close it.
  try {
    const { reapObserverFindings } = await import('@/lib/core/finding-reaper')
    const { gapIdentity } = await import('@/lib/autonomy/desired-state')
    const detectedIdentities = new Set(
      allFindings.map((f) => gapIdentity(f.type, f.details as Record<string, unknown>)),
    )
    await reapObserverFindings(projectId, detectedIdentities, result.errors.length === 0)
  } catch { /* best-effort — a failed reap must never fail the scan */ }

  // Stamp scan completion whether or not anything was found. This is the ONLY
  // honest "last checked" signal — findings only get written when something is
  // detected, so a healthy project's newest HealthFinding.detectedAt drifts
  // days into the past while scans keep passing. Best-effort: a failed stamp
  // must not fail the scan itself.
  await prisma.project
    .update({ where: { id: projectId }, data: { lastObservedAt: new Date() } })
    .catch((err: any) => {
      result.errors.push(`[lastObservedAt] ${err?.message ?? String(err)}`)
    })

  console.log(
    `[WorkspaceObserver] project=${projectId} | found=${result.findingsDetected} | ` +
    `autoFixed=${result.autoFixed} | pending=${result.pendingApproval} | critical=${result.critical}` +
    (result.fixPlans ? ` | fixPlans=${result.fixPlans.length}` : '') +
    (result.verificationResult
      ? ` | verification: ${result.verificationResult.passed.length}✓ ${result.verificationResult.failed.length}✗ ${result.verificationResult.skipped.length}–`
      : '')
  )

  return result
}

// ─── Finding Writer ───────────────────────────────────────────────────────────

async function writeFinding(
  projectId: string,
  finding: RawFinding,
  status: FindingStatus,
  autoFixed: boolean,
  fixAppliedAt?: Date
): Promise<{ firstDetectedAt: Date }> {
  // Upsert: if an open finding of the same type already exists, update it.
  //
  // Some types carry several INDEPENDENT instances at once, and keying the
  // upsert on `type` alone silently collapses them into one row — the last
  // writer wins and every earlier instance disappears:
  //   verification_failed    → one row per scenario
  //   contract_surface_broken→ one row per surface (auth/db/storage/…)
  // contract-verifier already auto-resolves per-surface (details.surface), so
  // without the matching discriminator here a healthz failure and a storage
  // failure would fight over a single row and recovery would clear the wrong
  // one. Add a type to this map whenever a detector can emit concurrent,
  // separately-resolvable instances.
  const DISCRIMINATOR: Record<string, string> = {
    verification_failed: 'scenarioId',
    contract_surface_broken: 'surface',
    // One row per SUBSYSTEM, keyed on the membership snapshot rather than the
    // fingerprint. Two things follow from that choice, and both are wanted:
    // a backend with two failing areas keeps two independent rows, and a
    // component whose membership changes gets a NEW row while the old one is
    // reaped — which is exactly the continuity reset the fingerprint cannot
    // provide, since a table joining the component can move it.
    subsystem_repeat_failure: 'membershipHash',
  }

  const discriminatorKey = DISCRIMINATOR[finding.type]
  const discriminatorValue = discriminatorKey
    ? (finding.details as Record<string, unknown>)[discriminatorKey] as string | undefined
    : undefined

  const existing = await prisma.healthFinding.findFirst({
    where: {
      projectId,
      type: finding.type,
      status: { in: ['open', 'pending_approval'] },
      ...(discriminatorKey !== undefined && discriminatorValue !== undefined
        ? { details: { path: [discriminatorKey], equals: discriminatorValue } }
        : {}),
    },
    select: { id: true, details: true },
  })

  // `detectedAt` moves on every write, so it cannot say how long a problem
  // has persisted. `firstDetectedAt` is carried across updates for that: it is
  // what lets an alert wait until a finding has been seen on more than one
  // pass instead of paging on a single observation.
  const now = new Date()
  const carried = (existing?.details as Record<string, unknown> | null)?.firstDetectedAt
  const firstDetectedAt =
    typeof carried === 'string' && Number.isFinite(Date.parse(carried)) ? new Date(carried) : now
  finding.details = { ...finding.details, firstDetectedAt: firstDetectedAt.toISOString() }

  if (existing) {
    await prisma.healthFinding.update({
      where: { id: existing.id },
      data: {
        severity: finding.severity,
        details: finding.details as any,
        status,
        autoFixed,
        fixAppliedAt: fixAppliedAt ?? null,
        detectedAt: new Date(),
      },
    })
  } else {
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: finding.type,
        severity: finding.severity,
        details: finding.details as any,
        status,
        autoFixed,
        fixAppliedAt: fixAppliedAt ?? null,
      },
    })
  }

  // Pillar 5.3: Write fix history — ONLY for findings that were actually
  // auto-fixed. A pending_approval finding is merely queued: writing history
  // here fabricated "User resolved: …" activity rows for actions the user
  // never took, and poisoned checkEscalation (the queued finding matched as a
  // "previous fix", so it escalated itself on the next scan). The approve
  // route writes the real user-resolution history when the user acts.
  if (status === 'auto_fixed') {
    const resolution = buildResolutionText(
      finding.type as FindingType,
      finding.details as Record<string, unknown>,
      true,
    )
    await writeFixHistory(projectId, {
      findingType: finding.type as FindingType,
      findingSeverity: finding.severity as FindingSeverity,
      status,
      details: finding.details as Record<string, unknown>,
      resolution,
      automatic: true,
    })
  }

  return { firstDetectedAt }
}

// ─── Notification ─────────────────────────────────────────────────────────────

/**
 * How long a critical must have existed before it may be emailed. A finding
 * seen on one pass only is an observation, not yet a problem worth a page:
 * it has to still be there on a later pass.
 */
export const CRITICAL_ALERT_CONFIRM_MS = 10 * 60 * 1000

/** At most one health email per project in this window. */
export const CRITICAL_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000

const ALERT_PREF_TYPE = 'alerting'
const ALERT_PREF_KEY = 'last_critical_email'

/**
 * Claim this project's alert slot, atomically.
 *
 * The old guard looked for a recent in-app notification and then inserted
 * one. That was a race (two scans in flight both passed the check), it
 * depended on the in-app row existing (an owner with in-app alerts off got an
 * email on every scan), and any unrelated `system` notice for the project
 * silenced a real outage. This is a compare-and-set on one row: the UPDATE only
 * matches while the last alert is older than the window, and Postgres lets
 * exactly one concurrent writer match.
 */
async function claimCriticalAlertSlot(projectId: string, now: Date): Promise<boolean> {
  const where = { projectId_type_key: { projectId, type: ALERT_PREF_TYPE, key: ALERT_PREF_KEY } }
  await prisma.projectPreference
    .upsert({
      where,
      create: {
        projectId, type: ALERT_PREF_TYPE, key: ALERT_PREF_KEY, value: '', confidence: 1,
        lastSeen: new Date(0),
      },
      update: {},
    })
    .catch(() => {
      /* a concurrent creator won; the conditional update below still decides */
    })
  const claimed = await prisma.projectPreference.updateMany({
    where: {
      projectId, type: ALERT_PREF_TYPE, key: ALERT_PREF_KEY,
      lastSeen: { lt: new Date(now.getTime() - CRITICAL_ALERT_WINDOW_MS) },
    },
    data: { lastSeen: now, value: now.toISOString() },
  })
  return claimed.count === 1
}

/**
 * Email the owner about criticals that are still theirs to deal with.
 *
 * Every rule here exists because a customer was paged for something that was
 * not theirs, or not real:
 *   - only findings still unresolved after this pass (the caller passes those)
 *   - only findings first seen at least CRITICAL_ALERT_CONFIRM_MS ago
 *   - at most one email per project per CRITICAL_ALERT_WINDOW_MS, claimed
 *     atomically
 *   - sent as `health_alert`, so it has its own preference and is never
 *     silenced by, or confused with, account notices
 *
 * Platform faults never reach here: the contract sweep reports them to the
 * operator and files nothing (lib/autonomy/platform-faults.ts).
 */
export async function notifyCritical(
  projectId: string,
  outstanding: Array<{ finding: RawFinding; firstDetectedAt: Date }>,
): Promise<void> {
  try {
    const now = new Date()
    const confirmed = outstanding.filter(
      o => now.getTime() - o.firstDetectedAt.getTime() >= CRITICAL_ALERT_CONFIRM_MS,
    )
    if (confirmed.length === 0) return

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true, name: true },
    })
    if (!project?.userId) return

    if (!(await claimCriticalAlertSlot(projectId, now))) return

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
    const count = confirmed.length
    const summaries = confirmed.map(o => summariseFinding(o.finding.type, o.finding.details))

    await createPlatformNotification({
      userId: project.userId,
      type: 'health_alert',
      title: `${count} critical issue${count > 1 ? 's' : ''} in "${project.name}"`,
      body:
        count > 1
          ? 'Backenly found problems it could not resolve on its own. They are waiting for you on the Autonomy page.'
          : 'Backenly found a problem it could not resolve on its own. It is waiting for you on the Autonomy page.',
      metadata: {
        projectId,
        count,
        types: confirmed.map(o => o.finding.type),
        summaries,
        actionUrl: `${appUrl}/app/projects/${projectId}/autonomy`,
      },
    })
  } catch {
    // Non-fatal — notification failure must never break the observer loop
  }
}

// ─── Detectors ───────────────────────────────────────────────────────────────

/**
 * Detect tables that have a user_id column but no RLS enabled.
 * Auto-fixable: applies the 'own_rows' policy automatically.
 */
// Exported so the declarative desired-state spec (lib/autonomy/desired-state.ts)
// can reuse the canonical RLS probe read-only. Calling this never mutates —
// the `fix` closure on each finding is lazy and only the observer loop invokes it.
export async function detectMissingRls(projectId: string): Promise<RawFinding[]> {
  const schemaName = `workspace_${projectId}`

  // Any CLIENT-REACHABLE table without RLS — not just ones with an ownership
  // column.
  //
  // This used to require user_id/userId/owner_id, on the reasoning that a table
  // without one is not "user data". That reasoning died with the ApiDefinition
  // gate (2eedc085). Exposure is now decided by grants alone, so a `products`
  // table with no ownership column and RLS off is readable in full by anyone
  // holding an API key — and the old query would not have said a word about it.
  //
  // Mirrors backenly_pgrst_cutover_blockers check #2, which refuses a cutover
  // for the same condition. Same rule, two moments: that one at migration time,
  // this one continuously.
  const rows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT t.tablename,
           EXISTS (
             SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = t.tablename
               AND c.column_name IN ('user_id', 'userId', 'owner_id', 'author_id', 'created_by')
           ) AS has_owner_column
    FROM pg_tables t
    JOIN pg_class pc
      ON pc.relname = t.tablename
      AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
    WHERE t.schemaname = $1
      AND NOT pc.relrowsecurity
      AND t.tablename <> 'users'
      AND ${notReservedTableSql('t.tablename')}
      AND (
        -- Reachability. Guarded because the PostgREST roles may not exist in a
        -- dev or CI database, and has_table_privilege() ERRORS on an unknown
        -- role — which, now that this probe throws instead of swallowing, would
        -- take the whole autonomy loop down rather than one invariant.
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
        OR has_table_privilege('anon', pc.oid, 'SELECT')
        OR has_table_privilege('authenticated', pc.oid, 'SELECT')
      )
    ORDER BY t.tablename
    `,
    // One $1 placeholder → exactly one bind param. Passing schemaName twice
    // made Postgres reject the bind ("supplies 2 parameters, requires 1"),
    // a swallowing catch turned that into [], and this detector silently never
    // fired — the missing-RLS invariant probe was dead in every environment.
    schemaName
  ).catch(probeQueryFailed('detectMissingRls'))

  // No swallow. "I could not look" must never be reported as "I looked and
  // found nothing" — that is precisely how this probe stayed dead for months.

  const hits: Array<{ tablename: string; has_owner_column: boolean }> =
    (rows?.rows ?? rows ?? []) as any

  if (!hits.length) return []

  // Ownership is decided by the schema, not by whether one hardcoded column
  // name happens to be present. `has_owner_column` above only asks "is there a
  // column called user_id / owner_id / …", which answers neither of the two
  // cases that matter:
  //
  //   order_items  — no such column, yet every row belongs to one customer
  //                  through orders. Was reported as an un-fixable critical and
  //                  escalated to a human with `column "user_id" does not exist`.
  //   products     — no such column, and world-readable is CORRECT. Was reported
  //                  as `critical | missing_rls`, which is how a queue teaches
  //                  its reader to ignore it.
  //
  // One catalog read, then a plan per table. See lib/services/rls-ownership.ts.
  const catalog = await loadOwnershipCatalog(projectId)

  return hits.map(({ tablename: tableName }) => {
    const plan = inferRlsPlanFromCatalog(catalog, tableName)
    return {
      type: 'missing_rls' as FindingType,
      severity: severityForPlan(plan) as FindingSeverity,
      details: {
        tableName,
        schemaName,
        reason: exposureReason(tableName, plan),
        // Carried so the approve modal, the agent journal and buildFixAction all
        // describe the SAME repair the fix closure will actually run.
        rlsTemplate: plan.template,
        rlsBasis: plan.basis,
        rlsRationale: plan.reason,
      },
      // Auto-fixable whenever a policy is DERIVABLE — which now includes every
      // indirectly-owned table and every reference table, not just the ones
      // carrying a literal user_id. Still never true for `undecidable`: enabling
      // RLS with no derivable policy makes the table read EMPTY, replacing a data
      // exposure with an outage. Those go to a human, who decides the rule.
      autoFixable: plan.kind !== 'undecidable',
      fix: plan.kind !== 'undecidable'
        ? async () => {
            await applyPermissionPolicy(projectId, { tableName, template: 'auto' })
          }
        : undefined,
    }
  })
}

/**
 * Detect tables where RLS is ON and there are NO policies — default-deny.
 *
 * ── Why this is a separate probe from detectMissingRls ──────────────────────
 *
 * `detectMissingRls` asks `NOT pc.relrowsecurity`: RLS switched OFF, i.e. the
 * table is EXPOSED. This asks the opposite question — RLS on, policy count zero
 * — and the answer is an OUTAGE, not an exposure. PostgreSQL's rule is
 * default-deny, so a table in this state returns zero rows to every end-user
 * request and accepts no writes, while the API answers 200 and health stays
 * green. Nothing errors, so nothing was ever reported.
 *
 * That is not hypothetical: a live project carried a FORCE-RLS `connections`
 * table with zero policies across a failed approval and an entire release. Every
 * surface said the project was fine, the app's feature silently returned nothing,
 * and the loop that advertises RLS-gap detection never mentioned the most
 * detectable gap available to it.
 *
 * Severity is critical: unlike a missing index this is a hard functional break,
 * and unlike a missing policy it is not a security trade-off — there is no
 * reading under which "denies everyone" is the intended configuration of a table
 * a client is meant to reach.
 */
export async function detectRlsDeniesEverything(projectId: string): Promise<RawFinding[]> {
  const schemaName = `workspace_${projectId}`

  const rows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT t.tablename,
           pc.relforcerowsecurity AS forced
    FROM pg_tables t
    JOIN pg_class pc
      ON pc.relname = t.tablename
      AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
    WHERE t.schemaname = $1
      AND pc.relrowsecurity
      AND ${notReservedTableSql('t.tablename')}
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = $1 AND p.tablename = t.tablename
      )
      -- Reachability, guarded exactly as detectMissingRls guards it: a table no
      -- client role can reach is not serving anyone, so denying them is moot.
      AND (
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
        OR has_table_privilege('anon', pc.oid, 'SELECT')
        OR has_table_privilege('authenticated', pc.oid, 'SELECT')
      )
    ORDER BY t.tablename
    `,
    schemaName,
  ).catch(probeQueryFailed('detectRlsDeniesEverything'))

  const hits: Array<{ tablename: string; forced: boolean }> = (rows?.rows ?? rows ?? []) as any
  if (!hits.length) return []

  const catalog = await loadOwnershipCatalog(projectId)

  return hits.map(({ tablename: tableName, forced }) => {
    const plan = inferRlsPlanFromCatalog(catalog, tableName)
    return {
      type: 'rls_denies_everything' as FindingType,
      severity: 'critical' as FindingSeverity,
      details: {
        tableName,
        schemaName,
        reason:
          `Row-level security is enabled${forced ? ' (FORCED)' : ''} on "${tableName}" and the table has ZERO ` +
          `policies. PostgreSQL denies by default, so every end-user read returns no rows and every write is ` +
          `rejected — the table is dead to your app, not protected. ` +
          (plan.kind === 'undecidable'
            ? `Backenly cannot derive the right policy here (${plan.reason}), so a human has to say what the ` +
              `rule is — or disable RLS on the table if it is meant to be open.`
            : `The schema implies "${plan.template}" (${plan.basis}): ${plan.reason}`),
        rlsTemplate: plan.template,
        rlsBasis: plan.basis,
        rlsRationale: plan.reason,
        forceRowSecurity: !!forced,
      },
      // Same rule as missing_rls: repair only when a policy is DERIVABLE.
      // Installing a wrong policy here would replace an outage with a different
      // outage, so undecidable ownership goes to the human who knows the intent.
      autoFixable: plan.kind !== 'undecidable',
      fix: plan.kind !== 'undecidable'
        ? async () => {
            const result = await applyPermissionPolicy(projectId, { tableName, template: 'auto' })
            // Never report a repair that did not land — an unfixed default-deny
            // table that reads as "auto_fixed" is worse than an open finding,
            // because the queue stops showing it.
            if (!result.success) {
              throw new Error(`Could not install a policy on "${tableName}": ${result.message}`)
            }
          }
        : undefined,
    }
  })
}

/**
 * Detect tables that exist in the database but have no ApiDefinition (orphaned).
 */
export async function detectOrphanTables(projectId: string): Promise<RawFinding[]> {
  const schemaName = `workspace_${projectId}`

  // Exported (2026-07-30) so the desired-state catalogue can re-run it after a
  // REGISTER_TABLE fix. orphan_table is applied automatically but had no probe
  // registered, so `recheckGap` could never confirm the adoption held — and
  // adoption is the single most likely fix on a platform that hands out a direct
  // connection string and invites psql.
  //
  // `probeQueryFailed` rather than `.catch(() => ({ rows: [] }))`: swallowing the
  // error turned "I could not look" into "I looked and found nothing", which is
  // exactly how detectMissingRls stayed silently dead for months.
  const liveRows = await queryWorkspaceSchema(
    projectId,
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND ${notReservedTableSql('tablename')}`,
    schemaName
  ).catch(probeQueryFailed('detectOrphanTables'))

  const liveTables: string[] = (liveRows?.rows ?? liveRows ?? []).map((r: any) => r.tablename)
  if (!liveTables.length) return []

  const knownTables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true },
  })
  const knownNames = new Set(knownTables.map((t) => t.name))

  // `users` is auth-managed: the platform itself creates it lazily on the
  // first signup (ensureAuthUsersTable), so it is never a table the user made
  // outside the platform — flagging it as an orphan is self-flagging.
  const orphans = liveTables.filter((t) => !knownNames.has(t) && t.toLowerCase() !== 'users')

  return orphans.map((tableName) => ({
    type: 'orphan_table' as FindingType,
    severity: 'info' as FindingSeverity,
    details: { tableName, reason: 'Table exists in DB but not registered in platform' },
    autoFixable: false, // Risky — cannot safely drop or auto-register without human intent
  }))
}

/**
 * RETIRED 2026-07-30 — this detector could never emit a finding, on any project,
 * at any point in its life.
 *
 * It loaded ApiDefinition rows and then read `def.columns ?? def.fields` to
 * decide whether the stored definition referenced columns the live schema no
 * longer has. Neither field exists on the model — ApiDefinition carries
 * operations, endpoints, validation and config, and never carried a column
 * list. So `defColumns` was always [], `staleColumns` was always [], and the
 * `if (staleColumns.length > 0)` branch was unreachable.
 *
 * Two independent reasons it reported nothing, which is why it survived: the
 * cast to `any` on line 1021 removed the type error that would have caught the
 * wrong field names, and the PostgREST cutover later emptied the table it read
 * anyway. Either alone is enough to silence it. Together they made a detector
 * that looked maintained and had never once fired.
 *
 * `api_drift` is retired vocabulary regardless: under PostgREST the API is the
 * schema, so an API cannot reference a column the schema does not have. There
 * is nothing here to reinstate.
 */
async function detectApiDrift(_projectId: string): Promise<RawFinding[]> {
  return []
}

/**
 * Detect AppTrigger webhooks that have recent dead-letter delivery failures.
 */
async function detectBrokenWebhooks(projectId: string): Promise<RawFinding[]> {
  const deadTriggers = await prisma.triggerDeliveryLog.groupBy({
    by: ['triggerId'],
    where: {
      projectId,
      status: 'DEAD',
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    _count: { id: true },
  }).catch(() => [])

  return deadTriggers.map((t) => ({
    type: 'broken_webhook' as FindingType,
    severity: 'critical' as FindingSeverity,
    details: {
      triggerId: t.triggerId,
      failureCount: t._count.id,
      reason: 'Webhook trigger has dead-letter failures in the last 24 hours',
    },
    autoFixable: false, // Webhook URL fix requires human action
  }))
}

/**
 * Detect auth error spikes: >5 failed end-user auth requests in 10 minutes.
 * Uses ApiRequestLog targeting /v1/<projectId>/auth paths.
 */
async function detectAuthSpike(projectId: string): Promise<RawFinding[]> {
  const windowStart = new Date(Date.now() - 10 * 60 * 1000)

  const count = await prisma.apiRequestLog.count({
    where: {
      projectId,
      path: { contains: '/auth/' },
      statusCode: { gte: 400, lte: 499 },
      timestamp: { gte: windowStart },
    },
  }).catch(() => 0)

  if (count <= 5) return []

  return [{
    type: 'auth_spike',
    severity: 'critical',
    details: {
      errorCount: count,
      windowMinutes: 10,
      reason: `${count} auth errors in the last 10 minutes — possible brute-force or misconfiguration`,
    },
    autoFixable: false,
  }]
}

/**
 * Detect recent deployment failures that have not been resolved.
 */
async function detectDeployFailure(projectId: string): Promise<RawFinding[]> {
  const recentFailure = await prisma.deployment.findFirst({
    where: {
      projectId,
      status: 'failed',
      createdAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    },
    select: { id: true, errorMessage: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)

  if (!recentFailure) return []

  return [{
    type: 'deploy_failure',
    severity: 'critical',
    details: {
      deploymentId: recentFailure.id,
      error: recentFailure.errorMessage ?? 'Unknown error',
      failedAt: recentFailure.createdAt,
      reason: 'A deployment failed in the last 6 hours and has not been resolved',
    },
    autoFixable: false,
  }]
}
