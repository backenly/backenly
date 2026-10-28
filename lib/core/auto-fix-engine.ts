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
import { randomUUID } from 'crypto'
import { regionRawClient } from '@/lib/data-plane/regional'
import { HOME_REGION } from '@/lib/regions'
import {
  findingDetailsKeptHere,
  quotedError,
  quotesKeptHere,
  recordedFixAction,
  recordedFixResult,
  recordedResultMessage,
  recordedStatements,
} from '@/lib/data-plane/residency'
import { HeldActionUnreadable, heldActionForReplay } from '@/lib/operational-memory/held-action-targets'
import { captureSchemaSnapshot } from '@/lib/services/workspace-schema-snapshot'
import {
  withSqlCapture,
  installSqlRecorder,
  type RecordedStatement,
} from '@/lib/execution/sql-recorder'
import { classifyFix } from './fix-classifier'
import { checkBreaker, auditBreakerTrip } from '@/lib/autonomy/circuit-breaker'
import { evaluateFixOutcome, captureCheckBaseline, type FixOutcome } from '@/lib/autonomy/desired-state'
import { FLAGS } from '@/lib/config/flags'
import { withBuildLock } from '@/lib/ai/build-runtime/build-lock'
import { normalizeFindingType } from './types'
import type { FixVerification } from './fix-verification'
import { buildFixAction, getManualRemediationHint } from './fix-actions'
import type { FindingType } from './types'
import type { AIAction } from '@/lib/ai/minimal-executor'
import type { FixPlan } from './fix-plan-generator'
import {
  capturePolicies,
  recoveryRestorePolicies,
  samePolicies,
  type PolicyCapture,
} from '@/lib/autonomy/maintenance/primitives/recovery-restore-policies'

/**
 * The SQL recorder (lib/execution/sql-recorder.ts) on both home-region clients.
 * A home project's workspace SQL runs on the home workspace client, not the
 * platform client (lib/data-plane/regional.ts), and a repair's statements are
 * mostly that SQL.
 */
function installHomeSqlRecorders(): void {
  installSqlRecorder(prisma as any)
  installSqlRecorder(regionRawClient(HOME_REGION) as any)
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutoFixResult {
  // 'deferred' = a transient governance condition (mutation cooldown, build-lock
  // contention, circuit-breaker window) blocked this attempt. The finding is
  // left OPEN and retried on the next loop tick — it is NOT a failure and is
  // NEVER escalated to a human. Escalating a timing condition to an approval
  // queue is what made the loop look non-autonomous.
  // 'applied_unverified' = the mutation ran and the acceptance probe could not
  // produce evidence either way. NOT success and NOT failure: a verifier that
  // throws proves nothing about the repair. It is its own outcome so callers
  // cannot count it as a fix, and so the reconciler can stop making dependent
  // repairs on state it has not confirmed.
  // 'held' = an architecture change is working on the finding's table
  // (lib/evolution-engine/holds.ts). Nothing ran and the finding stays OPEN; it
  // is repaired on the first pass after the change is in place. Unlike
  // 'deferred' it says nothing about the rest of the pass: other tables'
  // repairs go on.
  outcome:
    | 'auto_fixed'
    | 'applied_unverified'
    | 'pending_approval'
    | 'notify_only'
    | 'escalated'
    | 'deferred'
    | 'held'
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
  // An AI proposal knows its action touches the schema even when the finding
  // type's deterministic repairs do not (intent_drift: the column it adds).
  opts: { schemaTouching?: boolean } = {},
): Promise<{ preSnapshotId: string | null; preMetadata: PreFixMetadata | null; schemaTouching: boolean }> {
  const schemaTouching = opts.schemaTouching ?? SCHEMA_TOUCHING.has(baseType)
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

/**
 * Run a fix as governed changes grouped under one id (lib/changes), and say
 * which changes it made. Its undo restores exactly those, scoped to what they
 * touched and refused if anything later touched the same tables. The undo this
 * replaced restored the whole schema to a snapshot, which also archived every
 * table and column anyone had added since the fix.
 */
async function withFixGroup<T>(findingId: string, fn: () => Promise<T>): Promise<{ result: T; changeIds: string[] }> {
  const { withChangeAttribution, currentAttribution } = await import('@/lib/changes/attribution')
  const groupId = `fix:${findingId}:${randomUUID().slice(0, 8)}`
  const result = await withChangeAttribution({ source: currentAttribution()?.source ?? 'autonomy', groupId }, fn)
  return { result, changeIds: await changesInGroup(groupId) }
}

/**
 * The governed changes a fix group made, newest first. The fix has already run
 * by now, so failing to read them must not make it look as if it had not:
 * none recorded means its Undo says so (revertEligibility).
 */
async function changesInGroup(groupId: string): Promise<string[]> {
  try {
    const changes = await prisma.backendChange.findMany({ where: { groupId, kind: 'change' }, orderBy: { seq: 'desc' }, select: { id: true } })
    return changes.map((c) => c.id)
  } catch {
    return []
  }
}

// ── Core engine ───────────────────────────────────────────────────────────────

/**
 * Process one HealthFinding end-to-end.
 * Safe to call on any finding regardless of current status — it re-reads from DB.
 */
/**
 * Who is asking for this fix, and therefore which rules apply.
 *
 * Required at every call site rather than defaulted, because the default would
 * decide the safety posture of whichever caller forgot to think about it. The
 * two are genuinely different acts: a person clicking "fix this" has already
 * authorised it by clicking, and the autonomous loop has authorised nothing
 * until the Authority Decision says so.
 */
export type FixActor =
  /**
   * The autonomous loop. MUST pass the Authority Decision, which is evaluated
   * here rather than at the caller so no entry point can skip it by omission.
   */
  | { kind: 'autonomous'; loop: 'reconciler' | 'maintenance' }
  /**
   * A person, through an authenticated surface. Not autonomy: the click IS the
   * authorisation, and gating it behind a standing grant would mean a user
   * could not fix their own backend without first delegating to a robot.
   */
  | { kind: 'human'; userId: string }
  /**
   * An operator running a script or a test harness against their own
   * deployment. Recorded as such rather than disguised as one of the others.
   */
  | { kind: 'operator'; via: 'cli' | 'test' }

export async function runAutoFix(
  findingId: string,
  projectId: string,
  // Test/verification harness only: bypass the 2-min post-mutation cooldown so
  // multiple deterministic fixes can be exercised in one run.
  opts: { skipCooldown?: boolean; actor?: FixActor } = {},
): Promise<AutoFixResult> {
  // Default-deny on omission. A caller that does not say who it is gets the
  // strictest posture, not the most permissive one.
  const actor: FixActor = opts.actor ?? { kind: 'autonomous', loop: 'reconciler' }
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
  //
  // THE GATE. Everything above is classification; below this line something
  // mutates. An autonomous caller must hold an AUTO_EXECUTE decision, and the
  // check lives here rather than at each call site so that no entry point can
  // skip it by forgetting to call it.
  if (actor.kind === 'autonomous') {
    const { authorizeAutonomousFix, revalidateAtMutationBoundary, enforceLegacyCompatibility } =
      await import('@/lib/authority/gate')
    const { authorityPathFor } = await import('@/lib/authority/action-classes')

    const tableName =
      typeof details.tableName === 'string'
        ? details.tableName
        : typeof details.table === 'string'
          ? (details.table as string)
          : null

    // An architecture change carrying itself out on the table this repair
    // changes holds Backenly's own repairs of it until the change is in place
    // (lib/evolution-engine/holds.ts): the change stops if its table moves under
    // it, and a repair of ours must not be what moved it. Asked once the repair
    // is cleared to run, so one that needs a person is still put in front of
    // them, and again inside the build lock (_executeAutoFix). Unknown is not
    // held: a failed read costs the change a stop, never a repair its delay.
    const holds = await import('@/lib/evolution-engine/holds')
    const hold = { table: holds.repairedTable(finding.type, details), action: buildFixAction(finding.type, details)?.action ?? null }
    const held = async (): Promise<AutoFixResult | null> => {
      const why = await holds.repairHold(projectId, hold).catch(() => null)
      return why ? { findingId, outcome: 'held', message: `Held: ${why}.` } : null
    }

    const path = authorityPathFor(finding.type)

    // ── Neither declared nor enumerated ──────────────────────────────────
    //
    // Nothing is known about this type's sensors, verifier or recovery, and it
    // is not on the compatibility list either. Default deny.
    if (path === 'freeze') {
      return {
        findingId,
        outcome: 'notify_only',
        message:
          `Frozen: "${finding.type}" has no declared action class and is not a listed ` +
          'legacy type, so Backenly cannot establish whether repairing it is safe.',
      }
    }

    // ── Enumerated legacy type: today's proven behaviour, recorded as debt ──
    //
    // Deliberately NOT more permissive than before. The flag and the dial are
    // enforced here because `runAutoFix` never checked them — only
    // `runReconciler` did — so a direct caller could previously execute with
    // ENABLE_AUTONOMY_LIVE_EXECUTION=false. The breaker, verification and
    // recovery semantics below are unchanged.
    if (path === 'legacy_compatibility') {
      const compat = await enforceLegacyCompatibility(projectId, finding.type)
      if (!compat.allowed) {
        return { findingId, outcome: 'deferred', message: compat.reason ?? 'not permitted' }
      }
      const waiting = await held()
      if (waiting) return waiting
      return _executeAutoFix(finding.id, projectId, type, details, { ...opts, hold })
    }

    const gate = await authorizeAutonomousFix({
      projectId,
      findingType: finding.type,
      tableName,
      loop: actor.loop,
    })

    if (!gate.mayExecute) {
      const d = gate.decision
      // FREEZE must not surface an executable-looking proposal: the evidence
      // for NEEDING the repair is what could not be established, so offering it
      // would invite a human to approve something nobody can justify.
      if (d.decision === 'FREEZE') {
        await prisma.healthFinding
          .update({ where: { id: finding.id }, data: { status: 'open' } })
          .catch(() => {})
        return {
          findingId,
          outcome: 'notify_only',
          message: `Frozen: ${d.reasons[0] ?? 'state could not be established'}${
            d.blocker ? ` Restore: ${d.blocker}.` : ''
          }`,
        }
      }

      // PROPOSE_ONLY and DENY: the repair is meaningful, authority is not
      // sufficient. Surface it for a human rather than mutating.
      await prisma.healthFinding
        .update({ where: { id: finding.id }, data: { status: 'pending_approval' } })
        .catch(() => {})
      return {
        findingId,
        outcome: 'pending_approval',
        message: `Authority: ${d.decision}. ${d.reasons[0] ?? ''}`.trim(),
      }
    }

    // The decision was a lease. Prove it still holds now, immediately before
    // the executor runs: between deciding and here an owner may have revoked
    // the grant through a surface that never takes the execution lock.
    const still = await revalidateAtMutationBoundary(gate, projectId)
    if (!still.stillValid) {
      return {
        findingId,
        outcome: 'deferred',
        message: `Authority lapsed before execution: ${still.reason}`,
      }
    }
    const waiting = await held()
    if (waiting) return waiting

    // The repair applies what the declared intent says, not what the executor
    // would infer. See applyIntentToFixDetails.
    //
    // It also carries the class's declared recovery, so the executor performs
    // the recovery the decision was granted on rather than a different one.
    const { applyIntentToFixDetails } = await import('@/lib/authority/gate')
    return _executeAutoFix(
      finding.id,
      projectId,
      type,
      applyIntentToFixDetails(gate.decision, details),
      { ...opts, recovery: gate.decision.capability.recovery, hold },
    )
  }

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
  verification?: FixVerification
  /** Whether other guarantees were compared before and after the fix. */
  regressionCheck?: FixOutcome['regressionCheck']
  /** Nothing ran because the project's region, which keeps what it replays, could not be reached. */
  regionUnavailable?: boolean
}> {
  const finding = await prisma.healthFinding.findUnique({ where: { id: findingId } })
  if (!finding) return { success: false, message: 'Finding not found.' }

  const type = finding.type as FindingType
  const details = (finding.details ?? {}) as Record<string, unknown>
  // Normalize so dynamic types (missing_rls_users, schema_drift, …) get the
  // correct snapshot/rollback treatment via their canonical base.
  const baseType = (normalizeFindingType(finding.type, details)?.base ?? type) as FindingType

  // A held action replays exactly the target and arguments it was held with,
  // which a project kept in another region keeps there
  // (lib/operational-memory/held-action-targets.ts). They are read for the
  // replay only, and nothing runs when they cannot be read.
  let replayDetails: Record<string, unknown>
  try {
    replayDetails = await heldActionForReplay(projectId, findingId, details)
  } catch (err) {
    if (!(err instanceof HeldActionUnreadable)) throw err
    return { success: false, message: err.message, regionUnavailable: err.regionUnreachable }
  }

  const fixAction = buildFixAction(finding.type, replayDetails)
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

  // ── An unverified mutation is not permission to mutate again ──────────────
  //
  // A finding carrying `appliedUnverified` has already had its repair run
  // once; what failed was the check, not necessarily the fix. This path had no
  // precondition at all — it went from `buildFixAction` straight to executing
  // — so the sequence below was reachable in about ten seconds:
  //
  //   CREATE INDEX succeeds -> verification times out -> finding stays in the
  //   queue -> owner opens Autonomy and clicks Approve & fix -> the same
  //   mutation runs again
  //
  // For `CREATE INDEX IF NOT EXISTS` that is merely wasteful. The repair
  // vocabulary is not all idempotent and will not stay this small, and
  // "unknown" must never be usable as consent to repeat a change.
  //
  // So the rule is: after a verification error, no second mutation until a
  // FRESH observation says whether the first one worked.
  if (details.appliedUnverified) {
    const { recheckGap } = await import('@/lib/autonomy/desired-state')
    const fresh = await recheckGap(projectId, finding.type, details).catch(() => 'error' as const)

    if (fresh === 'resolved') {
      // The earlier mutation did work; only the check had failed. Close it
      // without touching the database a second time.
      //
      // Recorded as the auto-fix it actually was, not as a repair performed
      // now. The statements and pre-fix snapshot from that run are promoted
      // into `rollbackData` so Undo keeps working, and `verification` is
      // stamped 'confirmed' because a probe has now positively established the
      // postcondition. Late evidence is still evidence.
      const applied = details.appliedUnverified as Record<string, unknown>
      await prisma.healthFinding.update({
        where: { id: findingId },
        data: {
          status: 'auto_fixed',
          autoFixed: true,
          fixAppliedAt: new Date(),
          details: {
            ...details,
            rollbackData: {
              fixAction: applied.fixAction,
              statements: applied.statements,
              // Format 3 only when the changes it made were recorded; an
              // unverified apply from before that stays format 2.
              rollbackFormat: Array.isArray(applied.changeIds) ? 3 : 2,
              ...(Array.isArray(applied.changeIds) ? { changeIds: applied.changeIds } : {}),
              snapshotId: applied.snapshotId ?? null,
              fixedAt: applied.at,
              verification: 'confirmed' satisfies FixVerification,
              confirmedLate: true,
            },
          } as any,
        },
      })
      await _writeAuditLog(projectId, 'HEALTH_FIX_CONFIRMED_LATE', {
        findingId,
        findingType: finding.type,
        note: 'An earlier fix could not be verified at the time. A fresh check found the issue gone; nothing was re-applied.',
      })
      return {
        success: true,
        message:
          'This was already fixed. The earlier repair could not be confirmed at the time, ' +
          'and a fresh check now finds the issue gone, so nothing was changed again.',
        verification: 'confirmed',
      }
    }

    if (fresh !== 'unresolved') {
      // 'unknown' (no probe covers this type) or the re-probe itself failed.
      // Either way there is still no observation, and repeating a mutation on
      // no evidence is the thing this guard exists to prevent.
      return {
        success: false,
        message:
          'Backenly already applied a fix for this and could not confirm the result. ' +
          'It cannot check whether that fix worked right now, so it will not run the same ' +
          'change again. It will re-check on its next pass.',
        verification: 'verification_error',
      }
    }
    // 'unresolved' — a fresh observation says the problem is genuinely still
    // there, so re-applying is a decision made on evidence. Fall through.
  }

  // PRE-FIX capture — the state one-click undo restores (see capturePreFixState).
  const pre = await capturePreFixState(projectId, baseType, fixAction)

  // Baseline for the acceptance gate below (see the autonomous path for why).
  // A failed capture is kept rather than swallowed, so the record says
  // collateral damage was not checked instead of implying nothing broke.
  let baselineError: string | null = null
  const baseline = await captureCheckBaseline(projectId).catch((err: unknown) => {
    baselineError = err instanceof Error ? err.message : String(err)
    return null
  })

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
  installHomeSqlRecorders()
  let statements: RecordedStatement[] = []

  let changeIds: string[] = []
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      const { result: captured, changeIds: madeNow } = await withFixGroup(findingId, () => withSqlCapture(() => withBuildLock(
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
      )))
      const governed = captured.result
      // Only the attempt that actually ran contributes statements; a lock-
      // contention retry captured nothing and must not append an empty round.
      if (captured.statements.length > 0) statements = captured.statements
      if (madeNow.length > 0) changeIds = madeNow
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
  let verification: FixVerification = 'unverified'
  let regressionCheck: FixOutcome['regressionCheck'] = 'unavailable'
  {
    // Same three-outcome rule as the autonomous path. The verifier throwing is
    // not the fix failing and is not the fix working, and a human who clicked
    // Approve is extending MORE trust than the loop takes on its own, so this
    // is the last place that distinction should be collapsed.
    let verifierError: string | null = null
    const outcome = await evaluateFixOutcome(projectId, finding.type, details, baseline).catch(
      (err: unknown) => {
        verifierError = err instanceof Error ? err.message : String(err)
        return null
      },
    )

    if (verifierError !== null) {
      // `success: false` is deliberate and it is NOT a claim that the fix
      // failed - the message says so in as many words. It is the only value
      // that stops the caller rendering "verified & snapshotted", which is the
      // claim we cannot make. The finding stays in the queue and the next
      // detection pass settles it.
      return {
        success: false,
        message:
          'The fix ran, but the check that would confirm it could not complete ' +
          `(${verifierError}). It has not been recorded as verified. Backenly re-checks ` +
          'on its next pass and will close this automatically if the problem is gone.',
        verification: 'verification_error',
      }
    }

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
    regressionCheck = outcome?.regressionCheck ?? 'unavailable'
  }

  // Post-fix snapshot: version history only — never the undo target.
  const postSnapshot = SCHEMA_TOUCHING.has(baseType)
    ? await captureSchemaSnapshot(projectId, 'post_migration').catch(() => null)
    : null

  // What the record keeps of the call (lib/data-plane/residency.ts). A held
  // action's arguments are its caller's own values, a secret among them
  // (SET_ENV_VAR), which its finding keeps sealed or in the project's region,
  // the statements replaying it bind them, and its result can carry a value
  // its approver is shown once (ROTATE_KEY's new key): the record keeps the
  // arguments' shape, the statements' text and whether it succeeded, in every
  // region. The approver still reads the result in full, in the response.
  // Undo reads none of them (revertAutoFix). For a project kept in another
  // region no repair's arguments, bound values, result or error text is kept
  // here either.
  const quote = await quotesKeptHere(projectId)
  const keep = { quote, held: finding.type === 'ai_action_pending' }

  const rollbackData: Record<string, unknown> = {
    fixAction: recordedFixAction(fixAction, keep),
    fixResult: recordedFixResult(result, keep),
    // The statements the executor actually sent, captured at the driver. This
    // is the half of the audit trail that used to be missing: the change was
    // derivable by diffing two schema snapshots, but the statement itself was
    // never stored, so "show me what it ran" had no answer.
    statements: recordedStatements(statements, keep),
    // UNDO CONTRACT (rollbackFormat 3): the governed changes this fix made,
    // newest first. Undo restores exactly those (lib/changes/recovery.ts).
    // snapshotId stays as the record of the pre-fix schema; it is not the undo.
    rollbackFormat: 3,
    changeIds,
    snapshotId: pre.preSnapshotId,
    postSnapshotId: postSnapshot?.id ?? null,
    preMetadata: pre.preMetadata,
    schemaTouching: pre.schemaTouching,
    fixedAt: new Date().toISOString(),
    verification,
    // Whether other guarantees were compared before and after. 'unavailable'
    // means nobody looked, so no claim of "nothing else broke" may be made.
    regressionCheck,
    ...(baselineError ? { baselineError: quotedError(baselineError, quote) } : {}),
  }

  return {
    success: true,
    message: result.message,
    snapshotId: pre.preSnapshotId ?? undefined,
    rollbackData,
    verification,
    regressionCheck,
  }
}

// ── Person-approved AI proposals ──────────────────────────────────────────────

export interface ProposalExecution {
  /** Whether anything was sent to the database. */
  mutated: boolean
  /** All three checks agreed: postcondition confirmed, re-check resolved, regression check ran clean. */
  fixed: boolean
  outcome: 'fixed' | 'not_started' | 'stale' | 'failed' | 'unverified'
  message: string
  /** Nothing ran only because another change held the lock: the same approval can be tried again. */
  retryable?: boolean
  postcondition?: 'confirmed' | 'refuted' | 'error'
  recheck?: 'resolved' | 'unresolved' | 'unknown' | 'error'
  regressionCheck?: FixOutcome['regressionCheck']
  regressions?: string[]
  /** Present whenever something ran: what Undo needs, and the audit record. */
  rollbackData?: Record<string, unknown>
}

/**
 * "Fixed" for an AI-proposed repair: the action's postcondition is confirmed
 * in the catalog, the owning probe's re-check says resolved, and the regression
 * check ran and found nothing broken. All three, or it is not fixed. A command
 * succeeding, a model's reply, or silence never counts.
 */
export function isVerifiedRepair(checks: {
  postcondition: 'confirmed' | 'refuted' | 'error'
  recheck: 'resolved' | 'unresolved' | 'unknown' | 'error'
  regressionCheck: FixOutcome['regressionCheck']
  regressions: string[]
}): boolean {
  return (
    checks.postcondition === 'confirmed' &&
    checks.recheck === 'resolved' &&
    checks.regressionCheck === 'ran' &&
    checks.regressions.length === 0
  )
}

/**
 * Run a person-approved AI repair (lib/autonomy/ai-proposals.ts) through the
 * same governed path as an approved deterministic fix, with stricter rules,
 * because the repair came from a model rather than from the repair map:
 *
 *   - It does not start unless the starting state is established: the owning
 *     probe must positively detect the gap right now, the check baseline must
 *     be captured, and for a schema change the pre-change snapshot Undo
 *     restores must exist. Any of those missing means nothing is changed.
 *     There is no `.catch(() => null)` on this path.
 *   - The touched catalog is re-read INSIDE the build lock, right before the
 *     mutation; if it differs from what was approved, nothing runs.
 *   - It is "fixed" only when the action's catalog postcondition is
 *     confirmed AND the probe re-check says resolved AND the regression check
 *     ran and found nothing broken. Anything else is reported as exactly what
 *     it is, and a change that ran keeps its Undo record.
 */
export async function executeApprovedProposal(input: {
  projectId: string
  findingId: string
  action: string
  params: Record<string, unknown>
  schemaTouching: boolean
  expectedCatalogFingerprint: string
  currentCatalogFingerprint: () => Promise<string>
}): Promise<ProposalExecution> {
  const { projectId, findingId, action, params } = input
  const notStarted = (message: string): ProposalExecution => ({ mutated: false, fixed: false, outcome: 'not_started', message })

  const finding = await prisma.healthFinding.findFirst({ where: { id: findingId, projectId } })
  if (!finding) return notStarted('The finding no longer exists, so nothing was changed.')
  const details = (finding.details ?? {}) as Record<string, unknown>
  const baseType = (normalizeFindingType(finding.type, details)?.base ?? finding.type) as FindingType
  const fixAction = { action: action as AIAction['action'], params }

  const { recheckGap } = await import('@/lib/autonomy/desired-state')
  const before = await recheckGap(projectId, finding.type, details).catch(() => 'error' as const)
  if (before === 'resolved') return notStarted('The issue is no longer detected, so nothing was changed.')
  if (before !== 'unresolved') {
    return notStarted('Backenly cannot establish the starting state (the check for this issue could not run), so nothing was changed.')
  }

  let baseline: Awaited<ReturnType<typeof captureCheckBaseline>>
  try {
    baseline = await captureCheckBaseline(projectId)
  } catch {
    return notStarted('Backenly cannot establish the starting state (the before-check could not run), so nothing was changed.')
  }

  const pre = await capturePreFixState(projectId, baseType, fixAction, { schemaTouching: input.schemaTouching })
  if (pre.schemaTouching && !pre.preSnapshotId) {
    return notStarted('Backenly could not record the state Undo would restore, so nothing was changed.')
  }

  installHomeSqlRecorders()
  let captured
  let changeIds: string[] = []
  try {
    const grouped = await withFixGroup(findingId, () => withSqlCapture(() => withBuildLock(
      projectId,
      'modify',
      async () => {
        // The last moment before the mutation: the catalog the person approved.
        if ((await input.currentCatalogFingerprint()) !== input.expectedCatalogFingerprint) {
          return { stale: true as const }
        }
        return {
          stale: false as const,
          result: await executeAction(fixAction, projectId, undefined, 0, undefined, false),
        }
      },
      // Human-approved: skip the autonomy cooldown/budget gate.
      { skipCooldown: true },
    )))
    captured = grouped.result
    changeIds = grouped.changeIds
  } catch (err) {
    return { mutated: false, fixed: false, outcome: 'failed', message: `The change could not run: ${err instanceof Error ? err.message : String(err)}` }
  }

  const governed = captured.result
  const statements = captured.statements
  if (governed.error) {
    return { ...notStarted('Another change is still in progress on this project, so nothing was changed. Approve again in a moment.'), retryable: true }
  }
  if (!governed.result) return notStarted('The change did not start, so nothing was changed.')
  if (governed.result.stale) {
    return { mutated: false, fixed: false, outcome: 'stale', message: 'The table changed after this was proposed, so nothing was changed. It needs a fresh proposal.' }
  }

  const result = governed.result.result
  // What the record keeps of the call, as for an approved fix (lib/data-plane/residency.ts).
  const keep = { quote: await quotesKeptHere(projectId), held: finding.type === 'ai_action_pending' }
  const rollbackData: Record<string, unknown> = {
    fixAction: recordedFixAction(fixAction, keep),
    fixResult: recordedFixResult(result, keep),
    statements: recordedStatements(statements, keep),
    // UNDO CONTRACT (rollbackFormat 3), as for every other fix: the governed
    // changes it made, newest first, which Undo restores (lib/changes/recovery.ts).
    rollbackFormat: 3,
    changeIds,
    snapshotId: pre.preSnapshotId,
    preMetadata: pre.preMetadata,
    schemaTouching: pre.schemaTouching,
    fixedAt: new Date().toISOString(),
    source: 'ai_proposal',
  }
  if (!result.success) {
    return {
      mutated: statements.length > 0,
      fixed: false,
      outcome: 'failed',
      message: `The change failed: ${result.error ?? result.message}`,
      ...(statements.length > 0 ? { rollbackData } : {}),
    }
  }

  const { verifyPostcondition } = await import('@/lib/autonomy/action-postconditions')
  const postcondition = await verifyPostcondition(action, projectId, params)
  // Same three-state rule as the other two acceptance call sites: a verifier
  // that throws is neither the fix failing nor the fix working.
  let verifierError: string | null = null
  const evaluated = await evaluateFixOutcome(projectId, finding.type, details, baseline).catch((err: unknown) => {
    verifierError = err instanceof Error ? err.message : String(err)
    return null
  })
  if (verifierError !== null) {
    Object.assign(rollbackData, { verification: 'verification_error', postcondition, verifierError })
    return {
      mutated: true,
      fixed: false,
      outcome: 'unverified',
      rollbackData,
      postcondition,
      recheck: 'error',
      regressionCheck: 'unavailable',
      regressions: [],
      message:
        `The change ran, but the check that would confirm it could not complete (${verifierError}), ` +
        'so it is not recorded as fixed. Backenly re-checks on its next pass.',
    }
  }
  const recheck = evaluated?.recheck ?? 'error'
  const regressionCheck = evaluated?.regressionCheck ?? 'unavailable'
  const regressions = evaluated?.regressions ?? []
  const fixed = isVerifiedRepair({ postcondition, recheck, regressionCheck, regressions })

  const verification: FixVerification = fixed
    ? 'confirmed'
    : postcondition === 'error' || recheck === 'error'
      ? 'verification_error'
      : 'unverified'
  Object.assign(rollbackData, { verification, regressionCheck, postcondition, recheck })

  const checks = { postcondition, recheck, regressionCheck, regressions }
  if (fixed) {
    return {
      mutated: true, fixed: true, outcome: 'fixed', rollbackData, ...checks,
      message: 'Fixed and verified: the change is in the catalog, the issue is gone on re-check, and nothing else broke.',
    }
  }
  if (regressions.length > 0) {
    return {
      mutated: true, fixed: false, outcome: 'failed', rollbackData, ...checks,
      message: `The change closed the issue but broke ${regressions.length} check(s) that were passing before, so it is not recorded as fixed. Undo restores the state before it.`,
    }
  }
  if (postcondition === 'refuted' || recheck === 'unresolved') {
    return {
      mutated: true, fixed: false, outcome: 'failed', rollbackData, ...checks,
      message: 'The change ran but did not produce the intended state, so it is not recorded as fixed. The finding stays open.',
    }
  }
  return {
    mutated: true, fixed: false, outcome: 'unverified', rollbackData, ...checks,
    message: 'The change ran, but it could not be fully checked, so it is not recorded as fixed. Backenly re-checks on its next pass.',
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
 * The ways a fix is genuinely unrevertible are all knowable from the finding
 * row:
 *   • no rollbackData at all — the fix predates the undo contract entirely
 *   • rollbackFormat 1      — its snapshot was captured AFTER the fix, so a
 *     "revert" would restore the post-fix state and report success having done
 *     nothing (this is the bug format 2 exists to close)
 *   • a schema-touching fix in format 2 — its only way back is restoring the
 *     whole schema to the pre-fix snapshot, which would also undo every change
 *     anyone made since. Format 3 records the governed changes the fix made, and
 *     undoes exactly those (lib/changes/recovery.ts).
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

  if (rollbackData.rollbackFormat !== 2 && rollbackData.rollbackFormat !== 3) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason:
        'This fix was recorded before revert support existed — its snapshot captures the state ' +
        'AFTER the fix, so an automatic undo would silently do nothing.',
    }
  }

  if (rollbackData.schemaTouching === true && rollbackData.rollbackFormat === 2) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason: rollbackData.snapshotId
        ? 'This fix was made before Backenly recorded each change with its own restore point. Undoing it ' +
          'now would mean restoring the whole schema to how it was then, which would also undo every change ' +
          'made since, so it is not done automatically.'
        : 'No pre-fix snapshot was captured when this fix ran, so there is no recorded state to restore.',
    }
  }

  // Format 3 undoes exactly the changes the fix recorded. A fix that ran
  // statements but recorded no change (the ledger was off, or the lookup
  // failed) has no restore point to go back to, and "nothing to undo" would be
  // a false answer.
  if (
    rollbackData.schemaTouching === true &&
    rollbackData.rollbackFormat === 3 &&
    !(Array.isArray(rollbackData.changeIds) && rollbackData.changeIds.length > 0) &&
    Array.isArray(rollbackData.statements) && rollbackData.statements.length > 0
  ) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason: 'This fix ran statements that were not recorded as a change with a restore point, so there is no recorded state to restore.',
    }
  }

  // Nothing recorded to put back: a fix that changed no schema and kept no
  // earlier platform value (an approved held action setting a secret or a key's
  // permissions) has no undo. Offered anyway, it reported "Fix reverted." and
  // reopened the finding with the change still in place.
  if (rollbackData.schemaTouching !== true && !rollbackData.preMetadata) {
    return {
      revertible: false,
      requiresConfirmation: false,
      reason: 'Backenly kept no earlier state for what this fix changed, so it cannot be undone automatically.',
    }
  }

  const baseType = (normalizeFindingType(findingType, det)?.base ?? findingType) as string
  return { revertible: true, requiresConfirmation: RLS_PROTECTION_TYPES.has(baseType) }
}

/**
 * Revert an auto-fixed finding to its recorded pre-fix state.
 *
 * The undo contract (rollbackFormat 3):
 *   • schema-touching fixes → the governed changes the fix made, each restored
 *     to the state before it (lib/changes/recovery.ts), scoped to what it
 *     touched and verified
 *   • metadata fixes → the exact pre-fix rows/values from preMetadata
 *   • older fixes are REFUSED honestly: format 1 because its snapshot is
 *     post-fix, schema-touching format 2 because its only way back restores the
 *     whole schema and would undo every later change with it
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
        `${eligibility.reason} Undo it by hand, or ask your coding agent.`,
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

  // ── Schema-side revert: the governed changes this fix made ──────────────────
  //
  // Each one is restored on its own, newest first, scoped to what it touched,
  // with the same checks as Restore previous state: refused if a later change
  // touched the same tables, and never silently setting aside data written
  // since. A restore that would affect such data is not done from here: it
  // belongs in History, where the person sees exactly what is kept.
  let appliedSteps = 0
  let schemaMessage = ''
  if (rollbackData.schemaTouching === true) {
    const { previewRecovery, recoverChange } = await import('@/lib/changes/recovery')
    const { currentAttribution } = await import('@/lib/changes/attribution')
    const ids = Array.isArray(rollbackData.changeIds) ? (rollbackData.changeIds as string[]) : []
    let restored = 0
    // Said first when a refusal comes after an earlier change was restored, so
    // the result never reads as "nothing happened" when part of it did.
    const lead = (seqs: number[]) =>
      seqs.length === 0 ? 'Not undone: ' : `Partly undone: the state before ${seqs.map((s) => `#${s}`).join(', ')} is back, verified, but `
    const restoredSeqs: number[] = []
    for (const id of ids) {
      const preview = await previewRecovery(projectId, id)
      if (!preview) continue
      if (preview.safety === 'unavailable') {
        // Restored or recovered already, or it never took effect: nothing left
        // of it to undo. Any other reason (its restore point expired or failed
        // its integrity check, Backenly is still working on it) leaves the fix
        // in place, and the undo says so rather than reporting it reverted.
        const now = await prisma.backendChange.findUnique({ where: { id }, select: { status: true } })
        if (now && ['restored', 'recovered', 'failed'].includes(now.status)) continue
        return {
          success: false,
          message: `${lead(restoredSeqs)}${preview.reason ?? 'its restore point is not available'} Undo it manually from the Database section, or ask your coding agent.`,
        }
      }
      if (preview.safety !== 'lossless') {
        return {
          success: false,
          message:
            `${lead(restoredSeqs)}${preview.reason ?? 'it cannot be restored automatically'}. ` +
            'Open History to restore it there, where you can see exactly what would be kept.',
        }
      }
      const out = await recoverChange(projectId, id, { mode: 'manual', actorUserId: currentAttribution()?.actorUserId ?? null })
      if (!out.ok) return { success: false, message: `${lead(restoredSeqs)}${(out as { error: string }).error}` }
      restored++
      restoredSeqs.push(preview.seq)
    }
    appliedSteps = restored
    schemaMessage = restored > 0
      ? `restored the state before ${restored === 1 ? 'the change' : `the ${restored} changes`} this fix made, verified`
      : 'nothing in the schema to undo'
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
 *   approval    → only apply on a human's approval (`confirmed`, which only an
 *                 approved Review Queue call sets); otherwise return
 *                 needs_confirmation, naming the risk and where to approve it
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
    // No chat message can approve it, so put it where a person can, as the
    // autonomy loop does: the Review Queue lists pending_approval findings only.
    // Inviting a reply of "confirm" instead would reach nothing waiting and
    // change nothing.
    const queued = await prisma.healthFinding.updateMany({
      where: { id: findingId, status: 'open' },
      data: { status: 'pending_approval' },
    })
    if (queued.count > 0) {
      await _writeAuditLog(projectId, 'HEALTH_FIX_AWAITING_APPROVAL', {
        findingId,
        findingType: type,
        reason: cls.reason,
        via: 'chat',
      })
    }
    const waiting = queued.count > 0 || finding.status === 'pending_approval'
    return {
      outcome: 'needs_confirmation',
      message: waiting
        ? `${cls.reason}${risk} This fix needs a person's approval, so it is waiting in the Review Queue on the Autonomy page, which shows exactly what it changes.`
        : `${cls.reason}${risk} This fix needs a person's approval in the dashboard; a chat message cannot approve it.`,
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

  // The requester reads the result in full in the reply below; the audit row
  // keeps it as the record keeps a result (lib/data-plane/residency.ts), so a
  // held action's row says only that it ran.
  const keep = { quote: await quotesKeptHere(projectId), held: finding.type === 'ai_action_pending' }
  const action = typeof details.executorAction === 'string' ? details.executorAction : type
  await _writeAuditLog(projectId, 'HEALTH_FIX_RESOLVED_VIA_CHAT', {
    findingId,
    findingType: type,
    tableName: (details.tableName ?? details.table ?? details.location ?? null) as string | null,
    columnName: (details.columnName ?? details.column ?? null) as string | null,
    message: recordedResultMessage(result.message, action, keep),
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
export async function processOpenFindings(
  projectId: string,
  /**
   * Who is driving this batch. Defaults to autonomous, which is the strict
   * posture: a caller that has not said who it is gets the gate, not a bypass.
   */
  actor: FixActor = { kind: 'autonomous', loop: 'reconciler' },
): Promise<AutoFixResult[]> {
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
    // Inherits the caller's posture rather than assuming one.
    results.push(await runAutoFix(f.id, projectId, { actor }))
  }
  return results
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** An architecture change holds this repair (lib/evolution-engine/holds.ts); its message says why. */
class ArchitectureHold extends Error {}

async function _executeAutoFix(
  findingId: string,
  projectId: string,
  type: FindingType,
  details: Record<string, unknown>,
  /**
   * `recovery` is the declared recovery of the action class that authorized
   * this repair. Set only on the authority path; the legacy path has none.
   *
   * `hold` is set only for an autonomous repair: the table and action whose
   * architecture hold (lib/evolution-engine/holds.ts) is asked again inside
   * the build lock, so an approval that landed since the first ask holds it.
   */
  opts: { skipCooldown?: boolean; recovery?: string; hold?: { table: string | null; action: string | null } } = {},
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

  // ── The declared recovery, prepared before anything changes ─────────────
  //
  // `tighten_policy` is authorized on the promise of `restore_policies`, and
  // the decision reports that recovery as implemented. Until this block the
  // reconciler never ran it: a policy repair that failed verification was
  // escalated with the new policy left in place. A recovery the decision
  // counts on and the executor never performs is a receipt that lies.
  //
  // If the pre-state cannot be read, the recovery cannot be performed, so the
  // repair does not run. Deferred rather than escalated: nothing was tried.
  let policyPre: PolicyCapture | null = null
  let policyPost: PolicyCapture | null = null
  if (opts.recovery === 'restore_policies') {
    const table = typeof details.tableName === 'string' ? details.tableName : null
    if (!table) {
      return _deferred(findingId, projectId, type, details,
        'Declared recovery restore_policies needs the table this repair changes, and the finding names none.')
    }
    try {
      policyPre = await capturePolicies(projectId, table)
    } catch (err: any) {
      return _deferred(findingId, projectId, type, details,
        `Declared recovery restore_policies could not capture the pre-repair policies: ${err?.message ?? err}`)
    }
  }

  // Baseline of which guarantees currently HOLD, so the acceptance gate below
  // can tell "this fix broke something" from "this was already broken". Without
  // a before-state there is nothing to compare against and a regression is
  // indistinguishable from a pre-existing failure, so the gate degrades to
  // target-only verification rather than guessing, and the record says so.
  let baselineError: string | null = null
  const baseline = await captureCheckBaseline(projectId).catch((err: unknown) => {
    baselineError = err instanceof Error ? err.message : String(err)
    return null
  })

  let result
  installHomeSqlRecorders()
  let statements: RecordedStatement[] = []
  let changeIds: string[] = []
  try {
    const { result: captured, changeIds: madeNow } = await withFixGroup(findingId, () => withSqlCapture(() => withBuildLock(
      projectId,
      'modify',
      async () => {
        if (opts.hold) {
          const { repairHold } = await import('@/lib/evolution-engine/holds')
          const why = await repairHold(projectId, opts.hold).catch(() => null)
          if (why) throw new ArchitectureHold(why)
        }
        const r = await executeAction(
          { action: fixAction.action as AIAction['action'], params: fixAction.params },
          projectId,
          undefined, // apiKey
          0,         // retryCount
          undefined, // executionId
          false,     // allowReplan — deterministic autonomy fix, never LLM-replan
        )
        // Still inside the lock, so this is the state THIS execution left, not
        // one a later writer produced. restore_policies' stale guard compares
        // against it and refuses to overwrite anything that differs.
        if (policyPre) policyPost = await capturePolicies(projectId, policyPre.table).catch(() => null)
        return r
      },
      { skipCooldown: opts.skipCooldown },
    )))
    const governed = captured.result
    statements = captured.statements
    changeIds = madeNow
    if (governed.error) {
      return _isTransientGovernanceError(governed.error)
        ? _deferred(findingId, projectId, type, details, governed.error)
        : _escalate(findingId, projectId, type, details, governed.error)
    }
    result = governed.result
  } catch (err: any) {
    // Held inside the lock: nothing ran, and the finding stays open.
    if (err instanceof ArchitectureHold) return { findingId, outcome: 'held', message: `Held: ${err.message}.` }
    const msg = `Execution threw: ${err.message}`
    return _isTransientGovernanceError(err?.message)
      ? _deferred(findingId, projectId, type, details, msg)
      : _escalate(findingId, projectId, type, details, msg)
  }

  if (!result!.success) {
    const reason = result!.error ?? result!.message
    const recovered = policyPre
      ? await _recoverPolicies(findingId, projectId, type, policyPre, policyPost, reason, changeIds)
      : null
    const full = recovered ? `${reason} ${recovered}` : reason
    return _isTransientGovernanceError(reason)
      ? _deferred(findingId, projectId, type, details, full)
      : _escalate(findingId, projectId, type, details, full)
  }

  // What the finding and the audit rows keep of the call, decided once so they
  // agree (lib/data-plane/residency.ts): for a project kept in another region
  // or a held action, the action's name, its arguments' shape and the
  // statements' text, and not the result's text.
  const keep = { quote: await quotesKeptHere(projectId), held: type === 'ai_action_pending' }
  const recorded = {
    fixAction: recordedFixAction(fixAction, keep),
    statements: recordedStatements(statements, keep),
    message: recordedResultMessage(result.message, fixAction.action, keep),
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
  // ── Three outcomes, not two ───────────────────────────────────────────────
  //
  // This block used to be `.catch(() => null)` followed by three guards all
  // shaped `if (outcome && ...)`. When the verifier THREW, every one of them
  // was skipped and the fix fell through to be recorded as applied:
  //
  //     detect -> mutate -> verifier throws -> record success
  //
  // A transient database error therefore certified a repair nobody had
  // checked. That is the observation bug the probes had, moved one step later
  // and made worse: this manufactures certainty about our own work, after
  // already having changed the customer's backend.
  //
  // A timeout does not prove the fix failed. It also does not prove it worked.
  // So the error case is its own state and is never success.
  let verification: FixVerification = 'unverified'
  let regressionCheck: FixOutcome['regressionCheck'] = 'unavailable'
  {
    let verifierError: string | null = null
    const outcome = await evaluateFixOutcome(projectId, type, details, baseline).catch(
      (err: unknown) => {
        verifierError = err instanceof Error ? err.message : String(err)
        return null
      },
    )

    if (verifierError !== null) {
      // Applied, unverifiable. NOT escalated as a failed fix — the repair may
      // well have worked and calling it a failure is its own false claim — and
      // NOT rolled back, because undoing a good index because the observer
      // blinked is the same error in the other direction.
      //
      // The finding stays visible instead of disappearing as healed, and the
      // next tick re-probes it for free: `reapInvariantFindings` closes a
      // `pending_approval` finding whose gap is genuinely gone, so a fix that
      // did work resolves itself on the following pass. That is the bounded
      // verification retry, using the machinery that already exists rather
      // than re-running a mutation that has already happened.
      return _appliedUnverified(findingId, projectId, type, details, {
        fixAction: recorded.fixAction,
        statements: recorded.statements,
        preSnapshotId: pre.preSnapshotId,
        changeIds,
        message: recorded.message,
        verifierError,
      })
    }

    // Both rejections below are verdicts the verifier DID reach, so they are
    // the case the declared recovery exists for. A verifier that could not
    // reach one returned above without rolling back, and stays that way.
    const rejected =
      (outcome && !outcome.accepted && outcome.recheck !== 'unknown') ||
      // A regression is disqualifying even when closure could not be confirmed:
      // "I could not prove I helped, and something that used to hold now fails"
      // is the worst outcome to record as a fix.
      (outcome && outcome.regressions.length > 0)
    if (rejected) {
      const recovered = policyPre
        ? await _recoverPolicies(findingId, projectId, type, policyPre, policyPost, outcome.reason, changeIds)
        : null
      return _escalate(findingId, projectId, type, details,
        recovered ? `${outcome.reason} ${recovered}` : outcome.reason)
    }
    if (outcome?.recheck === 'resolved') verification = 'confirmed'
    regressionCheck = outcome?.regressionCheck ?? 'unavailable'
  }

  // Post-fix snapshot: version history / diff surface only — NEVER the undo
  // target (reverting to a post-fix snapshot is a 0-step no-op).
  const postSnapshot = SCHEMA_TOUCHING.has(baseType)
    ? await captureSchemaSnapshot(projectId, 'post_migration').catch(() => null)
    : null

  const rollbackData: Record<string, unknown> = {
    fixAction: recorded.fixAction,
    fixResult: recordedFixResult(result, keep),
    // The statements the executor actually sent, captured at the driver. This
    // is the half of the audit trail that used to be missing: the change was
    // derivable by diffing two schema snapshots, but the statement itself was
    // never stored, so "show me what it ran" had no answer.
    statements: recorded.statements,
    // UNDO CONTRACT (rollbackFormat 3): the governed changes this fix made,
    // newest first. Undo restores exactly those (lib/changes/recovery.ts).
    // snapshotId stays as the record of the pre-fix schema; it is not the undo.
    rollbackFormat: 3,
    changeIds,
    snapshotId: pre.preSnapshotId,
    postSnapshotId: postSnapshot?.id ?? null,
    preMetadata: pre.preMetadata,
    schemaTouching: pre.schemaTouching,
    fixedAt: new Date().toISOString(),
    verification,
    // Whether other guarantees were compared before and after. 'unavailable'
    // means nobody looked, so no claim of "nothing else broke" may be made.
    regressionCheck,
    ...(baselineError ? { baselineError } : {}),
  }

  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      status: 'auto_fixed',
      autoFixed: true,
      fixAppliedAt: new Date(),
      // A baseline's error only as an error code for a project kept in another
      // region (lib/data-plane/residency.ts).
      details: (await findingDetailsKeptHere(projectId, type, { ...details, rollbackData })) as any,
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
    fixAction: recorded.fixAction,
    message: recorded.message,
    snapshotId: pre.preSnapshotId,
    postSnapshotId: postSnapshot?.id ?? null,
    // The statements this fix actually ran. Duplicated onto the audit row rather
    // than left only in finding.details, because the audit log is the record
    // that survives the finding being dismissed or the project's queue being
    // cleared — and "what did it run" is a question asked long after.
    statements: recorded.statements,
    // Read by the trust scoreboard: only 'confirmed' fixes count as verified.
    verification,
    regressionCheck,
  })

  return { findingId, outcome: 'auto_fixed', message: result.message, rollbackData }
}

/**
 * The mutation happened and we could not confirm it. Say exactly that.
 *
 * Deliberately NOT `_escalate`. Escalation means "the loop tried, verified,
 * and the fix did not hold" — a claim about the repair. This is a claim about
 * the OBSERVING, and conflating them would tell a user their fix failed when
 * what actually failed was the check.
 *
 * Deliberately not `auto_fixed` either. The whole point is that nothing may
 * call this a verified repair, and a finding that leaves the queue as healed
 * is the system asserting exactly that.
 *
 * ── Why the mutation is recorded even though the fix "did not complete" ───
 *
 * Because it DID run. `statements` and the pre-fix snapshot are written the
 * same way a confirmed fix writes them, so Undo still works and "show me what
 * it ran" still has an answer. Losing that because the verifier broke would
 * turn an unverified change into an untraceable one.
 */
async function _appliedUnverified(
  findingId: string,
  projectId: string,
  type: FindingType,
  details: Record<string, unknown>,
  applied: {
    /** The call and its statements as the record keeps them (lib/data-plane/residency.ts). */
    fixAction: unknown
    statements: unknown
    preSnapshotId: string | null
    changeIds: string[]
    message: string
    verifierError: string
  },
): Promise<AutoFixResult> {
  const reason =
    `The fix ran, but the check that would confirm it could not complete: ${applied.verifierError}. ` +
    'It has not been recorded as verified. Backenly will re-check on its next pass and close this ' +
    'automatically if the problem is genuinely gone.'

  await prisma.healthFinding.update({
    where: { id: findingId },
    data: {
      // Stays in the queue. `reapInvariantFindings` closes a pending_approval
      // finding whose gap is actually gone, so a fix that worked resolves
      // itself next tick and one that did not stays visible.
      status: 'pending_approval',
      // The check's error, and the reason that quotes it, only as an error
      // code for a project kept in another region (lib/data-plane/residency.ts).
      details: (await findingDetailsKeptHere(projectId, type, {
        ...details,
        // The mutation is on the record even though the verdict is not, so a
        // later reader can tell "we changed this and do not know the result"
        // from "we never got that far".
        appliedUnverified: {
          at: new Date().toISOString(),
          fixAction: applied.fixAction,
          statements: applied.statements,
          snapshotId: applied.preSnapshotId,
          changeIds: applied.changeIds,
          verifierError: applied.verifierError,
        },
        escalation: {
          ...((details.escalation ?? {}) as Record<string, unknown>),
          reason,
          at: new Date().toISOString(),
        },
      })) as any,
    },
  })

  // Its own action, not HEALTH_FIX_ESCALATED. The activity feed, the trust
  // scoreboard and the welcome-back banner all read these strings, and a
  // verification outage read as a failed repair would be a second false claim
  // laid on top of the first.
  await _writeAuditLog(projectId, 'HEALTH_FIX_UNVERIFIED', {
    findingId,
    findingType: type,
    tableName: (details.tableName ?? details.table ?? details.location ?? null) as string | null,
    columnName: (details.columnName ?? details.column ?? null) as string | null,
    fixAction: applied.fixAction,
    message: applied.message,
    snapshotId: applied.preSnapshotId,
    statements: applied.statements,
    verifierError: applied.verifierError,
    // Never 'confirmed'. The scoreboard counts only that string, so this row
    // cannot inflate the verified rate however it is later aggregated.
    verification: 'verification_error' satisfies FixVerification,
  })

  return { findingId, outcome: 'applied_unverified', message: reason }
}

/**
 * Run the declared `restore_policies` recovery after a rejected policy repair.
 *
 * Returns the sentence the escalation carries, so the finding says what state
 * the table was left in rather than only why the repair was rejected. Every
 * outcome is written to the ledger as `AUTHORITY_RECOVERY`, including the ones
 * where nothing had to be restored, because "was it put back" is the first
 * question anyone asks about a rejected authorization change.
 */
async function _recoverPolicies(
  findingId: string,
  projectId: string,
  type: FindingType,
  pre: PolicyCapture,
  post: PolicyCapture | null,
  rejectedBecause: string,
  changeIds: string[] = [],
): Promise<string> {
  let status: string
  let message: string
  if (changeIds.length > 0) {
    // The repair's governed changes are restored through the ledger, so the
    // history shows the repair undone (lib/changes/recovery.ts). The direct
    // policy restore below is for a repair that recorded no change.
    const { recoverRejectedRepair } = await import('@/lib/changes/recovery')
    ;({ status, message } = await recoverRejectedRepair(projectId, changeIds).catch((err: any) => ({
      status: 'failed' as const,
      message: `Restore threw: ${err?.message ?? err}`,
    })))
  } else if (!post) {
    // Without the state this execution left, the stale guard has nothing to
    // compare against, and restoring anyway could overwrite a later change.
    status = 'blocked_stale'
    message = 'The policies this repair left behind could not be read, so they were not overwritten.'
  } else if (samePolicies(pre, post)) {
    status = 'not_needed'
    message = 'The repair changed no policy, so there was nothing to restore.'
  } else {
    const r = await recoveryRestorePolicies(projectId, pre, post).catch((err: any) => ({
      status: 'failed' as const,
      message: `Restore threw: ${err?.message ?? err}`,
    }))
    status = r.status
    message = r.message
  }

  await _writeAuditLog(projectId, 'AUTHORITY_RECOVERY', {
    findingId,
    findingType: type,
    tableName: pre.table,
    strategy: 'restore_policies',
    status,
    message,
    rejectedBecause,
  })
  return `Recovery (restore_policies): ${status}. ${message}`
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
      // The reason is the executor's or PostgreSQL's own words, kept only as an
      // error code for a project kept in another region (lib/data-plane/residency.ts).
      details: (await findingDetailsKeptHere(projectId, type, {
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
      })) as any,
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

/** Audit payload fields that carry an executor's or PostgreSQL's own words, which can quote rows. */
const AUDIT_ERROR_TEXTS = new Set(['message', 'error', 'escalationReason', 'verifierError', 'deferReason', 'rejectedBecause'])

async function _writeAuditLog(
  projectId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  // Those words only as an error code for a project kept in another region
  // (lib/data-plane/residency.ts).
  const quote = await quotesKeptHere(projectId)
  const kept = quote
    ? payload
    : Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [
          key,
          AUDIT_ERROR_TEXTS.has(key) && typeof value === 'string' ? quotedError(value, false) : value,
        ]),
      )
  await prisma.auditLog.create({
    data: {
      projectId,
      action,
      type: 'health',
      details: JSON.stringify(kept),
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
