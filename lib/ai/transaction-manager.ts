/**
 * AGENT TRANSACTION MANAGER
 * ==========================
 * Wraps multi-step executor operations with rollback capability.
 *
 * Problem it solves:
 *   Stripe key stored ✓ → DB table created ✓ → integration marked active ✗
 *   → Without rollback: partial corrupt state
 *   → With rollback: all changes undone, clean slate
 *
 * Flow:
 *   1. Track every side-effect as it happens
 *   2. If any step throws → execute recorded rollback steps in reverse
 *   3. Return clean failure with rollback confirmation
 */

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'

export interface SideEffect {
  type:
    | 'table_created'
    | 'integration_activated'
    | 'key_stored'
  payload: Record<string, any>
}

export interface TransactionContext {
  projectId: string
  effects: SideEffect[]
  /** Register a side-effect so it can be rolled back if needed */
  record(effect: SideEffect): void
}

export interface TransactionResult<T> {
  success: boolean
  data?: T
  message?: string
  rolledBack?: boolean
  rollbackErrors?: string[]
}

/**
 * Run an operation inside a transaction context.
 * If it throws, every recorded side-effect is reversed in LIFO order.
 */
export async function withAgentTransaction<T>(
  projectId: string,
  operation: (ctx: TransactionContext) => Promise<T>
): Promise<TransactionResult<T>> {
  const effects: SideEffect[] = []

  const ctx: TransactionContext = {
    projectId,
    effects,
    record(effect: SideEffect) {
      effects.push(effect)
    },
  }

  try {
    const data = await operation(ctx)
    return { success: true, data }
  } catch (err: any) {
    // Operation failed — roll back in reverse order
    const rollbackErrors: string[] = []

    for (const effect of [...effects].reverse()) {
      try {
        await rollbackEffect(projectId, effect)
      } catch (rbErr: any) {
        rollbackErrors.push(`Rollback ${effect.type}: ${rbErr.message}`)
      }
    }

    return {
      success: false,
      message: err.message || 'Execution failed',
      rolledBack: true,
      rollbackErrors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    }
  }
}

/** Undo a single side-effect. */
async function rollbackEffect(projectId: string, effect: SideEffect): Promise<void> {
  switch (effect.type) {
    case 'table_created': {
      const { tableName } = effect.payload
      // DROP the table that was created
      const { getWorkspacePostgresClient } = await import('@/lib/services/workspaceDatabase')
      const db = await getWorkspacePostgresClient(projectId)
      if (db) {
        await db.executeRaw(`DROP TABLE IF EXISTS {schema}."${tableName}" CASCADE`)
      }
      break
    }

    case 'integration_activated': {
      const { integrationId } = effect.payload
      // Remove the integration from activeIntegrations
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { activeIntegrations: true },
      })
      const existing = (project?.activeIntegrations as Record<string, any>) ?? {}
      const { [integrationId]: _removed, ...rest } = existing
      await prisma.project.update({
        where: { id: projectId },
        data: { activeIntegrations: rest },
      })
      break
    }

    case 'key_stored': {
      const { integrationId } = effect.payload
      // Delete the stored key
      await prisma.projectIntegrationKey.deleteMany({
        where: { projectId, integrationId },
      })
      break
    }
  }
}
