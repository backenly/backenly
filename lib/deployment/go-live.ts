/**
 * Go-Live: Shared deployment function
 *
 * Transitions a project from PRIVATE -> DEPLOYING -> LIVE.
 * If already LIVE, creates a new versioned deployment snapshot.
 *
 * Used by:
 *  - app/api/projects/[id]/go-live/route.ts  (button click)
 *  - app/api/projects/[id]/execute/route.ts  (AI chat: "deploy my backend")
 *  - lib/ai/minimal-executor.ts              (TRIGGER_DEPLOY action)
 *
 * Phase 5: All deploys now run through the readiness gate first.
 */

import { prisma } from '@/lib/db/prisma'
import { scoreReadiness, formatReadinessReport } from '@/lib/deployment/readiness-scorer'
import type { ReadinessReport } from '@/lib/deployment/readiness-scorer'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

export interface GoLiveResult {
  kind: 'deployed'
  success: true
  publicUrl: string
  alreadyLive: boolean
  version: number
  /** True when nothing changed since the last publish — no new version was created. */
  noChanges?: boolean
}

export interface GoLiveConfirmation {
  kind: 'confirmation'
  success: true
  requiresConfirmation: true
  message: string
  /** Version that will be created on confirm. */
  willBeVersion: number
  /** Readiness score for visibility. */
  readinessScore: number
}

export interface GoLiveError {
  kind: 'error'
  success: false
  error: string
  /** Present when deployment was blocked by the readiness gate */
  readinessReport?: ReadinessReport
}

export interface GoLiveOptions {
  /**
   * `confirmedBy` only — without `force:true` the engine will return a
   * confirmation prompt (`requiresConfirmation: true`) after running the
   * readiness gate. The UI button is the one path that should pass
   * `force:true` on first call (the click itself is the confirmation).
   */
  confirmedBy?: 'UI' | 'CHAT' | 'API'
  /** Skip the second-layer "Type DEPLOY" prompt. */
  force?: boolean
}

export async function goLive(
  projectId: string,
  userId: string,
  options: GoLiveOptions = {},
): Promise<GoLiveResult | GoLiveError | GoLiveConfirmation> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      slug: true,
      projectStatus: true,
      publicUrl: true,
      userId: true,
      activeGraphId: true,
    },
  })

  if (!project) {
    return { kind: 'error', success: false, error: 'Project not found' }
  }

  if (!project.activeGraphId) {
    return { kind: 'error', success: false, error: 'Cannot deploy: project has no backend state configured' }
  }

  // ─── Empty-Backend Guard ───────────────────────────────────────────────────
  // Refuse to deploy if no workspace tables have been created yet.
  // This prevents the "Backend is live" card from appearing when the AI
  // accidentally triggers deploy (e.g. a build prompt containing "deploy-ready").
  const tableCount = await prisma.table.count({ where: { projectId } })
  if (tableCount === 0) {
    return {
      kind: 'error',
      success: false,
      error: 'Cannot deploy: no backend has been built yet. Ask me to create tables, APIs, or auth first, then deploy when your backend is ready.',
    }
  }

  // ─── Phase 5: Readiness Gate ───────────────────────────────────────────────
  // Run all readiness checks. Safe auto-fixes are applied first (JWT generation,
  // RLS policies), then blocking issues are evaluated.
  const readinessReport = await scoreReadiness(projectId, { autoFix: true })

  if (!readinessReport.ready) {
    const summary = formatReadinessReport(readinessReport)
    return {
      kind: 'error',
      success: false,
      error: `Deployment blocked — readiness score ${readinessReport.score}/100. ${readinessReport.blockers.length} blocking issue${readinessReport.blockers.length > 1 ? 's' : ''} must be resolved.\n\n${summary}`,
      readinessReport,
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ─── Confirmation Gate ─────────────────────────────────────────────────────
  // The brain calls goLive() with force:false → returns a "Type DEPLOY"
  // prompt the chat must surface. The UI button calls with force:true (the
  // click itself counts as the confirmation). This mirrors the
  // connectFrontend pattern — second-layer safety on a production-affecting
  // action.
  if (!options.force) {
    const latestVersion = await prisma.deployment.findFirst({
      where: { projectId, environment: 'live', status: 'live', version: { not: null } },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    const willBeVersion = (latestVersion?.version ?? 0) + 1
    const wasAlreadyLive = project.projectStatus === 'LIVE'

    return {
      kind: 'confirmation',
      success: true,
      requiresConfirmation: true,
      willBeVersion,
      readinessScore: readinessReport.score,
      message:
        `You're about to ${wasAlreadyLive ? `publish v${willBeVersion}` : 'go live'}:\n\n` +
        `• ${tableCount} table${tableCount === 1 ? '' : 's'}\n` +
        `• Readiness: ${readinessReport.score}/100\n` +
        (wasAlreadyLive
          ? `• Replaces the currently-live deployment\n\n`
          : `• First deploy — your backend will become publicly callable\n\n`) +
        `Type DEPLOY to confirm.`,
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Determine public URL
  const projectSlug = project.slug || `project-${projectId.slice(0, 8)}`
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null) ||
    'http://localhost:3000'
  const publicUrl = project.publicUrl || `${appUrl}/api/v1/${projectId}`

  // If already LIVE, create a new versioned deployment (publish update)
  if (project.projectStatus === 'LIVE') {
    return await publishUpdate(projectId, userId, publicUrl, project.activeGraphId)
  }

  // First-time publish: PRIVATE → DEPLOYING → LIVE
  await prisma.project.update({
    where: { id: projectId },
    data: { projectStatus: 'DEPLOYING' },
  })

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Validate project has a backend graph
      const projectWithGraph = await tx.project.findUnique({
        where: { id: projectId },
        include: { activeGraph: true },
      })

      if (!projectWithGraph?.activeGraph) {
        throw new Error('Cannot deploy: project has no backend state configured')
      }

      // Build change summary from the graph
      const graphData = projectWithGraph.activeGraph.graphData as any
      const entityCount = Object.keys(graphData?.entities || {}).length
      const apiCount = Object.keys(graphData?.apis || {}).length
      const summaryParts: string[] = []
      if (entityCount > 0) summaryParts.push(`${entityCount} table${entityCount > 1 ? 's' : ''}`)
      if (apiCount > 0) summaryParts.push(`${apiCount} endpoint${apiCount > 1 ? 's' : ''}`)
      const changeSummary = summaryParts.length > 0
        ? `Initial publish with ${summaryParts.join(', ')}`
        : 'Initial publish'

      // Set project LIVE
      await tx.project.update({
        where: { id: projectId },
        data: {
          projectStatus: 'LIVE',
          isDeployed: true,
          deployedAt: new Date(),
          publicUrl,
          slug: projectSlug,
          deploymentError: null,
          publicEnabled: true,
        },
      })

      // Create deployment record (version 1)
      await tx.deployment.create({
        data: {
          id: `deploy_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          projectId,
          provider: 'backenly-managed',
          environment: 'live',
          status: 'live',
          url: publicUrl,
          completedAt: new Date(),
          version: 1,
          graphSnapshotId: project.activeGraphId,
          changeSummary,
        },
      })

      // Create audit log
      await tx.auditLog.create({
        data: {
          id: `audit_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          projectId,
          userId,
          action: 'GO_LIVE',
          type: 'deployment',
          details: JSON.stringify({
            publicUrl,
            projectSlug,
            version: 1,
            timestamp: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      })

      return { publicUrl }
    })

    return { kind: 'deployed', success: true, publicUrl: result.publicUrl, alreadyLive: false, version: 1 }
  } catch (err: any) {
    // Roll back status to FAILED
    await prisma.project.update({
      where: { id: projectId },
      data: {
        projectStatus: 'FAILED',
        deploymentError: sanitizeDiagnostic(err) || 'Deployment failed',
      },
    })
    return { kind: 'error', success: false, error: sanitizeDiagnostic(err) || 'Deployment failed' }
  }
}

/**
 * Publish an update for an already-live project.
 * Creates a new versioned deployment snapshot pointing to the current activeGraphId.
 */
async function publishUpdate(
  projectId: string,
  userId: string,
  publicUrl: string,
  activeGraphId: string,
): Promise<GoLiveResult | GoLiveError> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Get next version number
      const latestDeployment = await tx.deployment.findFirst({
        where: {
          projectId,
          environment: 'live',
          status: 'live',
          version: { not: null },
        },
        orderBy: { version: 'desc' },
        select: { version: true, graphSnapshotId: true },
      })

      const nextVersion = (latestDeployment?.version || 0) + 1

      // Check if the graph has actually changed since last publish
      if (latestDeployment?.graphSnapshotId === activeGraphId) {
        // No changes since last publish — still return success but note it
        return { publicUrl, version: latestDeployment?.version || 1, noChanges: true }
      }

      // Get graph data for change summary
      const activeGraph = await tx.backendGraph.findUnique({
        where: { id: activeGraphId },
        select: { graphData: true },
      })

      const graphData = activeGraph?.graphData as any
      const entityCount = Object.keys(graphData?.entities || {}).length
      const apiCount = Object.keys(graphData?.apis || {}).length

      // Compare with previous deployment's graph for diff summary
      let changeSummary = 'Backend updated'
      if (latestDeployment?.graphSnapshotId) {
        const prevGraph = await tx.backendGraph.findUnique({
          where: { id: latestDeployment.graphSnapshotId },
          select: { graphData: true },
        })
        const prevData = prevGraph?.graphData as any
        const prevEntities = Object.keys(prevData?.entities || {})
        const currEntities = Object.keys(graphData?.entities || {})
        const added = currEntities.filter((e: string) => !prevEntities.includes(e))
        const removed = prevEntities.filter((e: string) => !currEntities.includes(e))

        const parts: string[] = []
        if (added.length > 0) parts.push(`${added.length} table${added.length > 1 ? 's' : ''} added`)
        if (removed.length > 0) parts.push(`${removed.length} table${removed.length > 1 ? 's' : ''} removed`)
        if (parts.length === 0 && entityCount > 0) parts.push(`${entityCount} table${entityCount > 1 ? 's' : ''} updated`)
        if (apiCount > 0) parts.push(`${apiCount} endpoint${apiCount > 1 ? 's' : ''}`)
        changeSummary = parts.length > 0 ? parts.join(', ') : 'Configuration updated'
      }

      // Create new deployment version
      await tx.deployment.create({
        data: {
          id: `deploy_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          projectId,
          provider: 'backenly-managed',
          environment: 'live',
          status: 'live',
          url: publicUrl,
          completedAt: new Date(),
          version: nextVersion,
          graphSnapshotId: activeGraphId,
          changeSummary,
        },
      })

      // Update deployedAt timestamp and ensure live flags are set
      await tx.project.update({
        where: { id: projectId },
        data: {
          deployedAt: new Date(),
          isDeployed: true,
          publicEnabled: true,
          publicUrl,
        },
      })

      // Audit log
      await tx.auditLog.create({
        data: {
          id: `audit_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          projectId,
          userId,
          action: 'PUBLISH_UPDATE',
          type: 'deployment',
          details: JSON.stringify({
            publicUrl,
            version: nextVersion,
            graphSnapshotId: activeGraphId,
            changeSummary,
            timestamp: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      })

      return { publicUrl, version: nextVersion, noChanges: false }
    })

    return {
      kind: 'deployed',
      success: true,
      publicUrl: result.publicUrl,
      alreadyLive: true,
      version: result.version || 1,
      noChanges: result.noChanges === true,
    }
  } catch (err: any) {
    console.error('[GO_LIVE] Publish update failed:', err)
    return { kind: 'error', success: false, error: sanitizeDiagnostic(err) || 'Publish update failed' }
  }
}
