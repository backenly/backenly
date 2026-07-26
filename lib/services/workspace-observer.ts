/**
 * WORKSPACE OBSERVER
 * ==================
 * The central health-check loop for the platform's "Runs Itself" pillar.
 *
 * Runs every 6 hours (scheduled in instrumentation.ts) AND is triggered
 * immediately by schema changes, fix attempts, and deployment failures via
 * the event bus (lib/events/bus.ts).
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
import { detectContractViolations } from '@/lib/services/contract-verifier'
import { writeFixHistory, checkEscalation, buildResolutionText } from '@/lib/memory/fix-history'
import { generateFixPlansFromRawFindings, type FixPlan } from '@/lib/core/fix-plan-generator'
import { runBuiltInVerification, type VerificationExecutionResult } from '@/lib/verification/verification-executor'
import { FLAGS } from '@/lib/config/flags'

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
 * Probing must cover exactly what serves, so the gate is "has tables".
 */
export async function runWorkspaceObserver(): Promise<{
  processed: number
  results: ObserverResult[]
  errors: string[]
}> {
  const projects = await prisma.project.findMany({
    where: {
      tables: { some: {} },
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
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
 * Contract-only sweep: probe every reachable project's live API surfaces and
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
 * Findings flow through the same writeFinding path as the observer, so
 * dedup, escalation, and auto-resolve behave identically.
 */
export async function runContractSweep(): Promise<{
  processed: number
  broken: number
  errors: string[]
}> {
  const projects = await prisma.project.findMany({
    where: {
      tables: { some: {} },
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  })

  const errors: string[] = []
  let broken = 0

  const CONCURRENCY = 5
  for (let i = 0; i < projects.length; i += CONCURRENCY) {
    const batch = projects.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (p) => {
        const findings = await detectContractViolations(p.id)
        for (const finding of findings) {
          // Never auto-fixable: a broken surface is a symptom whose cause is
          // outside this project's schema (process down, route unmounted,
          // proxy misconfigured). Queue it for a human rather than inventing
          // a repair.
          await writeFinding(p.id, finding, 'pending_approval', false)
        }
        return findings.length
      }),
    )
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') broken += outcome.value
      else errors.push(String(outcome.reason?.message ?? outcome.reason))
    }
  }

  if (broken > 0 || errors.length > 0) {
    console.warn(
      `[ContractSweep] ${projects.length} projects | ${broken} broken surfaces | ${errors.length} scan errors`,
    )
  }

  return { processed: projects.length, broken, errors }
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
    // ── Runtime contract — live HTTP probes of the advertised API surfaces
    // (auth/db/storage/functions/healthz) through the real serving chain.
    detectContractViolations(projectId),
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

    await writeFinding(projectId, finding, status, autoFixed, fixAppliedAt)
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

  // Notify project owner for critical findings
  if (result.critical > 0) {
    await notifyCritical(projectId, result.critical, allFindings.filter(f => f.severity === 'critical'))
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
): Promise<void> {
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
    select: { id: true },
  })

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
}

// ─── Notification ─────────────────────────────────────────────────────────────

async function notifyCritical(
  projectId: string,
  count: number,
  criticalFindings: RawFinding[]
): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true, name: true },
    })
    if (!project?.userId) return

    // Dedup: don't send if a critical health alert was already sent in the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recentAlert = await prisma.platformNotification.findFirst({
      where: {
        userId: project.userId,
        type: 'system',
        createdAt: { gte: oneDayAgo },
        metadata: { path: ['projectId'], equals: projectId },
      },
      select: { id: true },
    })
    if (recentAlert) return

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
    const autoFixUrl = `${appUrl}/app/projects/${projectId}/autonomy`
    const typeList = criticalFindings.map(f => f.type.replace(/_/g, ' ')).join(', ')

    await createPlatformNotification({
      userId: project.userId,
      type: 'system',
      title: `${count} critical health issue${count > 1 ? 's' : ''} in "${project.name}"`,
      body: `Backenly detected critical issues: ${typeList}. Review and approve fixes on the Autonomy page.`,
      metadata: { projectId, count, types: criticalFindings.map(f => f.type), actionUrl: autoFixUrl },
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
async function detectOrphanTables(projectId: string): Promise<RawFinding[]> {
  const schemaName = `workspace_${projectId}`

  const liveRows = await queryWorkspaceSchema(
    projectId,
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND ${notReservedTableSql('tablename')}`,
    schemaName
  ).catch(() => ({ rows: [] }))

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
 * Detect tables that have an ApiDefinition but the definition is missing
 * required fields relative to the live schema (API drift).
 */
async function detectApiDrift(projectId: string): Promise<RawFinding[]> {
  const findings: RawFinding[] = []
  const schemaName = `workspace_${projectId}`

  const apiDefs = await prisma.apiDefinition.findMany({
    where: { table: { projectId } },
    include: { table: { select: { name: true } } },
  }).catch(() => [])

  for (const def of apiDefs) {
    const tableName = def.table.name
    const liveColumns = await queryWorkspaceSchema(
      projectId,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      schemaName,
      tableName
    ).catch(() => ({ rows: [] }))

    const cols: string[] = (liveColumns?.rows ?? liveColumns ?? []).map((r: any) => r.column_name)
    if (!cols.length) continue

    // Check if the stored definition references columns that no longer exist
    const defData = def as any
    const defColumns: string[] = defData.columns ?? defData.fields ?? []
    const staleColumns = defColumns.filter((c: string) => !cols.includes(c))

    if (staleColumns.length > 0) {
      findings.push({
        type: 'api_drift',
        severity: 'warning',
        details: {
          tableName,
          staleColumns,
          liveColumns: cols,
          reason: 'API definition references columns no longer present in live schema',
        },
        autoFixable: false, // Regenerating an API definition requires AI intent — queue for approval
      })
    }
  }

  return findings
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
