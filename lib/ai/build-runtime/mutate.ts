/**
 * MUTATION RUNTIME — Single Governance Kernel
 * =============================================
 * Every mutation in Backenly MUST go through runMutation().
 * No exceptions. No direct schema writes outside this kernel.
 *
 * Enforced chain for every call:
 *   budget → lock → snapshot? → execute → audit → trace → UI sync → release
 *
 * If the lock is unavailable:  returns { ok: false, locked: true }
 * If budget is exceeded:        returns { ok: false, budgetExceeded: true }
 * If execution throws:          returns { ok: false, error }   (lock always released)
 *
 * Callers NEVER need to acquire or release the lock themselves.
 */

import { withBuildLock, MutationKind } from './build-lock'
import { emitTrace } from '@/lib/ai/execution-tracer'
import { emit } from '@/lib/events/bus'
import { prisma } from '@/lib/db/prisma'
import { enforceDbStorage } from '@/lib/quota/kernel'
import { snapshotProjectDbStorage } from '@/lib/usage/db-storage'

// ── Types ─────────────────────────────────────────────────────────────────────

export type { MutationKind }

export interface MutationOptions {
  projectId:    string
  kind:         MutationKind  // 'build' | 'modify' | 'storage' | 'resume'
  action:       string        // e.g. 'delete_bucket', 'coevolution_apply', 'infra_fix'
  userId?:      string        // for audit trail
  snapshotBefore?: boolean    // take schema snapshot before executing (enables rollback)
  emitRefresh?:    boolean    // emit schema.changed for UI sync (default: true)
  auditAction?:    string     // override AuditLog action string (defaults to KIND_ACTION)
}

export interface MutationResult<T = unknown> {
  ok:               boolean
  data?:            T
  error?:           string
  locked?:          boolean   // true = another operation is running
  budgetExceeded?:  boolean   // true = hourly limit or cooldown hit
  quotaExceeded?:   boolean   // true = Plan storage limit reached
}

// ── Core kernel ───────────────────────────────────────────────────────────────

/**
 * Execute any mutation under full governance.
 *
 * Usage:
 *   const r = await runMutation(
 *     { projectId, kind: 'storage', action: 'delete_bucket', userId },
 *     () => storageService.deleteBucket(bucketId, projectId),
 *   )
 *   if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.locked ? 409 : 500 })
 */
export async function runMutation<T>(
  opts: MutationOptions,
  fn:   () => Promise<T>,
): Promise<MutationResult<T>> {
  const { projectId, kind, action, snapshotBefore = false, emitRefresh = true } = opts

  // ── 0. Plan storage gate ──────────────────────────────────────────────────
  // Structural / data-growing mutations are gated on the project's PostgreSQL
  // storage cap (measured value; soft — kernel warns at 80%, blocks at 100%).
  // Cheaper to check before taking the build lock. Fail-open inside kernel.
  if (kind === 'build' || kind === 'modify') {
    const storageGate = await enforceDbStorage(projectId)
    if (!storageGate.allowed) {
      emitTrace(projectId, { type: 'budget_exceeded', details: { action, kind, reason: 'db_storage' } }).catch(() => {})
      return { ok: false, quotaExceeded: true, error: storageGate.message }
    }
  }

  const lockResult = await withBuildLock(projectId, kind, async (_handle) => {

    // ── 1. Pre-mutation snapshot ────────────────────────────────────────────
    let snapshotId: string | undefined
    if (snapshotBefore) {
      try {
        const { takeSnapshot } = await import('@/lib/ai/approval-manager')
        const snap = await takeSnapshot(projectId, `pre_${action}_${Date.now()}`)
        snapshotId = (snap as any)?.id
      } catch {
        // Non-fatal — snapshot failure never blocks the mutation
      }
    }

    // ── 2. Execute ─────────────────────────────────────────────────────────
    const data = await fn()

    // ── 3. Audit log (fire-and-forget) ─────────────────────────────────────
    prisma.auditLog.create({
      data: {
        projectId,
        action:    opts.auditAction ?? `${kind.toUpperCase()}_${action.toUpperCase()}`,
        type:      'mutation',
        details:   JSON.stringify({ action, kind, userId: opts.userId ?? 'system', snapshotId: snapshotId ?? null }),
        timestamp: new Date(),
      },
    }).catch(() => {})

    // ── 4. Observability trace ─────────────────────────────────────────────
    emitTrace(projectId, {
      type:    'auto_fix_applied',
      details: { action, kind, snapshotId: snapshotId ?? null },
    }).catch(() => {})

    // ── 5. UI sync ─────────────────────────────────────────────────────────
    if (emitRefresh) {
      emit('schema.changed', projectId, { source: kind, action })
    }

    // ── 6. Refresh measured PostgreSQL usage ───────────────────────────────
    // Keeps ProjectUsage.dbStorageUsedMb current so the storage gate above
    // and the billing UI reflect reality. Fire-and-forget — never blocks.
    if (kind === 'build' || kind === 'modify') {
      snapshotProjectDbStorage(projectId).catch(() => {})

      // ── 6b. Direct-access grants sync ────────────────────────────────────
      // If the project has external DB credentials (bkn_ro_/bkn_rw_ roles),
      // re-apply grants + RLS pass-through so tables this mutation just
      // created are immediately visible over psql/BI connections. No-op (one
      // indexed query) when the project never provisioned direct access.
      import('@/lib/services/direct-access')
        .then(m => m.syncDirectAccessGrants(projectId))
        .catch(() => {})
    }

    return data
  })

  // ── Interpret lock result ─────────────────────────────────────────────────
  if (lockResult.error) {
    const msg = lockResult.error

    if (msg.includes('already running') || msg.includes('in progress')) {
      emitTrace(projectId, { type: 'lock_contention', details: { action, kind } }).catch(() => {})
      return { ok: false, locked: true, error: msg }
    }

    if (msg.includes('budget') || msg.includes('Cooldown') || msg.includes('cooldown')) {
      emitTrace(projectId, { type: 'budget_exceeded', details: { action, kind } }).catch(() => {})
      return { ok: false, budgetExceeded: true, error: msg }
    }

    return { ok: false, error: msg }
  }

  return { ok: true, data: lockResult.result }
}

// ── Convenience: convert MutationResult to HTTP status ───────────────────────

export function mutationHttpStatus(r: MutationResult): number {
  if (r.ok)              return 200
  if (r.locked)          return 409   // Conflict
  if (r.budgetExceeded)  return 429   // Too Many Requests
  if (r.quotaExceeded)   return 429   // Too Many Requests — plan limit
  return 500
}
