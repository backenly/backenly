/**
 * CONTINUATION STORE
 * ==================
 * Persists BuildJob state to Prisma's AiConfiguration.config JSON.
 * Same pattern as build-ledger.ts — no schema migration required.
 *
 * Rules:
 *  - One active BuildJob per project at a time
 *  - Stored state is the graph of record — never inferred from chat history
 *  - All reads return typed BuildJob or null — never undefined-ish fallbacks
 */

import { prisma } from '@/lib/db/prisma'
import type { BuildJob } from './types'

const BUILD_JOB_CONFIG_KEY = '__buildRuntimeJob'

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load the active BuildJob for a project.
 * Returns null if no job exists or the stored data is corrupt.
 */
export async function loadActiveBuildJob(projectId: string): Promise<BuildJob | null> {
  try {
    const aiConfig = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })

    if (!aiConfig?.config) return null

    const config = aiConfig.config as Record<string, unknown>
    const raw = config[BUILD_JOB_CONFIG_KEY]
    if (!raw || typeof raw !== 'object') return null

    const job = raw as BuildJob

    // Basic shape validation
    if (
      typeof job.id !== 'string' ||
      typeof job.projectId !== 'string' ||
      !Array.isArray(job.phases)
    ) {
      return null
    }

    return job
  } catch {
    return null
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────

/**
 * Persist a BuildJob to the project's AiConfiguration.
 * Replaces any existing job for the same project.
 */
export async function saveBuildJob(job: BuildJob): Promise<void> {
  try {
    job.updatedAt = new Date().toISOString()

    const existing = await prisma.aiConfiguration.findUnique({
      where: { projectId: job.projectId },
      select: { config: true },
    })

    const existingConfig = (existing?.config ?? {}) as Record<string, unknown>
    const newConfig = JSON.parse(JSON.stringify({
      ...existingConfig,
      [BUILD_JOB_CONFIG_KEY]: job,
    }))

    if (existing) {
      await prisma.aiConfiguration.update({
        where: { projectId: job.projectId },
        data: { config: newConfig, updatedAt: new Date() },
      })
    } else {
      await prisma.aiConfiguration.create({
        data: {
          projectId: job.projectId,
          model: 'gpt-4o-mini',
          config: newConfig,
        },
      })
    }
  } catch (err) {
    console.error('[BuildRuntime] Failed to save BuildJob:', err)
    // Non-fatal — the job exists in memory for this request cycle
  }
}

// ── Clear ─────────────────────────────────────────────────────────────────────

/**
 * Remove a BuildJob for a project (e.g. on explicit reset or completion).
 */
export async function clearBuildJob(projectId: string): Promise<void> {
  try {
    const existing = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })
    if (!existing?.config) return

    const config = existing.config as Record<string, unknown>
    const { [BUILD_JOB_CONFIG_KEY]: _removed, ...rest } = config
    const newConfig = JSON.parse(JSON.stringify(rest))

    await prisma.aiConfiguration.update({
      where: { projectId },
      data: { config: newConfig, updatedAt: new Date() },
    })
  } catch {
    // Non-fatal
  }
}

// ── Check for active job ──────────────────────────────────────────────────────

/**
 * Returns true if there is an incomplete BuildJob for the project.
 * Used by the chat route to decide whether to resume vs. start fresh.
 */
export async function hasActiveBuildJob(projectId: string): Promise<boolean> {
  const job = await loadActiveBuildJob(projectId)
  if (!job) return false
  return job.status === 'partial' || job.status === 'running' || job.status === 'blocked'
}

// ── Find node to resume from ──────────────────────────────────────────────────

/**
 * Returns the first pending or blocked node ID for a job.
 * Used to determine where to resume after a continuation trigger.
 */
export function findResumePoint(job: BuildJob): string | undefined {
  for (const phase of job.phases) {
    for (const node of phase.nodes) {
      if (node.status === 'pending' || node.status === 'partial') {
        return node.id
      }
    }
  }
  return undefined
}

// ── Agent-state sync (keeps legacy build-status path accurate) ───────────────

/**
 * Write the current blocked-integration list back to agentState so the
 * legacy build-status API path reflects live credential state.
 * Called after every saveBuildJob() that may change which nodes are blocked.
 *
 * @param projectId  Project whose AiConfiguration to update
 * @param blockedNodes  Current blocked BuildNodes from the live graph
 */
export async function syncAgentStateBlockedIntegrations(
  projectId: string,
  blockedNodes: Array<{ id: string; label: string; blockedReason?: { resumeOnIntegration?: string; description?: string; requiredEnvVar?: string } }>,
): Promise<void> {
  try {
    const dedupMap = new Map<string, { integration: string; reason: string; secretsNeeded: string[] }>()
    for (const node of blockedNodes) {
      const integId = node.blockedReason?.resumeOnIntegration
      if (!integId || dedupMap.has(integId)) continue
      dedupMap.set(integId, {
        integration: integId,
        reason: node.blockedReason?.description ?? 'credentials required',
        secretsNeeded: node.blockedReason?.requiredEnvVar ? [node.blockedReason.requiredEnvVar] : [],
      })
    }
    const blockedIntegrations = Array.from(dedupMap.values())

    const existing = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })
    if (!existing?.config) return

    const configData = existing.config as Record<string, unknown>
    const existingAgentState = (configData.agentState as Record<string, unknown>) ?? {}

    await prisma.aiConfiguration.update({
      where: { projectId },
      data: {
        config: {
          ...configData,
          agentState: { ...existingAgentState, blockedIntegrations },
        },
        updatedAt: new Date(),
      },
    })
  } catch {
    // non-fatal
  }
}

// ── Legacy truncated-plan lookup (previously in dynamic-agent-loop) ───────────

interface LoopCheckpoint {
  goal: string
  checkpointKey: string
  createdAt: string
  status: string
}

/**
 * Return the most recent truncated build plan for a project, if one exists
 * within the 7-day resume window. Used by the CONTINUATION handler so
 * "continue" / "resume" can bind to the plan without re-typing the full goal.
 */
export async function loadLatestTruncatedPlan(
  projectId: string,
): Promise<{ goal: string; checkpointKey: string; createdAt: string } | null> {
  try {
    const aiConfig = await prisma.aiConfiguration.findUnique({
      where: { projectId },
      select: { config: true },
    })
    if (!aiConfig?.config) return null
    const data = aiConfig.config as Record<string, unknown>
    const buildPlans = (data.buildPlans ?? {}) as Record<string, LoopCheckpoint>

    const maxAge = 7 * 24 * 60 * 60 * 1000
    const truncated = Object.values(buildPlans)
      .filter(p => p.status === 'truncated' && Date.now() - new Date(p.createdAt).getTime() < maxAge)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    if (truncated.length === 0) return null
    const latest = truncated[0]
    return { goal: latest.goal, checkpointKey: latest.checkpointKey, createdAt: latest.createdAt }
  } catch {
    return null
  }
}
