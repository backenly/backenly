/**
 * BLOCK RESUME
 * ============
 * Handles blocked states and credential-driven resumption.
 *
 * When a credential arrives (Stripe key, Resend key, etc.):
 *  1. Load the active BuildJob for the project
 *  2. Find all nodes blocked on that integration
 *  3. Unblock them in the graph
 *  4. Resume execution from those nodes
 *  5. Return the updated BuildJob with new results
 *
 * Rules:
 *  - Only nodes blocked on the specific integration are unblocked
 *  - Other blocked nodes (different credential) remain blocked
 *  - The build continues from exactly the unblocked node
 *  - Build state is persisted after resume
 *  - Never re-runs already-verified nodes
 */

import type { BuildJob, BuildContext, BuildNode } from './types'
import { BuildGraph, graphFromJob } from './build-graph'
import { loadActiveBuildJob, saveBuildJob, syncAgentStateBlockedIntegrations } from './continuation-store'
import { executeNode } from './node-executor'
import { verifyBuildJob } from './verifier'
import { updateBuildLedger, resultsToLedgerUpdates } from '../build-ledger'

export interface ResumeResult {
  resumed: boolean
  job: BuildJob | null
  unlockedNodes: string[]
  message: string
  buildResponse?: import('./types').BuildResponse
  /** Contextual progress message: "✓ X connected — now I need Y" */
  contextualMessage?: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called when a credential arrives for an integration.
 * Finds and resumes any blocked nodes that needed this integration.
 *
 * @param integrationId  e.g. "stripe", "resend", "openai"
 * @param ctx  Build context with projectId and emit function
 */
export async function resumeAfterCredential(
  integrationId: string,
  ctx: BuildContext,
): Promise<ResumeResult> {
  const job = await loadActiveBuildJob(ctx.projectId)

  if (!job) {
    return {
      resumed: false,
      job: null,
      unlockedNodes: [],
      message: 'No active build job found for this project',
    }
  }

  const graph = graphFromJob(job)
  const unlockedNodeIds = graph.unblockByIntegration(integrationId)

  if (unlockedNodeIds.length === 0) {
    return {
      resumed: false,
      job,
      unlockedNodes: [],
      message: `No blocked nodes found for integration: ${integrationId}`,
    }
  }

  // Emit progress to the stream
  ctx.emit?.('build_resume', {
    integrationId,
    unlockedNodes: unlockedNodeIds,
    message: `${integrationId} credential received — resuming ${unlockedNodeIds.length} blocked node(s)`,
  })

  // Execute the newly-unblocked nodes
  const executed: string[] = []
  for (const nodeId of unlockedNodeIds) {
    const node = graph.getNode(nodeId)
    if (!node) continue

    graph.markRunning(nodeId)
    ctx.emit?.('node_running', { nodeId, label: node.label })

    const result = await executeNode(node, ctx.projectId)
    graph.setStatus(nodeId, result.status, {
      executionDetail: result.detail,
      failureReason: result.failureReason,
      executedAt: new Date().toISOString(),
      verifiedAt: result.status === 'verified' ? new Date().toISOString() : undefined,
    })

    ctx.emit?.('node_complete', { nodeId, label: node.label, status: result.status, detail: result.detail })
    executed.push(nodeId)

    // Check if newly-verified node unblocks its dependents
    if (result.status === 'verified') {
      await executeReadyDependents(graph, nodeId, ctx)
    }
  }

  // Update job phases from graph state
  job.phases = graph.toJSON()
  job.status = graph.computeJobStatus()

  // Run verification pass
  await verifyBuildJob(job, graph, ctx.projectId)
  job.phases = graph.toJSON()
  job.status = graph.computeJobStatus()

  await saveBuildJob(job)

  // Sync blocked-integration list back to agentState so the build-status API
  // (legacy path) reflects the resolved credential and shows accurate remaining blocks.
  syncAgentStateBlockedIntegrations(ctx.projectId, graph.getNodesByStatus('blocked')).catch(() => {})

  // Sync to build ledger so the build-status API reflects the updated blocked/built state.
  // Without this, the dashboard banner shows a stale blocked count after credentials are connected.
  try {
    const all = graph.getAllNodes().filter((n: BuildNode) => n.type !== 'verification')
    const ledgerUpdates = resultsToLedgerUpdates(
      all.map((n: BuildNode) => ({
        type: n.type,
        name: n.label,
        success: n.status === 'verified',
        error: n.failureReason,
        blockedBy: n.blockedReason?.requiredEnvVar ?? (n.status === 'blocked' ? 'missing credential' : undefined),
        continuationGoal: n.status === 'blocked' ? undefined : undefined,
      }))
    )
    await updateBuildLedger(ctx.projectId, ledgerUpdates)
  } catch {
    // non-fatal — ledger sync is best-effort
  }

  const { renderBuildResponse, getIntegrationContext } = await import('./build-renderer')
  const buildResponse = renderBuildResponse(job, graph)

  // Build a contextual "X connected — now I need Y" message for the chat.
  // This replaces the generic full-state markdown with a conversational step.
  const completedLabel = integrationId.charAt(0).toUpperCase() + integrationId.slice(1)
  const nodesActivated = executed.length
  const stillBlocked = graph.getNodesByStatus('blocked')

  let contextualMessage: string
  if (stillBlocked.length === 0) {
    // All integrations connected — show the final build state
    contextualMessage = buildResponse.markdown
  } else {
    const nextBlocked = stillBlocked[0]
    const nextIntegrationId = nextBlocked.blockedReason?.resumeOnIntegration ?? nextBlocked.id
    const originalPrompt = job.originalPrompt ?? ''
    const allBuilt = graph.getAllNodes().filter(n => n.status === 'verified' && n.type !== 'verification')
    const nextCtx = getIntegrationContext(nextIntegrationId, allBuilt.length, originalPrompt)
    const upcoming = stillBlocked.slice(1)

    const lines: string[] = []
    lines.push(`✓ **${completedLabel} connected**${nodesActivated > 0 ? ` — ${nodesActivated} node${nodesActivated !== 1 ? 's' : ''} activated` : ''}.`)
    lines.push('')
    lines.push(`**${nextCtx.heading}**`)
    lines.push('')
    lines.push(nextCtx.body)
    if (nextBlocked.blockedReason?.requiredEnvVar) {
      lines.push('')
      lines.push(`→ Paste your \`${nextBlocked.blockedReason.requiredEnvVar}\` here — build resumes automatically.`)
    }
    if (upcoming.length > 0) {
      lines.push('')
      lines.push(`*After this: ${upcoming.map(u => u.label).join(' → ')}*`)
    }
    contextualMessage = lines.join('\n')
  }

  return {
    resumed: true,
    job,
    unlockedNodes: executed,
    message: `Resumed: built ${executed.length} previously-blocked node(s)`,
    buildResponse,
    contextualMessage,
  }
}

/**
 * Check if a message arriving from the user is a CONTINUATION trigger
 * that should resume an active BuildJob (not the old sticky-intent-store path).
 */
export async function tryResumeBuildJob(
  projectId: string,
  ctx: BuildContext,
): Promise<ResumeResult | null> {
  const job = await loadActiveBuildJob(projectId)
  if (!job) return null

  const graph = graphFromJob(job)
  const readyNodes = graph.getReadyNodes()

  if (readyNodes.length === 0) {
    // Nothing to run — either all done, all blocked, or all failed
    const blocked = graph.getNodesByStatus('blocked')
    if (blocked.length > 0) {
      return {
        resumed: false,
        job,
        unlockedNodes: [],
        message: `Build paused — ${blocked.length} node(s) need credentials`,
      }
    }
    return null
  }

  // Execute ready nodes — keep looping until no more ready nodes exist.
  // This prevents the "say continue" dead end where one batch runs but leaves
  // the next batch sitting pending with nothing to unblock them.
  const executed: string[] = []
  let batch = readyNodes

  while (batch.length > 0) {
    for (const node of batch) {
      graph.markRunning(node.id)
      ctx.emit?.('node_running', { nodeId: node.id, label: node.label })

      const result = await executeNode(node, ctx.projectId)
      graph.setStatus(node.id, result.status, {
        executionDetail: result.detail,
        failureReason: result.failureReason,
        executedAt: new Date().toISOString(),
        verifiedAt: result.status === 'verified' ? new Date().toISOString() : undefined,
      })

      ctx.emit?.('node_complete', { nodeId: node.id, label: node.label, status: result.status })
      executed.push(node.id)
    }

    // Persist intermediate progress and check for newly-unblocked nodes
    job.phases = graph.toJSON()
    job.status = graph.computeJobStatus()
    saveBuildJob(job).catch(() => {})

    batch = graph.getReadyNodes()
  }

  // Final persist
  job.phases = graph.toJSON()
  job.status = graph.computeJobStatus()
  await saveBuildJob(job)

  const { renderBuildResponse } = await import('./build-renderer')
  const buildResponse = renderBuildResponse(job, graph)

  return {
    resumed: true,
    job,
    unlockedNodes: executed,
    message: `Continued: executed ${executed.length} node(s)`,
    buildResponse,
  }
}

// ── Dependent Execution ───────────────────────────────────────────────────────

/**
 * After a node becomes verified, check if its dependents are now ready.
 * Execute any that are.
 */
async function executeReadyDependents(
  graph: BuildGraph,
  verifiedNodeId: string,
  ctx: BuildContext,
): Promise<void> {
  const readyNow = graph.getReadyNodes()

  for (const node of readyNow) {
    if (!node.dependencies.includes(verifiedNodeId)) continue

    graph.markRunning(node.id)
    ctx.emit?.('node_running', { nodeId: node.id, label: node.label })

    const result = await executeNode(node, ctx.projectId)
    graph.setStatus(node.id, result.status, {
      executionDetail: result.detail,
      failureReason: result.failureReason,
      executedAt: new Date().toISOString(),
      verifiedAt: result.status === 'verified' ? new Date().toISOString() : undefined,
    })

    ctx.emit?.('node_complete', { nodeId: node.id, label: node.label, status: result.status })

    // Recurse for newly-verified dependents
    if (result.status === 'verified') {
      await executeReadyDependents(graph, node.id, ctx)
    }
  }
}

// ── Blocked state summary ─────────────────────────────────────────────────────

/**
 * Get a summary of what credentials are blocking progress for a project.
 * Used to inject into prompts and responses.
 */
export async function getBlockedStateSummary(projectId: string): Promise<string | null> {
  const job = await loadActiveBuildJob(projectId)
  if (!job) return null

  const graph = graphFromJob(job)
  const blocked = graph.getNodesByStatus('blocked')
  if (blocked.length === 0) return null

  const lines = ['**Build is blocked on:**']
  for (const node of blocked) {
    const envVar = node.blockedReason?.requiredEnvVar
    const action = node.blockedReason?.userAction
    lines.push(`- ${node.label}${envVar ? ` (needs \`${envVar}\`)` : ''}`)
    if (action) lines.push(`  → ${action}`)
  }
  return lines.join('\n')
}

// ── Credential → integration ID mapping ──────────────────────────────────────

/**
 * Maps a detected integration ID from api-key-detector to the
 * internal integration ID used in build node IDs.
 * e.g. "stripe" → "stripe", "resend" → "resend"
 */
export function integrationIdFromDetected(detectedId: string): string {
  const MAP: Record<string, string> = {
    stripe: 'stripe',
    resend: 'resend',
    sendgrid: 'resend', // both are email providers
    openai: 'openai',
    anthropic: 'openai', // both are AI providers
    posthog: 'posthog',
  }
  return MAP[detectedId.toLowerCase()] ?? detectedId.toLowerCase()
}
