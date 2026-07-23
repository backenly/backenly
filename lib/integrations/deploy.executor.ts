/**
 * DEPLOY INTEGRATION EXECUTOR
 *
 * Funnels the integration-style "deploy" call (from autonomous-agent,
 * build-runtime, and capability orchestration) through the canonical
 * goLive engine. Preserves the (preview → confirm) two-call contract the
 * callers expect: a non-confirmed call returns `needsConfirmation:true`
 * with a preview message; the second call with `confirmed:true` executes.
 */

import { goLive } from '@/lib/deployment/go-live'
import { prisma } from '@/lib/db/prisma'

export interface DeployIntegrationResult {
  success: boolean
  message: string
  url?: string
  deploymentId?: string
  needsConfirmation?: boolean
  confirmationId?: string
}

export async function executeDeployIntegration(
  projectId: string,
  confirmed = false,
  _confirmationId?: string,
): Promise<DeployIntegrationResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project?.userId) return { success: false, message: 'Project not found' }

  const result = await goLive(projectId, project.userId, {
    confirmedBy: 'CHAT',
    force: confirmed,
  })

  if (result.kind === 'error') {
    return { success: false, message: result.error }
  }

  if (result.kind === 'confirmation') {
    return {
      success: false,
      needsConfirmation: true,
      confirmationId: `cf_${Date.now()}`,
      message: result.message,
    }
  }

  return {
    success: true,
    message: `Done: backend is live at ${result.publicUrl} (v${result.version}).`,
    url: result.publicUrl,
  }
}
