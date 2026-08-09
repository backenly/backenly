/**
 * AUTO-FIX ENGINE
 * ===============
 * Pillar 4.2 — Orchestrates the full auto-fix lifecycle for a HealthFinding.
 *
 * For every open finding the engine:
 *   1. Classifies the fix (auto / approval / notify_only)
 *   2. Builds the correct AIAction for auto cases
 *   3. Calls executeAction — the production executor
 *   4. Verifies success
 *   5. Updates HealthFinding.status  →  auto_fixed | pending_approval
 *   6. Writes an AuditLog entry
 *   7. Captures a post-fix WorkspaceSchemaSnapshot (schema-touching fixes only)
 *   8. Stores rollbackData in finding.details so one click can revert
 *   9. On any failure → escalates to pending_approval instead of leaving as open
 *
 * Public surface:
 *   runAutoFix(findingId, projectId)         — process one finding
 *   processOpenFindings(projectId)            — process all open findings in order
 *   buildFixAction(type, details)             — exported for the approve route
 */

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { captureSchemaSnapshot, rollbackToSchemaVersion } from '@/lib/services/workspace-schema-snapshot'
import {
  withSqlCapture,
  installSqlRecorder,
  type RecordedStatement,
} from '@/lib/execution/sql-recorder'
import { classifyFix } from './fix-classifier'
import { checkBreaker, auditBreakerTrip } from '@/lib/autonomy/circuit-breaker'
import { evaluateFixOutcome, captureCheckBaseline } from '@/lib/autonomy/desired-state'
import { FLAGS } from '@/lib/config/flags'
import { withBuildLock } from '@/lib/ai/build-runtime/build-lock'
import { normalizeFindingType } from './types'
import { buildFixAction, getManualRemediationHint } from './fix-actions'
import type { FindingType } from './types'
import type { AIAction } from '@/lib/ai/minimal-executor'
import type { FixPlan } from './fix-plan-generator'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutoFixResult {
  // 'deferred' = a transient governance condition (mutation cooldown, build-lock
  // contention, circuit-breaker window) blocked this attempt. The finding is
  // left OPEN and retried on the next loop tick — it is NOT a failure and is
  // NEVER escalated to a human. Escalating a timing condition to an approval
  // queue is what made the loop look non-autonomous.
  outcome: 'auto_fixed' | 'pending_approval' | 'notify_only' | 'escalated' | 'deferred'
  findingId: string
  message: string
  rollbackData?: Record<string, unknown>
}

// ── Fix action mapping ────────────────────────────────────────────────────────
//
// MOVED to lib/core/fix-actions.ts — a pure module with no prisma import, so the
// Autonomy queue (a client component) can ask "does a repair exist?" using the
// SAME function this engine executes. Rendering a fix button without being able
// to ask that question is what put an "Approve & fix" on findings the engine
// answers with "no automatic repair for it yet".
//
// Re-exported here so every existing import site keeps working unchanged.
export { hasExecutableFix, isDataPlaneOutage } from './fix-actions'
export { buildFixAction, getManualRemediationHint }

// ── Finding types that mutate the schema (need a snapshot after fix) ──────────

const SCHEMA_TOUCHING = new Set<FindingType>([
  'missing_fk',
  'missing_fk_index',
  'missing_rls',
  'rls_denies_everything',
  'rls_expression_invalid',
  'unprotected_user_data',
  'auth_users_table_missing',
  'realtime_gap',
  'shadow_mutation',
  'workflow_broken',
  'verification_failed',
  'orphan_table',           // Adoption can enable RLS — snapshot for rollback parity
  // The snapshot is the ONLY record of a dropped index's definition. Without it
  // here, approving the drop would be irreversible in practice — the rollback
  // engine restores indexes present in the target snapshot, and there would be
  // no target snapshot taken before the drop.
  'unused_index',
])

// ── Pre-fix state capture (the undo contract) ────────────────────────────────

/**
 * Action-specific pre-fix state for fixes whose mutation lives in PLATFORM
 * metadata rather than the workspace schema — a snapshot can't revert those.
 * Captured at fix time so revert restores exactly what existed before.
 */
export type PreFixMetadata =
  | { kind: 'rate_limit'; apiDefinitionId: string; prevRateLimit: number | null; prevConfigRateLimit: unknown }
  | { kind: 'api'; tableName: string | null; preExistingApiDefinitionIds: string[] }
  | { kind: 'permission'; tableName: string; prePolicies: Array<Record<string, unknown>> }

/**
 * Capture everything one-click undo needs, BEFORE the fix executes:
 *   • schema-touching fixes → a pre-fix WorkspaceSchemaSnapshot (the state the
 *     undo restores — capturing AFTER the fix was the bug that made every
 *     revert a 0-step no-op reporting success)
 *   • metadata fixes → the exact pre-fix platform rows/values
 */
async function capturePreFixState(
  projectId: string,
  baseType: FindingType,
  fixAction: Pick<AIAction, 'action' | 'params'>,
): Promise<{ preSnapshotId: string | null; preMetadata: PreFixMetadata | null; schemaTouching: boolean }> {
  const schemaTouching = SCHEMA_TOUCHING.has(baseType)
  const preSnapshot = schemaTouching
    ? await captureSchemaSnapshot(projectId, 'pre_migration').catch(() => null)
    : null

  let preMetadata: PreFixMetadata | null = null
  const tableName = (fixAction.params as Record<string, unknown>)?.tableName as string | undefined

  try {
    if (fixAction.action === 'SET_RATE_LIMIT' && tableName) {
      const table = await prisma.table.findFirst({ where: { projectId, name: tableName }, select: { id: true } })
      const apiDef = table
        ? await prisma.apiDefinition.findFirst({
            where: { projectId, tableId: table.id },
            select: { id: true, rateLimit: true, config: true },
          })
        : null
      if (apiDef) {
        preMetadata = {
          kind: 'rate_limit',
          apiDefinitionId: apiDef.id,
          prevRateLimit: apiDef.rateLimit ?? null,
          prevConfigRateLimit: ((apiDef.config as Record<string, unknown> | null) ?? {}).rateLimit ?? null,
        }
      }
    } else if (fixAction.action === 'FIX_API') {
      let ids: string[]
      if (tableName) {
        const table = await prisma.table.findFirst({ where: { projectId, name: tableName }, select: { id: true } })
        ids = table
          ? (await prisma.apiDefinition.findMany({ where: { projectId, tableId: table.id }, select: { id: true } })).map(d => d.id)
          : []
      } else {
        ids = (await prisma.apiDefinition.findMany({ where: { projectId }, select: { id: true } })).map(d => d.id)
      }
      preMetadata = { kind: 'api', tableName: tableName ?? null, preExistingApiDefinitionIds: ids }
    } else if (fixAction.action === 'SET_PERMISSION' && tableName) {
      const rows = await prisma.permissionPolicy.findMany({ where: { projectId, tableName } })
      preMetadata = { kind: 'permission', tableName, prePolicies: rows as unknown as Array<Record<string, unknown>> }
    }
  } catch {
    preMetadata = null
  }

  return { preSnapshotId: preSnapshot?.id ?? null, preMetadata, schemaTouching }
}

// ── Core engine ───────────────────────────────────────────────────────────────

/**
 * Process one HealthFinding end-to-end.
 * Safe to call on any finding regardless of current status — it re-reads from DB.
 */
export async function runAutoFix(
  findingId: string,
  projectId: string,
  // Test/verification harness only: bypass the 2-min post-mutation cooldown so
  // multiple deterministic fixes can be exercised in one run. The autonomous
  // reconciler NEVER passes this — cooldown pacing stays enforced in production.
  opts: { skipCooldown?: boolean } = {},
): Promise<AutoFixResult> {
  const finding = await prisma.healthFinding.findUnique({ where: { id: findingId } })
  if (!finding) {
    return { findingId, outcome: 'notify_only', message: 'Finding not found.' }
  }

  // Only process open findings (idempotency guard)
  if (finding.status !== 'open') {
    return {
      findingId,
      outcome: finding.status === 'auto_fixed' ? 'auto_fixed' : 'pending_approval',
      message: `Finding is already in status: ${finding.status}`,
    }
  }

  const type = finding.type as FindingType
  const details = (finding.details ?? {}) as Record<string, unknown>
  const classification = classifyFix(finding.type, details)

  // ── notify_only branch ──────────────────────────────────────────────────────
  if (classification.decision === 'notify_only') {
    return { findingId, outcome: 'notify_only', message: classification.reason }
  }

  // ── approval branch ─────────────────────────────────────────────────────────
  if (classification.decision === 'approval') {
    await prisma.healthFinding.update({
      where: { id: findingId },
      data: { status: 'pending_approval' },
    })
    await _writeAuditLog(projectId, 'HEALTH_FIX_AWAITING_APPROVAL', {
      findingId,
      findingType: type,
      reason: classification.reason,
    })
    return { findingId, outcome: 'pending_approval', message: classification.reason }
  }

  // ── auto branch ─────────────────────────────────────────────────────────────
  return _executeAutoFix(finding.id, projectId, type, details, opts)
}

/**
 * Force-execute the fix for a finding, bypassing the classification gate.
 * Used by the approve route after the user clicks "Fix".
 *
 * Runs with skipCooldown: a user-approved fix is an explicit human action and
 * must NOT be throttled by the autonomous-mutation cooldown / hourly budget —
 * those exist to rate-limit the background autonomy loop, not the human who
 * just clicked "Approve & fix". Applying the 2-min cooldown here was the bug
 * that made approvals dead-end with "Cooldown active — wait 119s … could not be
 * applied — left for your review" even for a trivially-safe fix. The advisory
 * lock (concurrency safety) still applies, so an approved fix never races a
 * concurrent build — it just waits for it via the retry loop below.
 *
 * Adds retry-with-backoff when the project's build-lock is contended — common
 * when a previous fix attempt left the pg advisory lock orphaned across a
 * Prisma connection-pool cycle. Up to 3 retries with 400ms / 1200ms / 3000ms
 * backoff before surfacing the error to the user.
 */
export async function executeApprovedFix(
  findingId: string,
  projectId: string,
): Promise<{
  success: boolean
  message: string
  snapshotId?: string
  rollbackData?: Record<string, unknown>
  /** Whether the gap was re-probed after the fix and confirmed gone. */
  verification?: 'confirmed' | 'unverified'
}> {
  const finding = await prisma.healthFinding.findUnique({ where: { id: findingId } })
  if (!finding) return { success: false, message: 'Finding not found.' }

  const type = finding.type as FindingType
  const details = (finding.details ?? {}) as Record<string, unknown>
  // Normalize so dynamic types (missing_rls_users, schema_drift, …) get the
  // correct snapshot/rollback treatment via their canonical base.
  const baseType = (normalizeFindingType(finding.type, details)?.base ?? type) as FindingType

  const fixAction = buildFixAction(finding.type, details)
  if (!fixAction) {
    // Friendly fallback for findings that require user input (e.g. orphan tables,
    // credential rotation). Surfaced verbatim to the dashboard instead of a
    // generic "no fix action mapped" message.
    const hint = getManualRemediationHint(type, details)
    return {
      success: false,
      message: hint
        ?? `This issue needs your manual review — open the relevant section of your dashboard to resolve it.`,
    }
  }

  // PRE-FIX capture — the state one-click undo restores (see capturePreFixState).
  const pre = await capturePreFixState(projectId, baseType, fixAction)

  // Baseline for the acceptance gate below (see the autonomous path for why).
  const baseline = await captureCheckBaseline(projectId).catch(() => null)

  // Retry on transient lock contention. A human clicked Approve — the right
  // behaviour is to WAIT for the lock, not bounce the wait back to the user.
  // The common holders (a Re-scan observer pass, the reconciler batch-applying
  // fixes, a build step) run for seconds to tens of seconds, so this waits up
  // to ~30s total before giving up. The 4.6s window this replaced lost the
  // race against any real scan and surfaced raw lock jargon to the user.
  const BACKOFFS_MS = [400, 1200, 3000, 5000, 8000, 12000]
  let result
  let lastLockError: string | null = null
  // What the executor actually sent to PostgreSQL, for the audit row. Captured
  // at the driver rather than reported by each executor, so a new repair cannot
  // silently record nothing. See lib/execution/sql-recorder.ts.
  installSqlRecorder(prisma as any)
  let statements: RecordedStatement[] = []

  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      const captured = await withSqlCapture(() => withBuildLock(
        projectId,
        'modify',
        async () => executeAction(
          { action: fixAction.action as AIAction['action'], params: fixAction.params },
          projectId,
          undefined, // apiKey
          0,         // retryCount
          undefined, // executionId
          false,     // allowReplan — deterministic autonomy fix, never LLM-replan
        ),
        // Human-approved: skip the autonomy cooldown/budget gate (see fn docs).
        { skipCooldown: true },
      ))
      const governed = captured.result
      // Only the attempt that actually ran contributes statements; a lock-
      // contention retry captured nothing and must not append an empty round.
      if (captured.statements.length > 0) statements = captured.statements
      if (governed.error) {
        lastLockError = governed.error
        // Retry on lock-contention. cooldown/budget are skipped above for the
        // approved path, but keep them in the retryable set as defense so a
        // governance timing error never dead-ends a fix the user explicitly
        // approved — it is always retried rather than surfaced as "could not
        // be applied".
        const lower = governed.error.toLowerCase()
        const isLockContention =
          lower.includes('another') ||
          lower.includes('in progress') ||
          lower.includes('already running') ||
          lower.includes('try again') ||
          lower.includes('cooldown') ||
          lower.includes('budget')
        if (!isLockContention) return { success: false, message: governed.error }
        if (attempt < BACKOFFS_MS.length) {
          await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]))
          continue
        }
        return {
          success: false,
          // Keep "in progress" in this string — the approve route and the
          // retry classifier above both key 409/retry behaviour off it.
          message:
            'Another change is still in progress on this project (a scan or auto-fix). Nothing was lost — your approval is recorded; press Approve again in a moment.',
        }
      }
      result = governed.result
      break
    } catch (err: any) {
      return { success: false, message: `Execution failed: ${err.message}` }
    }
  }

  if (!result) {
    return { success: false, message: lastLockError ?? 'Auto-fix could not acquire the project lock after retries.' }
  }

  if (!result.success) {
    return { success: false, message: result.error ?? result.message }
  }

  // ── Same trust guarantee the autonomous path enforces ──────────────────────
  // This path had NO post-fix verification: it reported success on the
  // executor's own say-so, and the ledger then rendered every approved fix as
  // "verified & snapshotted". A user who clicks Approve is extending more trust
  // than the loop takes on its own, so this is the last place that check should
  // have been missing. 'unresolved' is reported as a failure rather than a
  // success, which leaves the finding in the queue where the user can see it.
  // Unconditional, for the reason given on the autonomous path: gating this on a
  // table-shaped location exempted exactly the finding types a human is most
  // likely to be approving by hand — the auth pair, whose fix rewires sign-in for
  // every end-user of the project.
  let verification: 'confirmed' | 'unverified' = 'unverified'
  {
    const outcome = await evaluateFixOutcome(projectId, finding.type, details, baseline)
      .catch(() => null)
    if (outcome && outcome.recheck === 'unresolved') {
      return {
        success: false,
        message:
          'The fix ran but the issue is still present on re-check, so it was not recorded as fixed. ' +
          'Nothing was lost — the finding stays in your queue with the details.',
        verification: 'unverified',
      }
    }
    if (outcome && outcome.regressions.length > 0) {
      return {
        success: false,
        message:
          `The fix closed the issue it targeted but broke ${outcome.regressions.length} ` +
          `guarantee(s) that were holding before it ran, so it was not recorded as fixed. ` +
          `Use Undo in History to restore the pre-fix snapshot.`,
        verification: 'unverified',
      }
    }
    if (outcome?.recheck === 'resolved') verification = 'confirmed'
  }

  // Post-fix snapshot: version history only — never the undo target.
  const postSnapshot = SCHEMA_TOUCHING.has(baseType)
    ? await captureSchemaSnapshot(projectId, 'post_migration').catch(() => null)
    : null

  const rollbackData: Record<string, unknown> = {
    fixAction,
    fixResult: { message: result.message, data: result.data },
    // The statements the executor actually sent, captured at the driver. This
    // is the half of the audit trail that used to be missing: the change was
    // derivable by diffing two schema snapshots, but the statement itself was
    // never stored, so "show me what it ran" had no answer.
    statements,
    // UNDO CONTRACT (rollbackFormat 2): snapshotId is the PRE-fix state.
    rollbackFormat: 2,
    snapshotId: pre.preSnapshotId,
    postSnapshotId: postSnapshot?.id ?? null,
    preMetadata: pre.preMetadata,
    schemaTouching: pre.schemaTouching,
    fixedAt: new Date().toISOString(),
    verification,
  }

  return {
    success: true,
    message: result.message,
    snapshotId: pre.preSnapshotId ?? undefined,
    rollbackData,
    verification,
  }
}

// ── One-click undo ────────────────────────────────────────────────────────────

export interface RevertResult {
  success: boolean
  message: string
  /** True when the undo removes protection and needs explicit confirmation. */
  requiresConfirmation?: boolean
  appliedSteps?: number
}

/**
 * RLS-undo is a protection REMOVAL: the inverse of an additive Tier-1 fix is a
 * Tier-2 action (it re-exposes every user's rows), so it always requires
 * explicit confirmation — never one silent click.
 */
const RLS_PROTECTION_TYPES: ReadonlySet<string> = new Set([
  'missing_rls',
  'unprotected_user_data',
  'rls_expression_invalid',
])

/**
 * Can this recorded fix be undone, and does the undo need explicit consent?
 *
 * Deliberately a flat interface rather than a discriminated union: this repo
 * compiles with `strict: false`, so narrowing on a boolean-literal discriminant
 * does not happen and every consumer would need a cast. `reason` is populated
 * exactly when `revertible` is false.
 */
export interface RevertEligibility {
  revertible: boolean
  /** Undo removes protection (RLS) — always needs a second, explicit yes. */
  requiresConfirmation: boolean
  /** Why the undo is impossible. Present only when `revertible` is false. */
  reason?: string
}

/**
 * Decide revertibility from the RECORDED fix alone — no I/O, no side effects.
 *
 * This exists so the UI can only ever render an Undo button that will actually
 * work. The alternative was the failure this repo has already shipped once: a
 * "Fix now" button drawn under copy promising Backenly could fix it, which
 * returned an error on every click. An Undo button is worse to get wrong —
 * clicking it is how a user finds out whether they can trust the loop at all.
 *
 * `revertAutoFix` calls this as its own first gate, so the button's precondition
 * and the engine's precondition are one function and cannot drift.
 *
 * The three ways a fix is genuinely unrevertible are all knowable from the
 * finding row:
 *   • no rollbackData at all — the fix predates the undo contract entirely
 *   • rollbackFormat !== 2  — its snapshot was captured AFTER the fix, so a
 *     "revert" would restore the post-fix state and report success having done
 *     nothing (this is the bug format 2 exists to close)
 *   • schemaTouching with no snapshotId — capture failed at fix time, so there
 *     is no pre-fix state to go back to
 */
export function revertEligibility(
  findingType: string,
  details: Record<string, unknown> | null | undefined,
): RevertEligibility {
  const det = (details ?? {}) as Record<string, unknown>
  const rollbackData = det.rollbackData as Record<string, unknown> | undefined

  if (!rollbackData) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason: 'No rollback data was recorded for this fix, so it cannot be undone automatically.',
    }
  }

  if (rollbackData.rollbackFormat !== 2) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason:
        'This fix was recorded before revert support existed — its snapshot captures the state ' +
        'AFTER the fix, so an automatic undo would silently do nothing.',
    }
  }

  if (rollbackData.schemaTouching === true && !rollbackData.snapshotId) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason:
        'No pre-fix snapshot was captured when this fix ran, so there is no recorded state to ' +
        'restore.',
    }
  }

  const baseType = (normalizeFindingType(findingType, det)?.base ?? findingType) as string
  return { revertible: true, requiresConfirmation: RLS_PROTECTION_TYPES.has(baseType) }
}

/**
 * Revert an auto-fixed finding to its recorded pre-fix state.
 *
 * The undo contract (rollbackFormat 2):
 *   • schema-touching fixes → rollbackToSchemaVersion(PRE-fix snapshot), whose
 *     DDL engine now diffs indexes (both directions), FK constraints, RLS
 *     policies, and triggers
 *   • metadata fixes → the exact pre-fix rows/values from preMetadata
 *   • legacy fixes (pre-contract) are REFUSED honestly — their snapshot is
 *     post-fix, so "reverting" to it would no-op while claiming success
 *
 * Pure engine logic: does NOT flip finding status or write audit rows — the
 * caller (route / verifier) owns that, because it owns the actor identity.
 */
export async function revertAutoFix(
  findingId: string,
  projectId: string,
  opts: { confirmed?: boolean } = {},
): Promise<RevertResult> {
  const finding = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId, status: 'auto_fixed' },
  })
  if (!finding) return { success: false, message: 'Finding not found or not in auto_fixed state.' }

  const details = (finding.details ?? {}) as Record<string, unknown>
  const rollbackData = details.rollbackData as Record<string, unknown> | undefined

  // One gate, shared with the UI (see revertEligibility). Checked BEFORE the
  // confirmation prompt on purpose: asking a user to confirm re-exposing their
  // data, and only then telling them the undo was never possible, is a worse
  // interaction than refusing up front.
  const eligibility = revertEligibility(finding.type, details)
  if (!eligibility.revertible) {
    return {
      success: false,
      message:
        `${eligibility.reason} Undo it manually from the Database section, or ask your coding agent.`,
    }
  }
  if (!rollbackData) {
    // Unreachable: the predicate refuses a missing rollbackData above. Present
    // so the narrowing below is the compiler's, not a human's assertion.
    return { success: false, message: 'No rollback data recorded for this fix.' }
  }

  if (eligibility.requiresConfirmation && !opts.confirmed) {
    const tbl = (details.tableName ?? details.table ?? 'this table') as string
    return {
      success: false,
      requiresConfirmation: true,
      message:
        `Undoing this fix removes row-level security from "${tbl}" — every signed-in end-user ` +
        `will be able to read and modify every other user's rows again. Confirm to proceed.`,
    }
  }

  // ── Schema-side revert (workspace schema = the enforcement truth) ──────────
  let appliedSteps = 0
  let schemaMessage = ''
  if (rollbackData.schemaTouching === true) {
    // Non-null by the eligibility gate above, which refuses schemaTouching
    // fixes that never captured one.
    const snapshotId = rollbackData.snapshotId as string
    const snapshot = await prisma.workspaceSchemaSnapshot.findUnique({
      where: { id: snapshotId },
      select: { versionNum: true },
    })
    if (!snapshot) return { success: false, message: `Rollback snapshot ${snapshotId} no longer exists.` }

    const res = await rollbackToSchemaVersion(projectId, snapshot.versionNum)
    if (!res.success) return { success: false, message: `Schema rollback failed: ${res.error}` }
    appliedSteps = res.appliedSteps
    schemaMessage = `schema restored to pre-fix version ${snapshot.versionNum} ` +
      `(${res.appliedSteps} step${res.appliedSteps === 1 ? '' : 's'} applied)`
  }

  // ── Metadata-side revert (platform rows the snapshot can't see) ────────────
  const preMetadata = rollbackData.preMetadata as (PreFixMetadata & Record<string, unknown>) | null
  let metaMessage = ''
  try {
    if (preMetadata?.kind === 'rate_limit') {
      const prevRateLimit = (preMetadata.prevRateLimit as number | null) ?? null
      const apiDef = await prisma.apiDefinition.findUnique({
        where: { id: preMetadata.apiDefinitionId as string },
        select: { config: true },
      })
      if (apiDef) {
        const config = { ...((apiDef.config as Record<string, unknown> | null) ?? {}) }
        if (preMetadata.prevConfigRateLimit === null || preMetadata.prevConfigRateLimit === undefined) {
          delete config.rateLimit
        } else {
          config.rateLimit = preMetadata.prevConfigRateLimit
        }
        await prisma.apiDefinition.update({
          where: { id: preMetadata.apiDefinitionId as string },
          data: { rateLimit: prevRateLimit, config: config as any },
        })
        metaMessage = 'rate limit restored to its previous value'
      }
    } else if (preMetadata?.kind === 'api') {
      const preIds = (preMetadata.preExistingApiDefinitionIds as string[]) ?? []
      const tableName = (preMetadata.tableName as string | null) ?? null
      let where: Record<string, unknown> = { projectId, id: { notIn: preIds } }
      if (tableName) {
        const table = await prisma.table.findFirst({ where: { projectId, name: tableName }, select: { id: true } })
        if (!table) {
          // Table itself is gone — nothing left to unwind on the API side.
          where = { projectId, id: { in: [] } }
        } else {
          where = { projectId, tableId: table.id, id: { notIn: preIds } }
        }
      }
      const removed = await prisma.apiDefinition.deleteMany({ where: where as any })
      metaMessage = `${removed.count} generated API definition${removed.count === 1 ? '' : 's'} removed`
    } else if (preMetadata?.kind === 'permission') {
      const tableName = preMetadata.tableName as string
      const prePolicies = (preMetadata.prePolicies as Array<Record<string, unknown>>) ?? []
      await prisma.permissionPolicy.deleteMany({ where: { projectId, tableName } })
      if (prePolicies.length > 0) {
        await prisma.permissionPolicy.createMany({ data: prePolicies as any, skipDuplicates: true })
      }
      metaMessage = 'permission policy metadata restored to its pre-fix state'
    }
  } catch (err: any) {
    // The schema side (the real enforcement) may already be reverted — report
    // the partial state honestly instead of a blanket success or failure.
    const done = schemaMessage ? ` Schema was reverted (${schemaMessage}), but` : ''
    return { success: false, message: `${done} platform metadata restore failed: ${err.message}` }
  }

  const parts = [schemaMessage, metaMessage].filter(Boolean)
  return {
    success: true,
    appliedSteps,
    message: parts.length > 0 ? `Fix reverted — ${parts.join('; ')}.` : 'Fix reverted.',
  }
}

// ── Chat-driven resolution (paste-a-screenshot → fix) ─────────────────────────

export interface ChatResolveResult {
  outcome: 'fixed' | 'needs_confirmation' | 'notify' | 'not_found' | 'failed'
  message: string
  findingId?: string
  findingType?: string
}

/**
 * Resolve a single HealthFinding from the AI chat (the brain's resolve_finding
 * tool). Classification-aware, mirroring the autonomy safety contract:
 *
 *   auto        → apply immediately through the governed executor + verify
 *   approval    → only apply when the user has confirmed this turn; otherwise
 *                 return needs_confirmation with the risk so the brain can ask
 *   notify_only → return the manual-remediation guidance, never auto-act
 *
 * Reuses executeApprovedFix for the actual governed execution (advisory lock +
 * skipCooldown, since this is a human-initiated chat action) and persists the
 * same fixed-state / audit / fix-history the dashboard approve route writes, so
 * a finding resolved from chat looks identical to one resolved from the
 * dashboard — and the target-aware escalation memory stays correct.
 */
export async function resolveFindingFromChat(
  findingId: string,
  projectId: string,
  opts: { confirmed?: boolean; userId?: string; userEmail?: string } = {},
): Promise<ChatResolveResult> {
  const finding = await prisma.healthFinding.findFirst({ where: { id: findingId, projectId } })
  if (!finding) return { outcome: 'not_found', message: 'That issue was not found on this project.' }

  if (finding.status === 'auto_fixed' || finding.status === 'dismissed') {
    return { outcome: 'fixed', message: 'That issue is already resolved.', findingId, findingType: finding.type }
  }

  const type = finding.type as FindingType
  const details = (finding.details ?? {}) as Record<string, unknown>
  const cls = classifyFix(finding.type, details)

  if (cls.decision === 'notify_only') {
    const hint = getManualRemediationHint(finding.type, details)
    return { outcome: 'notify', message: hint ?? cls.reason, findingId, findingType: finding.type }
  }

  if (cls.decision === 'approval' && !opts.confirmed) {
    const risk = cls.riskNote ? ` (${cls.riskNote})` : ''
    return {
      outcome: 'needs_confirmation',
      message: `${cls.reason}${risk} Confirm and I'll apply it.`,
      findingId,
      findingType: finding.type,
    }
  }

  // auto, or approval the user just confirmed → execute through the governed path.
  const result = await executeApprovedFix(findingId, projectId)
  if (!result.success) {
    await _writeAuditLog(projectId, 'HEALTH_FIX_EXECUTION_FAILED', {
      findingId, findingType: type, error: result.message, via: 'chat',
    })
    return { outcome: 'failed', message: result.message, findingId, findingType: finding.type }
  }

  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status: 'auto_fixed',
      autoFixed: true,
      fixAppliedAt: new Date(),
      details: {
        ...details,
        rollbackData: {
          ...(result.rollbackData ?? {}),
          resolvedVia: 'chat',
          resolvedBy: opts.userId ?? null,
          resolvedAt: new Date().toISOString(),
        },
      } as any,
    },
  })

  await _writeAuditLog(projectId, 'HEALTH_FIX_RESOLVED_VIA_CHAT', {
    findingId,
    findingType: type,
    tableName: (details.tableName ?? details.table ?? details.location ?? null) as string | null,
    columnName: (details.columnName ?? details.column ?? null) as string | null,
    message: result.message,
    snapshotId: result.snapshotId ?? null,
  })

  // Record fix history so the (target-aware) re-appearance escalation works.
  try {
    const { writeFixHistory, buildResolutionText } = await import('@/lib/memory/fix-history')
    await writeFixHistory(projectId, {
      findingType: type,
      findingSeverity: finding.severity as any,
      status: 'auto_fixed',
      details,
      resolution: buildResolutionText(type, details, false),
      automatic: false,
    })
  } catch { /* non-fatal */ }

  return { outcome: 'fixed', message: result.message, findingId, findingType: finding.type }
}

/**
 * Resolve the best-matching open/pending finding from a loose target spec when
 * the chat agent doesn't have an explicit findingId (e.g. it diagnosed from a
 * screenshot). Matches by type and/or table+column among actionable findings.
 * Returns the finding id, or null when nothing matches (or it's ambiguous).
 */
export async function findResolvableFinding(
  projectId: string,
  spec: { findingType?: string; tableName?: string; columnName?: string },
): Promise<string | null> {
  const candidates = await prisma.healthFinding.findMany({
    where: { projectId, status: { in: ['open', 'pending_approval'] } },
    orderBy: { detectedAt: 'desc' },
  })
  if (candidates.length === 0) return null

  const wantType = spec.findingType?.toLowerCase()
  const wantTable = spec.tableName?.toLowerCase()
  const wantCol = spec.columnName?.toLowerCase()

  const scored = candidates
    .map((f) => {
      const det = (f.details ?? {}) as Record<string, unknown>
      const tbl = String(det.tableName ?? '').toLowerCase()
      const col = String(det.columnName ?? '').toLowerCase()
      let score = 0
      if (wantType && f.type.toLowerCase() === wantType) score += 2
      if (wantTable && tbl && tbl === wantTable) score += 2
      if (wantCol && col && col === wantCol) score += 1
      return { id: f.id, score }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored[0]?.id ?? null
}

/**
 * Process all open findings for a project, ordered critical-first.
 * Called by the workspace observer on each health-check cycle.
 */
export async function processOpenFindings(projectId: string): Promise<AutoFixResult[]> {
  const severityOrder = { critical: 0, warning: 1, info: 2 }

  const findings = await prisma.healthFinding.findMany({
    where: { projectId, status: 'open' },
    orderBy: [{ detectedAt: 'asc' }],
  })

  // Sort critical before warning before info
  findings.sort((a, b) => {
    const aRank = severityOrder[a.severity as keyof typeof severityOrder] ?? 3
    const bRank = severityOrder[b.severity as keyof typeof severityOrder] ?? 3
    return aRank - bRank
  })

  const results: AutoFixResult[] = []
  for (const f of findings) {
    // Run sequentially so each fix is verified before the next begins
    results.push(await runAutoFix(f.id, projectId))
  }
  return results
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _executeAutoFix(
  findingId: string,
  projectId: string,
  type: FindingType,
  details: Record<string, unknown>,
  opts: { skipCooldown?: boolean } = {},
): Promise<AutoFixResult> {
  const baseType = (normalizeFindingType(type, details)?.base ?? type) as FindingType
  const fixAction = buildFixAction(type, details)
  if (!fixAction) {
    return { findingId, outcome: 'notify_only', message: `No fix action mapped for type: ${type}` }
  }

  // Autonomy circuit breaker — hard ceiling on autonomous mutations/project/
  // window. Tripping degrades to pending_approval (non-destructive), never a
  // silent skip: the finding stays visible and a human can still act on it.
  const breaker = await checkBreaker(projectId)
  if (!breaker.allowed) {
    await auditBreakerTrip(projectId, breaker.reason ?? 'circuit open')
    // Breaker open is a RATE condition, not a risk one — defer & retry next
    // window. Escalating it to a human was the bug that buried auto-safe work.
    return _deferred(findingId, projectId, type, details, breaker.reason ?? 'autonomy circuit breaker open')
  }

  // PRE-FIX capture — the state one-click undo restores. Must happen BEFORE
  // the mutation; the post-fix snapshot below is version history only.
  const pre = await capturePreFixState(projectId, baseType, fixAction)

  // Baseline of which guarantees currently HOLD, so the acceptance gate below
  // can tell "this fix broke something" from "this was already broken". Without
  // a before-state there is nothing to compare against and a regression is
  // indistinguishable from a pre-existing failure, so the gate degrades to
  // target-only verification rather than guessing.
  const baseline = await captureCheckBaseline(projectId).catch(() => null)

  let result
  installSqlRecorder(prisma as any)
  let statements: RecordedStatement[] = []
  try {
    const captured = await withSqlCapture(() => withBuildLock(
      projectId,
      'modify',
      async () => executeAction(
        { action: fixAction.action as AIAction['action'], params: fixAction.params },
        projectId,
        undefined, // apiKey
        0,         // retryCount
        undefined, // executionId
        false,     // allowReplan — deterministic autonomy fix, never LLM-replan
      ),
      { skipCooldown: opts.skipCooldown },
    ))
    const governed = captured.result
    statements = captured.statements
    if (governed.error) {
      return _isTransientGovernanceError(governed.error)
        ? _deferred(findingId, projectId, type, details, governed.error)
        : _escalate(findingId, projectId, type, details, governed.error)
    }
    result = governed.result
  } catch (err: any) {
    const msg = `Execution threw: ${err.message}`
    return _isTransientGovernanceError(err?.message)
      ? _deferred(findingId, projectId, type, details, msg)
      : _escalate(findingId, projectId, type, details, msg)
  }

  if (!result!.success) {
    const reason = result!.error ?? result!.message
    return _isTransientGovernanceError(reason)
      ? _deferred(findingId, projectId, type, details, reason)
      : _escalate(findingId, projectId, type, details, reason)
  }

  // ── TRUST GUARANTEE: a fix is only "fixed" if the gap actually closed ───────
  // The executor can return success for work that did not resolve the finding —
  // a replan-to-INFO no-op, a default routine that swallowed a real failure, or
  // a fix that ran but left the underlying gap in place. Re-probe the SPECIFIC
  // gap; certify auto_fixed only when it is genuinely gone. If it is still
  // positively present, escalate instead of recording a fix that did not happen.
  // This single check makes every fix path honest regardless of its own quirks.
  //
  // The verdict is CARRIED, not discarded. 'unknown' (no probe covers this type,
  // or the owning probe errored) is still allowed to record a fix — refusing
  // would bury auto-safe work — but it must not be counted as verified. The
  // trust scoreboard reads `verification` so "100% verified" means "re-probed
  // and confirmed gone", not "nobody rolled it back".
  //
  // This runs for EVERY fix. It used to be gated on
  // `details.location ?? tableName ?? table` being present, which silently
  // exempted every finding type that is not located by a table — and those are
  // not the harmless ones. `schema_not_registered` is `auto`-rated, is covered by
  // the `data_plane_is_registered` probe, and means one customer's entire /db/*
  // plane is dead; its details carry `{ reason, schema, tableCount }` and no
  // location, so its fix was recorded `auto_fixed` without a single re-probe.
  // `workflow_broken` was exempted the same way even though `gapIdentity` was
  // deliberately taught to locate workflows by `details.workflow`, and the
  // approval path exempted `auth_jwt_missing` / `auth_users_table_missing` — the
  // fixes a human extends the MOST trust to.
  //
  // The guard was also redundant: `evaluateFixOutcome` already answers 'unknown'
  // for any type no probe covers, which is precisely the case the location check
  // was reaching for. Deleting it costs nothing (the baseline diff above is
  // already computed unconditionally) and closes the hole.
  let verification: 'confirmed' | 'unverified' = 'unverified'
  {
    const outcome = await evaluateFixOutcome(projectId, type, details, baseline)
      .catch(() => null)
    if (outcome && !outcome.accepted && outcome.recheck !== 'unknown') {
      return _escalate(findingId, projectId, type, details, outcome.reason)
    }
    // A regression is disqualifying even when closure could not be confirmed:
    // "I could not prove I helped, and something that used to hold now fails"
    // is the worst outcome to record as a fix.
    if (outcome && outcome.regressions.length > 0) {
      return _escalate(findingId, projectId, type, details, outcome.reason)
    }
    if (outcome?.recheck === 'resolved') verification = 'confirmed'
  }

  // Post-fix snapshot: version history / diff surface only — NEVER the undo
  // target (reverting to a post-fix snapshot is a 0-step no-op).
  const postSnapshot = SCHEMA_TOUCHING.has(baseType)
    ? await captureSchemaSnapshot(projectId, 'post_migration').catch(() => null)
    : null

  const rollbackData: Record<string, unknown> = {
    fixAction,
    fixResult: { message: result.message, data: result.data },
    // The statements the executor actually sent, captured at the driver. This
    // is the half of the audit trail that used to be missing: the change was
    // derivable by diffing two schema snapshots, but the statement itself was
    // never stored, so "show me what it ran" had no answer.
    statements,
    // UNDO CONTRACT (rollbackFormat 2): snapshotId is the PRE-fix state.
    rollbackFormat: 2,
    snapshotId: pre.preSnapshotId,
    postSnapshotId: postSnapshot?.id ?? null,
    preMetadata: pre.preMetadata,
    schemaTouching: pre.schemaTouching,
    fixedAt: new Date().toISOString(),
    verification,
  }

  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status: 'auto_fixed',
      autoFixed: true,
      fixAppliedAt: new Date(),
      details: { ...details, rollbackData } as any,
    },
  })

  await _writeAuditLog(projectId, 'HEALTH_AUTO_FIXED', {
    findingId,
    findingType: type,
    // Carry the WHAT (table / column) into the audit row so every surface
    // (welcome-back banner, in-flow toaster, activity feed, trust report)
    // renders the real name. Without these, because-copy fell back to the
    // literal string "a table" and 30 distinct fixes rendered as 30 dupes.
    tableName: (details.tableName ?? details.table ?? details.location ?? null) as string | null,
    columnName: (details.columnName ?? details.column ?? null) as string | null,
    fixAction,
    message: result.message,
    snapshotId: pre.preSnapshotId,
    postSnapshotId: postSnapshot?.id ?? null,
    // The statements this fix actually ran. Duplicated onto the audit row rather
    // than left only in finding.details, because the audit log is the record
    // that survives the finding being dismissed or the project's queue being
    // cleared — and "what did it run" is a question asked long after.
    statements,
    // Read by the trust scoreboard: only 'confirmed' fixes count as verified.
    verification,
  })

  return { findingId, outcome: 'auto_fixed', message: result.message, rollbackData }
}

async function _escalate(
  findingId: string,
  projectId: string,
  type: FindingType,
  details: Record<string, unknown>,
  reason: string,
): Promise<AutoFixResult> {
  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status: 'pending_approval',
      // Persist WHY onto the finding itself, not only the audit log. The
      // Review Queue reads finding.details — without this it cannot tell "the
      // loop tried, verified, and the fix did not hold" apart from "policy
      // gates this on a human", and renders the guardrail line for both. That
      // mislabel made Autopilot look like it asks permission for safe fixes.
      details: {
        ...details,
        escalation: {
          // Carry the retry bookkeeping the reconciler wrote before handing this
          // finding back (lib/autonomy/reconciler.ts → reopenIfRetryable).
          // Overwriting it would reset the attempt counter on every failure, and
          // a fix that can never succeed would then be retried forever on the
          // shortest rung of the backoff ladder — turning a bounded recovery
          // path into the unbounded one it replaced.
          ...((details.escalation ?? {}) as Record<string, unknown>),
          reason,
          at: new Date().toISOString(),
        },
      } as any,
    },
  })
  await _writeAuditLog(projectId, 'HEALTH_FIX_ESCALATED', {
    findingId,
    findingType: type,
    tableName: (details.tableName ?? details.table ?? details.location ?? null) as string | null,
    columnName: (details.columnName ?? details.column ?? null) as string | null,
    escalationReason: reason,
  })
  return {
    findingId,
    outcome: 'escalated',
    message: `Auto-fix failed and was escalated for manual approval. Reason: ${reason}`,
  }
}

/**
 * True when an error means "this couldn't run *right now* for a timing reason"
 * — a mutation cooldown, build-lock contention, an in-progress build, or the
 * autonomy circuit-breaker window. None of these mean the fix is unsafe or
 * needs human judgement; they just need the next tick. Mirrors the
 * lock-contention vocabulary executeApprovedFix already retries on, plus
 * 'cooldown' (the exact prod escalation reason we observed).
 */
function _isTransientGovernanceError(reason: string | null | undefined): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('cooldown') ||
    r.includes('circuit breaker') ||
    r.includes('another') ||
    r.includes('in progress') ||
    r.includes('already running') ||
    r.includes('try again') ||
    r.includes('rate ceiling') ||
    r.includes('budget exhausted')
  )
}

/**
 * Defer (not escalate). Leaves the finding OPEN so the next loop tick retries.
 * Writes a low-noise audit row for observability — deliberately NOT
 * HEALTH_FIX_ESCALATED, so deferred work never enters the human approval queue
 * or the "while you were away" banner.
 */
async function _deferred(
  findingId: string,
  projectId: string,
  type: FindingType,
  details: Record<string, unknown>,
  reason: string,
): Promise<AutoFixResult> {
  await _writeAuditLog(projectId, 'HEALTH_FIX_DEFERRED', {
    findingId,
    findingType: type,
    tableName: (details.tableName ?? details.table ?? details.location ?? null) as string | null,
    columnName: (details.columnName ?? details.column ?? null) as string | null,
    deferReason: reason,
  })
  return {
    findingId,
    outcome: 'deferred',
    message: `Deferred (will retry automatically): ${reason}`,
  }
}

async function _writeAuditLog(
  projectId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      projectId,
      action,
      type: 'health',
      details: JSON.stringify(payload),
      timestamp: new Date(),
    },
  })
}

// ── Phase 12 — FixPlan execution ──────────────────────────────────────────────

export interface FixPlanResult {
  planId: string
  findingId: string
  outcome: 'auto_executed' | 'queued_approval' | 'notify_only' | 'skipped_flag_off' | 'failed'
  message: string
}

/**
 * Map a FixPlanAction to the concrete AIAction the executor understands.
 * Returns null when the action has no direct executor mapping (e.g. runtimes
 * that require new executor vocabulary).
 */
function _fixPlanToAiAction(
  plan: FixPlan,
): Pick<AIAction, 'action' | 'params'> | null {
  switch (plan.action) {
    case 'apply_rls':
    case 'close_security_gap':
      return {
        action: 'SET_PERMISSION',
        params: { tableName: plan.target, template: 'own_rows', userIdColumn: 'user_id' },
      }

    case 'generate_api':
      return {
        action: 'GENERATE_API',
        params: { tableName: plan.target },
      }

    case 'fix_auth':
      return {
        action: 'FIX_AUTH',
        params: { issue: plan.findingType },
      }

    case 'provision_runtime':
      // Provisioning maps to GENERATE_FUNCTION as the closest existing action.
      // Full queue/worker provisioning will require a new executor verb.
      return {
        action: 'GENERATE_FUNCTION',
        params: { name: `provision_${plan.target}`, trigger: 'queue' },
      }

    case 'connect_integration':
    case 'run_verification':
    case 'clarify_workflow':
    case 'clarify_business_rule':
    case 'notify_only':
    default:
      return null
  }
}

/**
 * Execute or queue one FixPlan.
 *
 * Execution guardrails (all must pass for auto-execution):
 *   1. plan.notifyOnly must be false
 *   2. FLAGS.ENABLE_AUTO_FIX_EXECUTION must be true
 *   3. plan.requiresApproval must be false
 *   4. plan.autoFixable must be true
 *
 * Integration credential plans (connect_integration) are never auto-executed
 * regardless of flags — they always require human approval.
 */
export async function runFixPlan(plan: FixPlan, projectId: string): Promise<FixPlanResult> {
  const base = { planId: plan.id, findingId: plan.findingId }

  if (plan.notifyOnly) {
    return { ...base, outcome: 'notify_only', message: 'Plan is informational only — no action taken.' }
  }

  if (!FLAGS.ENABLE_AUTO_FIX_EXECUTION) {
    return { ...base, outcome: 'skipped_flag_off', message: 'ENABLE_AUTO_FIX_EXECUTION is off — plan not executed.' }
  }

  if (plan.requiresApproval) {
    await _writeAuditLog(projectId, 'FIX_PLAN_AWAITING_APPROVAL', {
      planId: plan.id,
      findingId: plan.findingId,
      action: plan.action,
      target: plan.target,
      reason: plan.reason,
    })
    return { ...base, outcome: 'queued_approval', message: `Fix requires human approval: ${plan.reason}` }
  }

  if (!plan.autoFixable) {
    return { ...base, outcome: 'notify_only', message: 'Plan is not auto-fixable.' }
  }

  const aiAction = _fixPlanToAiAction(plan)
  if (!aiAction) {
    return { ...base, outcome: 'notify_only', message: `No executor action mapped for plan action: ${plan.action}` }
  }

  // Autonomy circuit breaker — same ceiling as the finding path. Tripping
  // queues the plan for human approval instead of auto-running it.
  const breaker = await checkBreaker(projectId)
  if (!breaker.allowed) {
    await auditBreakerTrip(projectId, breaker.reason ?? 'circuit open')
    await _writeAuditLog(projectId, 'FIX_PLAN_AWAITING_APPROVAL', {
      planId: plan.id,
      findingId: plan.findingId,
      action: plan.action,
      target: plan.target,
      reason: breaker.reason ?? 'autonomy circuit breaker open',
    })
    return { ...base, outcome: 'queued_approval', message: breaker.reason ?? 'autonomy circuit breaker open — queued for approval' }
  }

  let result
  try {
    const governed = await withBuildLock(
      projectId,
      'modify',
      async () => executeAction(
        { action: aiAction.action as AIAction['action'], params: aiAction.params },
        projectId,
        undefined, // apiKey
        0,         // retryCount
        undefined, // executionId
        false,     // allowReplan — deterministic autonomy fix, never LLM-replan
      ),
    )
    if (governed.error) {
      await _writeAuditLog(projectId, 'FIX_PLAN_FAILED', {
        planId: plan.id, action: plan.action, target: plan.target, error: governed.error,
      })
      return { ...base, outcome: 'failed', message: governed.error }
    }
    result = governed.result
  } catch (err: any) {
    await _writeAuditLog(projectId, 'FIX_PLAN_FAILED', {
      planId: plan.id, action: plan.action, target: plan.target, error: err?.message,
    })
    return { ...base, outcome: 'failed', message: `Execution threw: ${err.message}` }
  }

  if (!result!.success) {
    await _writeAuditLog(projectId, 'FIX_PLAN_FAILED', {
      planId: plan.id, action: plan.action, target: plan.target, error: result!.error ?? result!.message,
    })
    return { ...base, outcome: 'failed', message: result!.error ?? result!.message }
  }

  await _writeAuditLog(projectId, 'FIX_PLAN_AUTO_EXECUTED', {
    planId: plan.id, action: plan.action, target: plan.target, message: result.message,
  })
  return { ...base, outcome: 'auto_executed', message: result.message }
}

/**
 * Execute or queue a batch of FixPlans in order.
 * Critical-severity plans run first.
 */
export async function processFixPlans(plans: FixPlan[], projectId: string): Promise<FixPlanResult[]> {
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
  const sorted = [...plans].sort((a, b) =>
    (severityOrder[a.findingSeverity] ?? 3) - (severityOrder[b.findingSeverity] ?? 3)
  )

  const results: FixPlanResult[] = []
  for (const plan of sorted) {
    results.push(await runFixPlan(plan, projectId))
  }
  return results
}
