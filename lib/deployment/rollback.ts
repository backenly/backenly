/**
 * ROLLBACK ENGINE — single source of truth for "revert to v_n".
 *
 * Used by:
 *   - app/api/projects/[id]/rollback/route.ts (UI button)
 *   - lib/ai/minimal-executor.ts ROLLBACK_DEPLOY (brain tool)
 *
 * Same confirmation-gate pattern as goLive — `force:false` on the first chat
 * call returns a "Type ROLLBACK to confirm" prompt; UI passes `force:true`
 * because the rollback button click is already the user's confirmation.
 */

import { prisma } from '@/lib/db/prisma'
import { emit } from '@/lib/events/bus'
import { emitTrace } from '@/lib/ai/execution-tracer'
import { getUserEntitlements } from '@/lib/billing'
import { recordRollbackMemory } from '@/lib/operational-memory/ledger'

const QUOTA_DISABLED = process.env.DISABLE_QUOTA_ENFORCEMENT === 'true'

export interface RollbackOptions {
  projectId: string
  userId: string
  /** Either a deployment id OR a version number — caller can pick. */
  deploymentId?: string
  version?: number
  confirmedBy: 'CHAT' | 'UI' | 'API'
  /** Skip the second-layer "Type ROLLBACK to confirm" prompt. */
  force?: boolean
}

export interface RollbackResult {
  kind: 'rolled_back'
  success: true
  message: string
  fromVersion: number
  toVersion: number
}

export interface RollbackConfirmation {
  kind: 'confirmation'
  success: true
  requiresConfirmation: true
  message: string
  fromVersion: number
  toVersion: number
}

export interface RollbackError {
  kind: 'error'
  success: false
  error: string
  code?: 'PLAN_LIMIT_EXCEEDED' | 'NOT_FOUND' | 'INVALID' | 'INTERNAL'
}

export async function rollbackDeploy(
  options: RollbackOptions,
): Promise<RollbackResult | RollbackConfirmation | RollbackError> {
  const { projectId, userId, deploymentId, version, confirmedBy, force = false } = options

  if (!deploymentId && version == null) {
    return { kind: 'error', success: false, error: 'Provide deploymentId or version to rollback to', code: 'INVALID' }
  }

  // Ownership gate — the caller must own the project. Without this, any
  // authenticated platform user could roll back any project by id.
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { activeGraphId: true },
  })
  if (!project) {
    return { kind: 'error', success: false, error: 'Project not found', code: 'NOT_FOUND' }
  }

  // Plan gate
  if (!QUOTA_DISABLED) {
    const entitlements = await getUserEntitlements(userId)
    if (!entitlements?.allowDeploymentRollback) {
      return {
        kind: 'error',
        success: false,
        error: 'Deployment rollback is available on the Pro plan and higher.',
        code: 'PLAN_LIMIT_EXCEEDED',
      }
    }
  }

  // Locate the target deployment
  const target = deploymentId
    ? await prisma.deployment.findFirst({
        where: { id: deploymentId, projectId, environment: 'live', status: 'live' },
        select: { id: true, version: true, graphSnapshotId: true, changeSummary: true },
      })
    : await prisma.deployment.findFirst({
        where: { projectId, environment: 'live', status: 'live', version: version! },
        select: { id: true, version: true, graphSnapshotId: true, changeSummary: true },
      })

  if (!target) {
    return { kind: 'error', success: false, error: 'Deployment version not found', code: 'NOT_FOUND' }
  }
  if (!target.graphSnapshotId) {
    return { kind: 'error', success: false, error: 'This deployment has no graph snapshot to rollback to', code: 'INVALID' }
  }

  // Verify snapshot still exists
  const targetGraph = await prisma.backendGraph.findFirst({
    where: { id: target.graphSnapshotId, projectId },
    select: { id: true },
  })
  if (!targetGraph) {
    return { kind: 'error', success: false, error: 'The graph snapshot for this version no longer exists', code: 'NOT_FOUND' }
  }

  // Find current live version for the prompt
  const currentDeployment = await prisma.deployment.findFirst({
    where: { projectId, environment: 'live', status: 'live', graphSnapshotId: project.activeGraphId, version: { not: null } },
    select: { version: true },
    orderBy: { version: 'desc' },
  })
  const fromVersion = currentDeployment?.version ?? 0
  const toVersion = target.version ?? 0

  if (project.activeGraphId === target.graphSnapshotId) {
    return {
      kind: 'error',
      success: false,
      error: `v${toVersion} is already the live version — nothing to roll back to.`,
      code: 'INVALID',
    }
  }

  // Confirmation gate (chat path)
  if (!force) {
    return {
      kind: 'confirmation',
      success: true,
      requiresConfirmation: true,
      fromVersion,
      toVersion,
      message:
        `You're about to roll back:\n\n` +
        `• From: v${fromVersion} (current)\n` +
        `• To:   v${toVersion} — ${target.changeSummary || 'Published'}\n\n` +
        `Live consumers will start seeing the older schema and API shape immediately.\n\n` +
        `Type ROLLBACK to confirm.`,
    }
  }

  // Atomic swap
  let previousGraphId: string | null = null
  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.project.findUnique({
        where: { id: projectId },
        select: { activeGraphId: true },
      })
      if (!fresh) throw new Error('Project not found')
      previousGraphId = fresh.activeGraphId

      await tx.project.update({
        where: { id: projectId },
        data: { activeGraphId: target.graphSnapshotId, deployedAt: new Date() },
      })

      await tx.deployment.update({
        where: { id: target.id },
        data: { rolledBackTo: fresh.activeGraphId },
      })

      await tx.auditLog.create({
        data: {
          id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          projectId,
          userId,
          action: 'DEPLOYMENT_ROLLBACK',
          type: 'deployment',
          details: JSON.stringify({
            rolledBackToVersion: toVersion,
            rolledBackToDeploymentId: target.id,
            previousGraphId: fresh.activeGraphId,
            newGraphId: target.graphSnapshotId,
            triggerSource: confirmedBy,
            timestamp: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      })
    })
  } catch (err: any) {
    return { kind: 'error', success: false, error: err.message || 'Rollback transaction failed', code: 'INTERNAL' }
  }

  // Notify UI listeners + emit trace
  emit('deploy.complete', projectId, { type: 'rollback', version: toVersion, deploymentId: target.id })
  emitTrace(projectId, {
    type: 'rollback_executed',
    details: { version: toVersion, deploymentId: target.id, graphSnapshotId: target.graphSnapshotId },
  }).catch(() => {})

  await recordRollbackMemory({
    projectId,
    actorId: userId,
    summary: `Rolled back deployment from v${fromVersion} to v${toVersion}.`,
    reason: `Rollback requested from ${confirmedBy}.`,
    beforeState: {
      version: fromVersion,
      graphSnapshotId: previousGraphId,
    },
    afterState: {
      version: toVersion,
      graphSnapshotId: target.graphSnapshotId,
      deploymentId: target.id,
    },
    rollbackId: target.id,
  }).catch((error) => {
    console.error('[Operational Memory] Failed to record rollback receipt:', error)
  })

  return {
    kind: 'rolled_back',
    success: true,
    message: `Rolled back to v${toVersion}.`,
    fromVersion,
    toVersion,
  }
}
