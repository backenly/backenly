/**
 * Truthful build-status labels.
 *
 * Rules:
 *   pending   — run hasn't begun
 *   running   — execution in flight
 *   partial   — schema/auth/storage built, workflows not yet verified
 *   blocked   — core built; at least one integration is missing credentials
 *   verified  — behavioural-verifier passed (CRUD, auth, RLS, triggers, webhooks).
 *               "Production Ready" only shown by getProductionReadyBadge() when all
 *               conditions pass — never inferred from status alone.
 *   failed    — at least one node failed
 */
import type { BuildJobStatus } from './types'

export const BUILD_STATUS_LABEL: Record<BuildJobStatus, string> = {
  pending: 'Starting…',
  running: 'In Progress',
  partial: 'Structure ready',
  blocked: 'Credentials needed',
  verified: 'Build Complete',
  failed: 'Failed build step',
}

export const BUILD_STATUS_LABEL_FALLBACK = 'Starting…'

export function buildStatusLabel(status: BuildJobStatus | string | undefined): string {
  if (!status) return BUILD_STATUS_LABEL_FALLBACK
  return BUILD_STATUS_LABEL[status as BuildJobStatus] ?? BUILD_STATUS_LABEL_FALLBACK
}

/**
 * Derive the precise badge label from full project context.
 * This is the only function that may return "Production ready".
 *
 * Conditions for "Production ready":
 *   - Job status is 'verified'
 *   - No blocked nodes (credentials all present)
 *   - No failed nodes
 *   - At least one table and one API endpoint exist
 *   - Auth is enabled
 *   - No pending approvals
 */
export function getProjectBadgeLabel(opts: {
  jobStatus: string | null | undefined
  blockedCount: number
  failedCount: number
  tablesCount: number
  apisCount: number
  authEnabled: boolean
  hasPendingApprovals?: boolean
}): string {
  const { jobStatus, blockedCount, failedCount, tablesCount, apisCount, authEnabled, hasPendingApprovals } = opts

  if (!jobStatus || jobStatus === 'pending') return 'Starting…'
  if (jobStatus === 'running') return 'In Progress'

  if (failedCount > 0) return 'Failed build step'
  if (hasPendingApprovals) return 'Awaiting approval'
  if (blockedCount > 0) return 'Credentials needed'

  if (jobStatus === 'verified' && blockedCount === 0 && failedCount === 0 && tablesCount > 0 && apisCount > 0 && authEnabled) {
    return 'Production ready'
  }

  if (jobStatus === 'verified') return 'Build Complete'
  if (jobStatus === 'partial') return 'Structure ready'
  if (jobStatus === 'blocked') return 'Credentials needed'
  if (jobStatus === 'failed') return 'Needs launch fixes'

  return 'Scan recommended'
}
