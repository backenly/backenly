/**
 * GET /api/ai-workspace/build-status/[projectId]
 * ================================================
 * Returns the current build phase status for a project, including:
 *  - Which phases are completed, blocked, or pending
 *  - Which integrations are blocked on missing credentials
 *  - What credentials are needed to unblock each integration
 *  - The behavioral completion flows defined by the domain template
 *
 * This powers the Replit-like "Building / Completed / Blocked / Pending" panel
 * in the project dashboard and the "resume blocked integration" flow.
 *
 * Auth: platform JWT (project owner only).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BuildStatusResponse {
  projectId: string
  /** Phase-level status derived from the most recent agent loop state */
  phases: Array<{
    phase: string
    label: string
    status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'skipped'
    blockedReason?: string
    blockedOn?: string
  }>
  /** Integrations waiting on credentials */
  blockedIntegrations: Array<{
    integration: string
    reason: string
    secretsNeeded: string[]
    /** Hint about where to get the credential */
    source?: string
  }>
  /** Whether any integration is blocked */
  hasBlocked: boolean
  /** Current overall status */
  overallStatus: 'building' | 'blocked' | 'completed' | 'failed' | 'unknown'
  /** Formatted phase status block (markdown) for display */
  statusText: string
  /** Behavioral completion flows for this domain (flow-first done criteria) */
  completionFlows: string[]
  /** When the last build state was saved */
  lastSavedAt?: string
}

// ── Route Handler ─────────────────────────────────────────────────────────────

async function handler(
  req: NextRequest,
  projectId: string,
): Promise<NextResponse> {

  try {
    // Load the last persisted agent state from AiConfiguration
    const config = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true, updatedAt: true },
    })

    const configData = (config?.config as Record<string, unknown>) ?? {}
    const agentState = (configData.agentState as any) ?? null

    // Build phase status from the saved agent state
    const { buildPlanGraph, formatBuildStatus, PHASE_LABELS } = await import('@/lib/ai/build-phases')
    const { getIntegrationWorkflow } = await import('@/lib/ai/integration-workflows')
    const { detectTemplateMatch } = await import('@/lib/ai/architecture-templates')

    let phases: BuildStatusResponse['phases'] = []
    let blockedIntegrations: BuildStatusResponse['blockedIntegrations'] = []
    let statusText = ''
    let overallStatus: BuildStatusResponse['overallStatus'] = 'unknown'
    let completionFlows: string[] = []

    if (agentState?.subgoals?.length > 0) {
      const subgoals: Array<{ id: string; description: string; status: string }> = agentState.subgoals

      // Build phase graph from saved subgoals
      const graph = buildPlanGraph(
        projectId,
        agentState.goal ?? '',
        subgoals.map((sg: any) => ({ id: sg.id, description: sg.description })),
      )

      // Update phase statuses from subgoal outcomes.
      // Reconcile against the key vault so that credentials stored after the build
      // was originally saved no longer appear as blocked (stale agentState entries).
      const rawBlockedIntegrations: Array<{ integration: string; reason: string; secretsNeeded: string[] }> =
        agentState.blockedIntegrations ?? []

      let savedBlockedIntegrations = rawBlockedIntegrations
      if (rawBlockedIntegrations.length > 0) {
        try {
          const { hasIntegrationKey: _hasKey } = await import('@/lib/services/integrationKeyStore')
          const checks = await Promise.all(
            rawBlockedIntegrations.map(async bi => {
              const primaryStored = await _hasKey(projectId, bi.integration)
              if (primaryStored) return null
              // Also check by env-var key name (e.g. 'stripe_webhook_secret')
              const envKey = (bi.secretsNeeded?.[0] ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
              if (envKey && envKey !== bi.integration && await _hasKey(projectId, envKey)) return null
              return bi
            }),
          )
          savedBlockedIntegrations = checks.filter((b): b is NonNullable<typeof b> => b !== null)
        } catch {
          // Non-fatal — use raw list as fallback
        }
      }

      for (const phase of graph.phases) {
        const phaseSubgoals = subgoals.filter(sg => phase.subgoalIds.includes(sg.id))
        const allDone    = phaseSubgoals.every(sg => sg.status === 'done')
        const anyBlocked = savedBlockedIntegrations.some(bi =>
          phaseSubgoals.some(sg => sg.description.toLowerCase().includes(bi.integration.toLowerCase()))
        )

        if (anyBlocked) {
          phase.status = 'blocked'
          const matchedBi = savedBlockedIntegrations.find(bi =>
            phaseSubgoals.some(sg => sg.description.toLowerCase().includes(bi.integration.toLowerCase()))
          )
          if (matchedBi) {
            phase.blockedReason = `${matchedBi.integration} requires credentials`
            phase.blockedOn = matchedBi.integration
          }
        } else if (allDone) {
          phase.status = 'completed'
        } else if (phaseSubgoals.some(sg => sg.status === 'done')) {
          phase.status = 'running'
        }
      }

      graph.blockedIntegrations = savedBlockedIntegrations
      graph.overallStatus = savedBlockedIntegrations.length > 0 ? 'blocked' : 'completed'

      phases = graph.phases.map(p => ({
        phase: p.phase,
        label: PHASE_LABELS[p.phase as keyof typeof PHASE_LABELS] ?? p.phase,
        status: p.status,
        blockedReason: p.blockedReason,
        blockedOn: p.blockedOn,
      }))

      // Enrich blocked integrations with workflow source info
      blockedIntegrations = savedBlockedIntegrations.map(bi => {
        const workflow = getIntegrationWorkflow(bi.integration)
        return {
          ...bi,
          source: workflow?.requiredSecrets[0]?.source,
        }
      })

      statusText = formatBuildStatus(graph)
      overallStatus = graph.overallStatus

      // Get completion flows from domain template
      const template = detectTemplateMatch(agentState.goal ?? '')
      completionFlows = template?.completionFlows ?? []
    }

    // ── BuildJob credential cross-check ──────────────────────────────────────────
    // The agentState path above can be stale: credentials may have been saved to
    // ProjectIntegrationKey but the blocked node was never reconciled in agentState.
    // Read the live BuildJob and verify each blocked node against the key vault.
    // If the credential IS stored, the block is stale and must be cleared from the response.
    try {
      const { loadActiveBuildJob } = await import('@/lib/ai/build-runtime/continuation-store')
      const { graphFromJob } = await import('@/lib/ai/build-runtime/build-graph')
      const { hasIntegrationKey } = await import('@/lib/services/integrationKeyStore')

      const buildJob = await loadActiveBuildJob(projectId)
      if (buildJob) {
        const graph = graphFromJob(buildJob)
        const blockedNodes = graph.getNodesByStatus('blocked')

        const seen = new Set<string>()
        const fresh: BuildStatusResponse['blockedIntegrations'] = []

        for (const node of blockedNodes) {
          const integId = node.blockedReason?.resumeOnIntegration
          if (!integId || seen.has(integId)) continue
          seen.add(integId)

          // Skip nodes whose credential is already in the vault (stale block)
          if (await hasIntegrationKey(projectId, integId)) continue
          const envVarKey = node.blockedReason?.requiredEnvVar?.toLowerCase()
          if (envVarKey && envVarKey !== integId && await hasIntegrationKey(projectId, envVarKey)) continue

          const workflow = getIntegrationWorkflow(integId)
          fresh.push({
            integration: integId,
            reason: node.blockedReason?.description ?? `${integId} credentials required`,
            secretsNeeded: node.blockedReason?.requiredEnvVar ? [node.blockedReason.requiredEnvVar] : [],
            source: workflow?.requiredSecrets[0]?.source,
          })
        }

        // Override with credential-verified list
        blockedIntegrations = fresh

        // Recompute overallStatus from the verified blocked list and live job status
        if (fresh.length > 0) {
          overallStatus = 'blocked'
        } else if (overallStatus === 'blocked' || overallStatus === 'unknown') {
          if (buildJob.status === 'verified') overallStatus = 'completed'
          else if (buildJob.status === 'running') overallStatus = 'building'
          else if (buildJob.status === 'failed') overallStatus = 'failed'
          else if (buildJob.status === 'partial' || buildJob.status === 'blocked') {
            // All credentials now connected — build will resume or has partially completed
            overallStatus = 'building'
          }
        }

        // Populate phases from BuildJob when agentState didn't produce them
        if (phases.length === 0 && buildJob.phases.length > 0) {
          phases = buildJob.phases.map(p => {
            const statuses = p.nodes.map(n => n.status)
            let s: BuildStatusResponse['phases'][0]['status'] = 'pending'
            if (statuses.every(x => x === 'verified')) s = 'completed'
            else if (statuses.some(x => x === 'running')) s = 'running'
            else if (statuses.some(x => x === 'blocked')) s = 'blocked'
            else if (statuses.some(x => x === 'failed')) s = 'failed'
            else if (statuses.some(x => x === 'verified' || x === 'partial')) s = 'running'
            return { phase: p.name, label: p.name, status: s }
          })
        }
      }
    } catch {
      // non-fatal — agentState-derived values remain as fallback
    }

    const response: BuildStatusResponse = {
      projectId,
      phases,
      blockedIntegrations,
      hasBlocked: blockedIntegrations.length > 0,
      overallStatus,
      statusText,
      completionFlows,
      lastSavedAt: config?.updatedAt?.toISOString(),
    }

    return NextResponse.json(response)
  } catch (err: any) {
    console.error('[BuildStatus] Error:', err?.message)
    return NextResponse.json(
      { error: 'Failed to load build status', projectId },
      { status: 500 },
    )
  }
}

export const GET = (req: NextRequest, ctx: { params: { projectId: string } }) =>
  withProjectValidation(req, (validated) => handler(req, validated.projectId))
