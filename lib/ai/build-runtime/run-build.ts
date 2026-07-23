/**
 * RUN BUILD — Main Build Orchestrator
 * =====================================
 * The primary entry point for Build mode execution.
 *
 * This replaces the chaotic dynamic agent loop for serious build requests.
 * It executes the build graph phase-by-phase, node-by-node, with real verification.
 *
 * Behavior:
 *  1. Compile or load a BuildJob from the prompt
 *  2. Execute nodes in dependency order (topological sort)
 *  3. Skip blocked nodes (emit blocked state, continue others)
 *  4. After each phase, check for ready dependents
 *  5. Run verification pass after execution
 *  6. Render structured response from real graph state
 *  7. Persist build job for continuation
 *
 * NOT allowed in this function:
 *  - LLM freeform summaries in the final response
 *  - "done" claims not backed by verified graph nodes
 *  - Generic chatbot fallback behavior
 *  - Stopping after first scaffold without completing the graph
 */

import { compileBuildJob, compilePlanJob, extractEntitiesFromExplicitList } from './domain-compiler'
import { BuildGraph, graphFromJob } from './build-graph'
import { executeNode } from './node-executor'
import { verifyBuildJob } from './verifier'
import { renderBuildResponse, renderPlanResponse } from './build-renderer'
import { saveBuildJob, loadActiveBuildJob } from './continuation-store'
import { tryResumeBuildJob } from './block-resume'
import { updateBuildLedger, resultsToLedgerUpdates } from '../build-ledger'
import { acquireBuildLock, releaseBuildLock, checkBuildBudget } from './build-lock'
import type { BuildJob, BuildContext, BuildResponse, BuildNode } from './types'

// ── Public entry points ───────────────────────────────────────────────────────

export interface RunBuildOptions {
  mode: 'build' | 'plan'
  /** If true, resume an existing BuildJob instead of creating a new one */
  resume?: boolean
}

export interface RunBuildResult {
  response: BuildResponse | null
  planMarkdown?: string
  jobId: string
  truncated: boolean
}

/**
 * Execute a Build mode request through the new build runtime.
 *
 * @param prompt  The user's build request
 * @param ctx     Build context (projectId, userId, emit, etc.)
 * @param opts    mode: 'build' | 'plan', resume: boolean
 */
export async function runBuild(
  prompt: string,
  ctx: BuildContext,
  opts: RunBuildOptions = { mode: 'build' },
): Promise<RunBuildResult> {
  // ── Plan mode: return architecture preview without mutations ───────────────
  if (opts.mode === 'plan') {
    const planJob = await compilePlanJob(prompt, ctx)
    const planResponse = renderPlanResponse(planJob)
    return {
      response: null,
      planMarkdown: planResponse.markdown,
      jobId: planJob.id,
      truncated: false,
    }
  }

  // ── Resume mode: continue an existing BuildJob ────────────────────────────
  if (opts.resume) {
    // Resume operations skip the cooldown gate — they are continuations of an
    // already-accounted-for build, not new operations.
    const resumeLock = await acquireBuildLock(ctx.projectId, 'resume')
    if (!resumeLock.acquired) {
      return {
        response: {
          message: resumeLock.blockedReason ?? 'Another build is already running.',
          built: [], blocked: [], failed: [], remaining: [], status: 'failed',
          summary: resumeLock.blockedReason ?? 'Locked',
          jobId: 'locked',
        } as any,
        jobId: 'locked',
        truncated: false,
      }
    }
    try {
      const resumeResult = await tryResumeBuildJob(ctx.projectId, ctx)
      if (resumeResult?.resumed && resumeResult.buildResponse) {
        return {
          response: resumeResult.buildResponse,
          jobId: resumeResult.job?.id ?? 'unknown',
          truncated: resumeResult.job?.status === 'partial',
        }
      }
    } finally {
      await releaseBuildLock(resumeLock.handle)
    }
  }

  // ── Build mode: compile and execute a new BuildJob ────────────────────────

  // ── Governance: budget check + project lock ────────────────────────────────
  const budget = await checkBuildBudget(ctx.projectId)
  if (!budget.allowed) {
    ctx.emit?.('error', { message: budget.blockedReason })
    return {
      response: {
        message: budget.blockedReason ?? 'Build rate limit reached.',
        built: [], blocked: [], failed: [], remaining: [], status: 'failed',
        summary: budget.blockedReason ?? 'Rate limited',
        jobId: 'rate-limited',
      } as any,
      jobId: 'rate-limited',
      truncated: false,
    }
  }

  const buildLock = await acquireBuildLock(ctx.projectId, 'build')
  if (!buildLock.acquired) {
    ctx.emit?.('error', { message: buildLock.blockedReason })
    return {
      response: {
        message: buildLock.blockedReason ?? 'Another build is already running for this project.',
        built: [], blocked: [], failed: [], remaining: [], status: 'failed',
        summary: buildLock.blockedReason ?? 'Locked',
        jobId: 'locked',
      } as any,
      jobId: 'locked',
      truncated: false,
    }
  }

  // Check if there's an existing active job for this project
  const existingJob = await loadActiveBuildJob(ctx.projectId)
  let job: BuildJob

  try {
    if (existingJob && isRelatedBuild(prompt, existingJob)) {
      // Continue the existing build
      job = existingJob
      ctx.emit?.('build_continue', { jobId: job.id, prompt })
    } else {
      // New build job
      job = await compileBuildJob(prompt, ctx)
      ctx.emit?.('build_start', {
        jobId: job.id,
        domain: job.domain,
        phases: job.phases.length,
        totalNodes: job.phases.flatMap(p => p.nodes).length,
      })

      emitProductPlan(job, ctx)
      await saveBuildJob(job)
    }

    // ── BuildJob entity validation gate ────────────────────────────────────
    const validationError = validateBuildJobEntities(job, prompt)
    if (validationError) {
      console.warn(`[RunBuild] BuildJob validation failed: ${validationError}`)
      return {
        response: {
          message: validationError,
          built: [], blocked: [], failed: [], remaining: [],
          status: 'failed', summary: validationError, jobId: job.id,
        } as any,
        jobId: job.id,
        truncated: false,
      }
    }

    // ── Execute the build graph ─────────────────────────────────────────────
    const graph = graphFromJob(job)
    job.status = 'running'

    await executeBuildGraph(job, graph, ctx)

    // ── Verification pass ───────────────────────────────────────────────────
    const { structuralReports, validationReport } = await verifyBuildJob(job, graph, ctx.projectId)
    ctx.emit?.('verification_complete', { reports: structuralReports.length })

    // ── Blueprint repair loop ───────────────────────────────────────────────
    // Run even without a blueprint — use the graph itself as the source of truth.
    await runBlueprintRepairLoop(job, graph, ctx)

    // ── Sync graph state back to job ────────────────────────────────────────
    job.phases = graph.toJSON()
    job.status = graph.computeJobStatus()
    job.updatedAt = new Date().toISOString()

    await syncToLedger(job, graph, ctx.projectId)
    await syncToBackendGraph(job, graph, ctx.projectId)
    await installRealtimeTriggersForBuild(job, graph, ctx.projectId)

    // ── Persist final state, then clear if complete ─────────────────────────
    await saveBuildJob(job)
    if (job.status === 'verified') {
      // Evict the job from AiConfiguration so the config blob doesn't grow unboundedly.
      // The BackendGraph + ledger are the permanent records; the BuildJob is transient.
      const { clearBuildJob } = await import('./continuation-store')
      await clearBuildJob(ctx.projectId)
    }

    // ── Render structured response from real graph state ────────────────────
    const buildResponse = renderBuildResponse(job, graph, validationReport)

    // ── Long-horizon evolution update (fire-and-forget) ─────────────────────
    import('@/lib/ai/long-horizon-orchestrator')
      .then(({ updateEvolutionAfterBuild }) => updateEvolutionAfterBuild(ctx.projectId, buildResponse, prompt))
      .catch(() => {})

    // ── Post-build orchestration: reconcile → health scan → auto-fix ─────────
    // Runs asynchronously — never blocks the SSE response.
    // Wires: schema reconciliation (desired vs actual), multi-agent health scan,
    //        safe auto-fixes, dangerous findings queued for approval.
    import('./post-build-orchestrator')
      .then(({ triggerPostBuildOrchestration }) =>
        triggerPostBuildOrchestration(ctx.projectId, ctx.userId, buildResponse)
      )
      .catch(() => {})

    ctx.emit?.('build_complete', {
      jobId: job.id,
      status: job.status,
      built: buildResponse.built.length,
      blocked: buildResponse.blocked.length,
      failed: buildResponse.failed.length,
    })

    return {
      response: buildResponse,
      jobId: job.id,
      truncated: job.status === 'partial',
    }
  } finally {
    await releaseBuildLock(buildLock.handle)
  }
}

// ── Product Plan Emission ─────────────────────────────────────────────────────

/**
 * Emit a comprehensive `plan` SSE event before execution starts.
 *
 * When a ProductBlueprint exists (set by goalUnderstandingStage), the summary
 * is extremely rich — it shows ALL dimensions the AI inferred from the goal.
 * When no blueprint exists, we fall back to a plan derived from the BuildJob.
 *
 * This is the "I understood your product" moment in the UX.
 */
function emitProductPlan(job: BuildJob, ctx: BuildContext): void {
  if (!ctx.emit) return

  const blueprint = ctx.productBlueprint

  // Build step list from job phases
  const steps = job.phases.flatMap(p =>
    p.nodes.map(n => ({ action: n.type, label: n.label }))
  )

  // Build phase groups for the phase-aware progress UI
  const phaseGroups = job.phases.map(p => ({
    phase: `phase_${p.number}`,
    label: p.name,
    subgoalIds: p.nodes.map(n => n.id),
  }))

  // Collect blocked integrations (credentials needed)
  const credentialsNeeded = job.phases
    .flatMap(p => p.nodes)
    .filter(n => n.status === 'blocked' && n.blockedReason?.requiredEnvVar)
    .map(n => ({
      name: n.blockedReason!.resumeOnIntegration ?? n.id.replace(/^[^.]+\./, ''),
      hint: n.blockedReason!.userAction ?? `Set ${n.blockedReason!.requiredEnvVar}`,
    }))

  // Build the architectureSummary string
  let architectureSummary: string

  if (blueprint) {
    const lines: string[] = []

    lines.push(`**${blueprint.oneLiner}**`)
    lines.push(``)
    lines.push(`**Actors:** ${blueprint.actors.join(', ')}`)
    lines.push(`**Core:** ${blueprint.coreValueExchange}`)
    lines.push(``)

    lines.push(`**Schema** (${blueprint.entities.length} tables)`)
    lines.push(blueprint.entities.map(e => e.name).join(', '))
    lines.push(``)

    lines.push(`**Auth**`)
    lines.push(`Roles: ${blueprint.authRoles.join(', ')} | Providers: ${blueprint.authProviders.join(', ')}`)
    lines.push(``)

    if (blueprint.storageBuckets.length > 0) {
      lines.push(`**Storage**`)
      blueprint.storageBuckets.forEach(b =>
        lines.push(`• ${b.name} (${b.isPublic ? 'public' : 'private'}) — ${b.purpose}`)
      )
      lines.push(``)
    }

    if (blueprint.integrations.length > 0) {
      lines.push(`**Integrations**`)
      blueprint.integrations.forEach(i =>
        lines.push(`• ${i.name.toUpperCase()} (${i.required ? 'required' : 'optional'}) — ${i.purpose}`)
      )
      lines.push(``)
    }

    if (blueprint.realtimeChannels.length > 0) {
      lines.push(`**Realtime:** ${blueprint.realtimeChannels.join(', ')}`)
      lines.push(``)
    }

    if (blueprint.functions.length > 0) {
      lines.push(`**Functions**`)
      blueprint.functions.forEach(f =>
        lines.push(`• ${f.name} (${f.trigger}${f.table ? ':' + f.table : ''}) — ${f.purpose}`)
      )
      lines.push(``)
    }

    if (blueprint.permissions.length > 0) {
      lines.push(`**Permissions**`)
      blueprint.permissions.forEach(p => lines.push(`• ${p}`))
      lines.push(``)
    }

    if (blueprint.productionChecks.length > 0) {
      lines.push(`**Production**`)
      blueprint.productionChecks.forEach(c => lines.push(`• ${c}`))
    }

    architectureSummary = lines.join('\n')
  } else {
    // Fallback: derive summary from BuildJob
    const schemaNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'schema')
    const integrationNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'integration')
    const storageNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'storage')

    const parts: string[] = []
    if (schemaNodes.length > 0) {
      parts.push(`**Schema** (${schemaNodes.length} tables): ${schemaNodes.map(n => n.id.replace('schema.', '')).join(', ')}`)
    }
    if (storageNodes.length > 0) {
      parts.push(`**Storage:** ${storageNodes.map(n => n.label).join(', ')}`)
    }
    if (integrationNodes.length > 0) {
      parts.push(`**Integrations:** ${integrationNodes.map(n => n.label).join(', ')}`)
    }
    architectureSummary = parts.join('\n\n')
  }

  ctx.emit('plan', {
    steps,
    domain: job.domain,
    architectureSummary,
    credentialsNeeded: credentialsNeeded.length > 0 ? credentialsNeeded : undefined,
    phaseGroups,
  })
}

// ── Graph Execution ───────────────────────────────────────────────────────────

/**
 * Execute all nodes in the build graph in dependency order, phase-by-phase.
 *
 * When ENABLE_AGENTIC_PHASE_PLANNER is on, the Phase Planner is called
 * between phases. The planner observes the just-completed phase's real
 * status and can:
 *   - proceed_as_planned
 *   - replan_next_phase (insert/remove nodes from the upcoming phase)
 *   - insert_repair_phase (slot a fresh phase before the next one)
 *   - request_credentials (surface a blocked card)
 *   - abort (unrecoverable)
 *
 * When the flag is off this function behaves identically to the legacy
 * single-pass topological executor — phases are still walked in order
 * because the underlying topo sort already prefers lower phase numbers.
 */
async function executeBuildGraph(
  job: BuildJob,
  graph: BuildGraph,
  ctx: BuildContext,
): Promise<void> {
  const { FLAGS } = await import('@/lib/config/flags')
  const agentic = FLAGS.ENABLE_AGENTIC_PHASE_PLANNER

  // Distinct phase numbers in ascending order. Re-read on every iteration
  // because the planner may insert new phases mid-build.
  const phaseNumbers = () =>
    Array.from(new Set(graph.getAllNodes().map(n => n.phase))).sort((a, b) => a - b)

  let phases = phaseNumbers()
  let i = 0
  while (i < phases.length) {
    const phaseNum = phases[i]
    await executePhase(job, graph, ctx, phaseNum)

    if (agentic) {
      const nextPhaseNum = phases[i + 1]
      const decision = await runPhasePlannerHook(job, graph, ctx, phaseNum, nextPhaseNum)
      // The planner may have inserted nodes / new phases. Re-derive the list.
      if (decision?.kind === 'abort') {
        ctx.emit?.('agent_aborted', { reason: decision.reasoning })
        break
      }
      phases = phaseNumbers()
    }

    i++
  }
}

/**
 * Execute every pending, dep-satisfied node in a single phase, in topo order.
 * Preserves the exact per-node semantics of the previous single-pass loop —
 * the only change is the outer iteration boundary.
 */
async function executePhase(
  job: BuildJob,
  graph: BuildGraph,
  ctx: BuildContext,
  phaseNumber: number,
): Promise<void> {
  // Within a phase we still use the global topo sort so cross-phase deps
  // are respected. We just filter to the current phase's nodes.
  const ordered = graph.topoSort().filter(n => n.phase === phaseNumber)

  for (const node of ordered) {
    // Skip already-done or blocked nodes
    if (node.status === 'verified' || node.status === 'blocked' || node.status === 'failed') {
      if (node.status === 'blocked') {
        ctx.emit?.('node_blocked', {
          nodeId: node.id,
          label: node.label,
          reason: node.blockedReason?.description,
          requiredEnvVar: node.blockedReason?.requiredEnvVar,
          integrationId: node.blockedReason?.resumeOnIntegration,
        })
      }
      continue
    }

    // Skip verification nodes (handled separately after execution)
    if (node.type === 'verification') continue

    // Check dependencies are all verified or at minimum partial
    // 'partial' counts as satisfied — the dep ran and produced partial results,
    // downstream nodes should still proceed rather than staying stuck pending
    const unmetDeps = node.dependencies.filter(depId => {
      const dep = graph.getNode(depId)
      return dep && dep.status !== 'verified' && dep.status !== 'partial'
    })

    if (unmetDeps.length > 0) {
      const depNodes = unmetDeps.map(id => graph.getNode(id))
      const anyBlocked = depNodes.some(d => d?.status === 'blocked')
      const anyFailed = depNodes.some(d => d?.status === 'failed')

      if (anyBlocked || anyFailed) {
        const blockingDep = depNodes.find(d => d?.status === 'blocked')
        if (blockingDep) {
          // Inherit the block reason from the dependency
          graph.setStatus(node.id, 'pending') // leave as pending — will re-check on resume
        }
      }
      continue
    }

    // Execute the node
    graph.markRunning(node.id)
    ctx.emit?.('node_running', { nodeId: node.id, label: node.label, phase: node.phase })

    const result = await executeNode(node, ctx.projectId)

    graph.setStatus(node.id, result.status, {
      executionDetail: result.detail,
      failureReason: result.failureReason,
      executedAt: new Date().toISOString(),
      verifiedAt: result.status === 'verified' ? new Date().toISOString() : undefined,
      blockedReason: result.blockedReason,
    })

    ctx.emit?.('node_complete', {
      nodeId: node.id,
      label: node.label,
      status: result.status,
      detail: result.detail,
    })

    // Save progress after each node (crash recovery)
    job.phases = graph.toJSON()
    job.updatedAt = new Date().toISOString()
    saveBuildJob(job).catch(() => {}) // non-blocking persist
  }
}

/**
 * Inter-phase agent hook — runs ONLY when ENABLE_AGENTIC_PHASE_PLANNER is on.
 *
 * - Builds a PhaseObservation from the just-completed phase
 * - Calls the planner (gpt-4o-mini, validated, bounded)
 * - Applies effects to the graph (insert / remove nodes, slot repair phases)
 * - Persists the decision on the BuildJob for audit
 * - Emits an `agent_decision` SSE event so the UI can render the reasoning
 *
 * Returns the decision so the outer loop can short-circuit on `abort`.
 */
async function runPhasePlannerHook(
  job: BuildJob,
  graph: BuildGraph,
  ctx: BuildContext,
  justFinishedPhase: number,
  nextPhase: number | undefined,
): Promise<{ kind: string; reasoning: string } | null> {
  try {
    const { decideNextPhase, applyPhaseDecisionToJob, effectsFromDecision } =
      await import('./phase-planner')

    // Build the observation snapshot from real graph state.
    const phaseNodes = graph.getNodesByPhase(justFinishedPhase)
    const nextPhaseNodes = nextPhase !== undefined ? graph.getNodesByPhase(nextPhase) : []
    const observation = {
      phaseNumber: justFinishedPhase,
      phaseName: job.phases.find(p => p.number === justFinishedPhase)?.name ?? `Phase ${justFinishedPhase}`,
      nodes: phaseNodes.map(n => ({
        id: n.id,
        label: n.label,
        type: n.type,
        status: n.status,
        failureReason: n.failureReason,
        blockedReason: n.blockedReason?.description,
        detail: n.executionDetail,
      })),
      nextPhase:
        nextPhase !== undefined
          ? {
              number: nextPhase,
              name: job.phases.find(p => p.number === nextPhase)?.name ?? `Phase ${nextPhase}`,
              nodeIds: nextPhaseNodes.map(n => n.id),
            }
          : undefined,
    }

    const result = await decideNextPhase(job, observation)
    const decision = result.decision

    // Persist + emit regardless of whether the planner was authoritative
    const recorded = applyPhaseDecisionToJob(
      job,
      result,
      justFinishedPhase,
      decision.kind === 'abort' ? 'end' : (nextPhase ?? 'end'),
    )

    ctx.emit?.('agent_decision', {
      afterPhase: recorded.afterPhase,
      appliesTo: recorded.appliesTo,
      kind: recorded.kind,
      reasoning: recorded.reasoning,
      insertedNodeIds: recorded.insertedNodeIds,
      removedNodeIds: recorded.removedNodeIds,
      requestedIntegrationIds: recorded.requestedIntegrationIds,
      fallbackReason: recorded.fallbackReason,
    })

    // Translate the decision into graph mutations
    const effects = effectsFromDecision(decision, job, justFinishedPhase)

    // 1. Remove pending nodes the planner asked us to drop
    for (const id of effects.removedNodeIds) {
      const removed = removeNodeFromGraph(graph, job, id)
      if (removed) ctx.emit?.('agent_removed_node', { nodeId: id })
    }

    // 2. Insert new nodes into the next phase
    for (const node of effects.insertedNodes) {
      insertNodeIntoGraph(graph, job, node)
      ctx.emit?.('agent_inserted_node', { nodeId: node.id, phase: node.phase, label: node.label, type: node.type })
    }

    // 3. Slot in repair phases (numbered between the just-finished and next phase)
    for (const repairPhase of effects.newPhases) {
      // Pick a numeric phase slot strictly between justFinishedPhase and nextPhase.
      const slot = nextPhase !== undefined
        ? (justFinishedPhase + nextPhase) / 2
        : justFinishedPhase + 0.5
      repairPhase.number = slot
      for (const n of repairPhase.nodes) n.phase = slot
      job.phases.push(repairPhase)
      for (const n of repairPhase.nodes) {
        insertNodeIntoGraph(graph, job, n, /* skipJobPush */ true)
        ctx.emit?.('agent_inserted_node', { nodeId: n.id, phase: n.phase, label: n.label, type: n.type, repair: true })
      }
    }

    // Persist the updated graph + decision log (best-effort, non-blocking)
    job.phases = graph.toJSON()
    job.updatedAt = new Date().toISOString()
    saveBuildJob(job).catch(() => {})

    return { kind: decision.kind, reasoning: decision.reasoning }
  } catch (err: any) {
    // Planner errors are NEVER fatal — fall back to deterministic flow.
    console.warn('[run-build] phase planner hook failed (non-fatal):', err?.message)
    return null
  }
}

/**
 * Insert a planner-proposed node into the graph + job phases.
 * Idempotent: silently no-ops if a node with the same id already exists.
 */
function insertNodeIntoGraph(
  graph: BuildGraph,
  job: BuildJob,
  node: BuildNode,
  skipJobPush: boolean = false,
): void {
  if (graph.getNode(node.id)) return
  // Use the graph's internal map via toJSON / rebuild — but the public API
  // doesn't expose direct insertion, so we mutate the underlying phases
  // structure and reconstruct the graph entry inline.
  ;(graph as any).nodes.set(node.id, node)

  if (!skipJobPush) {
    const phase = job.phases.find(p => p.number === node.phase)
    if (phase) {
      phase.nodes.push(node)
    } else {
      job.phases.push({
        number: node.phase,
        name: `Phase ${node.phase}`,
        nodes: [node],
      })
    }
  }
}

/**
 * Remove a pending node from both the graph and the job. Returns true on
 * success. Refuses to remove non-pending nodes (semantic guard already
 * checked, but defense in depth).
 */
function removeNodeFromGraph(graph: BuildGraph, job: BuildJob, nodeId: string): boolean {
  const node = graph.getNode(nodeId)
  if (!node || node.status !== 'pending') return false
  ;(graph as any).nodes.delete(nodeId)
  for (const phase of job.phases) {
    phase.nodes = phase.nodes.filter(n => n.id !== nodeId)
  }
  return true
}

// ── Ledger Sync ───────────────────────────────────────────────────────────────

/**
 * Sync the new build graph state to the old BuildLedger.
 * This ensures backward compatibility with UI components reading the ledger.
 */
async function syncToLedger(job: BuildJob, graph: BuildGraph, projectId: string): Promise<void> {
  try {
    const all = graph.getAllNodes().filter(n => n.type !== 'verification')
    const updates = resultsToLedgerUpdates(
      all.map(n => ({
        type: n.type,
        name: n.label,
        success: n.status === 'verified',
        error: n.failureReason,
        blockedBy: n.blockedReason?.requiredEnvVar ?? (n.status === 'blocked' ? 'missing credential' : undefined),
        continuationGoal: n.status === 'blocked' ? job.originalPrompt : undefined,
      }))
    )
    await updateBuildLedger(projectId, updates)
  } catch {
    // Non-fatal — ledger sync is best-effort
  }
}

// ── BackendGraph Sync ─────────────────────────────────────────────────────────

/**
 * Sync built schema nodes to the BackendGraph so the inspector shows tables.
 * This bridges the gap: build runtime creates tables in workspace schema but
 * historically didn't update the graph. Without this, /api/database/tables
 * (graph-reader) returns empty even when tables exist in the DB.
 */
async function syncToBackendGraph(job: BuildJob, graph: BuildGraph, projectId: string): Promise<void> {
  try {
    const schemaNodes = graph.getAllNodes().filter(
      n => n.type === 'schema' && (n.status === 'verified' || n.status === 'partial')
    )
    if (schemaNodes.length === 0) return

    const { getActiveGraph, saveNewGraph, createInitialGraph } = await import('@/lib/orchestration/graph-pointer')
    const existing = await getActiveGraph(projectId)

    const entitiesFromBuild: Record<string, any> = {}
    for (const node of schemaNodes) {
      const tableName = node.id.replace(/^schema\./, '')
      entitiesFromBuild[tableName] = {
        fields: {},
        createdAt: node.executedAt ?? new Date().toISOString(),
        createdBy: 'build-runtime',
      }
    }

    if (existing) {
      // Merge new entities into the existing graph
      const merged = {
        ...existing,
        entities: { ...(existing.entities ?? {}), ...entitiesFromBuild },
      }
      await saveNewGraph(projectId, merged as any, undefined, { skipBillingCheck: true })
    } else {
      // No graph exists yet — create one from scratch
      const minimal = {
        version: '1',
        projectId,
        entities: entitiesFromBuild,
        apis: {},
        auth: { enabled: false, providers: {} },
        relationships: [],
      }
      await createInitialGraph(projectId, minimal as any)
    }

    console.log(`[run-build] ✅ Synced ${schemaNodes.length} schema nodes to BackendGraph`)
  } catch (err: any) {
    // Non-fatal — the fallback introspection path in tables API handles this
    console.warn('[run-build] ⚠️ BackendGraph sync failed (non-fatal):', err?.message)
  }
}

// ── Realtime Trigger Auto-Install ─────────────────────────────────────────────

/**
 * Install PostgreSQL NOTIFY triggers on every table created by this build.
 * Called once after executeBuildGraph so realtime works immediately without
 * the user having to run ENABLE_REALTIME separately.
 */
async function installRealtimeTriggersForBuild(job: BuildJob, graph: BuildGraph, projectId: string): Promise<void> {
  try {
    const schemaNodes = graph.getAllNodes().filter(
      n => n.type === 'schema' && (n.status === 'verified' || n.status === 'partial')
    )
    if (schemaNodes.length === 0) return

    const tableNames = schemaNodes.map(n => n.id.replace(/^schema\./, ''))
    const { installRealtimeTriggersForAllTables } = await import('@/lib/services/realtimeTriggers')
    await installRealtimeTriggersForAllTables(projectId, tableNames)
    console.log(`[run-build] ✅ Installed realtime triggers on ${tableNames.length} tables`)
  } catch (err: any) {
    // Non-fatal
    console.warn('[run-build] ⚠️ Realtime trigger install failed (non-fatal):', err?.message)
  }
}

// ── Blueprint Repair Loop ─────────────────────────────────────────────────────

/**
 * After the main build + verification pass, diff the ProductBlueprint against
 * actual node states. Retry every failed node once (no credential blocks —
 * those are surfaced to the user). Re-sync job state after the repair attempt.
 *
 * This is a single retry pass — not an infinite loop. If a node fails twice,
 * it stays failed and the user sees it in BuildResponse.failed[].
 */
async function runBlueprintRepairLoop(
  job: BuildJob,
  graph: BuildGraph,
  ctx: BuildContext,
): Promise<void> {
  try {
    const { checkBlueprintGaps } = await import('./blueprint-verifier')
    // Use the blueprint when available; fall back to a synthetic gap report
    // derived from the graph's own failed nodes so repair always runs.
    const gapReport = ctx.productBlueprint
      ? checkBlueprintGaps(job, ctx.productBlueprint)
      : buildGraphGapReport(graph)

    if (!gapReport.hasGaps) {
      console.log('[RunBuild] Blueprint repair: no gaps — build fully matches blueprint')
      return
    }

    console.log(
      `[RunBuild] Blueprint repair: ${gapReport.repairable.length} repairable, ` +
      `${gapReport.credentialBlocked.length} credential-blocked, ` +
      `${gapReport.missingNodes.length} missing`,
    )

    // Emit gap summary for the progress UI
    if (gapReport.credentialBlocked.length > 0) {
      ctx.emit?.('blueprint_gaps', {
        credentialBlocked: gapReport.credentialBlocked.map(g => ({
          item: g.blueprintItem,
          reason: g.description,
          requiredEnvVar: g.requiredEnvVar,
          integrationId: g.integrationId,
        })),
        missingNodes: gapReport.missingNodes.map(g => g.blueprintItem),
      })
    }

    if (gapReport.repairable.length === 0) return

    ctx.emit?.('repair_start', {
      repairable: gapReport.repairable.length,
      items: gapReport.repairable.map(g => g.blueprintItem),
    })

    let repaired = 0
    for (const gap of gapReport.repairable) {
      if (!gap.nodeId) continue
      const node = graph.getNode(gap.nodeId)
      if (!node || node.status !== 'failed') continue

      ctx.emit?.('node_running', { nodeId: gap.nodeId, label: node.label, phase: node.phase, repair: true })

      // Reset status to pending so executeNode can run
      graph.setStatus(gap.nodeId, 'pending')
      graph.markRunning(gap.nodeId)

      const result = await executeNode(node, ctx.projectId)
      graph.setStatus(gap.nodeId, result.status, {
        executionDetail: result.detail,
        failureReason: result.failureReason,
        executedAt: new Date().toISOString(),
        verifiedAt: result.status === 'verified' ? new Date().toISOString() : undefined,
        blockedReason: result.blockedReason,
      })

      ctx.emit?.('node_complete', {
        nodeId: gap.nodeId,
        label: node.label,
        status: result.status,
        detail: result.detail,
        repair: true,
      })

      if (result.status === 'verified') repaired++

      // Persist repair progress (crash recovery)
      job.phases = graph.toJSON()
      job.updatedAt = new Date().toISOString()
      saveBuildJob(job).catch(() => {})
    }

    console.log(`[RunBuild] Blueprint repair complete: ${repaired}/${gapReport.repairable.length} nodes repaired`)
    ctx.emit?.('repair_done', { repaired, attempted: gapReport.repairable.length })
  } catch (err: any) {
    // Non-fatal — repair loop failure never breaks the main build
    console.warn('[RunBuild] Blueprint repair loop failed (non-fatal):', err?.message)
  }
}

// ── Graph-based gap report (blueprint-free repair) ────────────────────────────

/**
 * Build a minimal GapReport from the graph's failed nodes so the repair loop
 * always runs — even when no ProductBlueprint was set by goalUnderstandingStage.
 */
function buildGraphGapReport(graph: BuildGraph): {
  hasGaps: boolean
  repairable: Array<{ nodeId: string; blueprintItem: string; description: string }>
  credentialBlocked: any[]
  missingNodes: any[]
} {
  const failed = graph.getAllNodes().filter(n => n.status === 'failed' && n.type !== 'verification')
  return {
    hasGaps: failed.length > 0,
    repairable: failed.map(n => ({
      nodeId: n.id,
      blueprintItem: n.label,
      description: n.failureReason ?? 'Node failed during execution',
    })),
    credentialBlocked: [],
    missingNodes: [],
  }
}

// ── Build Request Detection ───────────────────────────────────────────────────

/**
 * Check if a new prompt is a follow-up extension of an existing build job.
 * Used to decide whether to continue the same backend vs. start a new one.
 *
 * Rules:
 *  1. Failed jobs always start fresh.
 *  2. The new prompt must have a clear expansion/addition signal.
 *  3. Verified and partial jobs both qualify for extension (user is adding features).
 *  4. A new full build description (long prompt with domain keywords) starts fresh.
 */
function isRelatedBuild(newPrompt: string, existingJob: BuildJob): boolean {
  if (existingJob.status === 'failed') return false // failed job — always start fresh

  const lowerPrompt = newPrompt.toLowerCase()

  // If the prompt is a full new build description (long prompt containing a build verb +
  // domain keyword), treat it as a fresh request — not a follow-up.
  const isFullBuildDescription = newPrompt.length > 200 &&
    /\b(build|create|make|generate|set up|design)\b.{0,40}\b(backend|platform|app|saas|ecommerce|api|service)\b/i.test(lowerPrompt)
  if (isFullBuildDescription) return false

  // Require a clear expansion/continuation signal.
  // This prevents coincidental short prompts ("fix auth") from being treated as extensions.
  const isExpansion = /\b(also add|also include|and add|plus add|extend with|add to this|add more|additionally|i also need|now add|can you also|i want to add|and also|add a|add an|add the)\b/.test(lowerPrompt)
  if (!isExpansion) return false

  // At this point we have a clear expansion signal — allow continuation for both
  // partial and verified builds. The build runtime will merge nodes into the existing job.
  return true
}

// ── BuildJob Validation ───────────────────────────────────────────────────────

/** Generic/fallback table names that indicate a failed entity extraction. */
const GENERIC_TABLE_NAMES = new Set(['items', 'entities', 'objects', 'records', 'data', 'things', 'stuff'])

/**
 * Validate a compiled BuildJob before execution starts.
 *
 * Returns an error message (string) when:
 *  1. The job has no schema nodes at all.
 *  2. Every schema node is a known generic fallback ('items', 'entities', etc.)
 *     AND the original prompt contains explicit entity names.
 *
 * Returns null when the job looks valid.
 */
function validateBuildJobEntities(job: BuildJob, originalPrompt: string): string | null {
  const allNodes = job.phases.flatMap(p => p.nodes)
  const schemaNodes = allNodes.filter(n => n.type === 'schema')

  // No schema nodes at all
  if (schemaNodes.length === 0) {
    const explicit = extractExplicitEntityNamesFromPrompt(originalPrompt)
    if (explicit.length > 0) {
      return (
        `Build request references explicit entities (${explicit.slice(0, 4).join(', ')}${explicit.length > 4 ? '…' : ''}) ` +
        `but entity extraction produced no schema nodes. Please re-describe what you want to build.`
      )
    }
    return null // vague prompt, no entities expected
  }

  // All schema nodes are generic fallbacks
  const tableNames = schemaNodes.map(n => n.id.replace(/^schema\./, ''))
  const allGeneric = tableNames.every(t => GENERIC_TABLE_NAMES.has(t))
  if (allGeneric) {
    const explicit = extractExplicitEntityNamesFromPrompt(originalPrompt)
    if (explicit.length > 0) {
      return (
        `Your request explicitly names ${explicit.slice(0, 6).join(', ')} but entity extraction ` +
        `fell back to generic placeholder table(s) (${tableNames.join(', ')}). ` +
        `This would create the wrong backend. Please confirm your entity list and try again.`
      )
    }
  }

  return null // valid
}

/**
 * Fast keyword scan to check if a prompt contains explicit entity names.
 * Used only for the validation gate — not for full extraction.
 */
function extractExplicitEntityNamesFromPrompt(prompt: string): string[] {
  const fromList = extractEntitiesFromExplicitList(prompt)
  if (fromList.length > 0) return fromList

  const lower = prompt.toLowerCase()
  const found: string[] = []
  if (/\busers?\b/.test(lower)) found.push('users')
  if (/\bstores?\b/.test(lower)) found.push('stores')
  if (/\bproducts?\b/.test(lower)) found.push('products')
  if (/\borders?\b/.test(lower)) found.push('orders')
  if (/\breviews?\b/.test(lower)) found.push('reviews')
  if (/\bposts?\b/.test(lower)) found.push('posts')
  if (/\bcomments?\b/.test(lower)) found.push('comments')
  if (/\bmessages?\b/.test(lower)) found.push('messages')
  if (/\btasks?\b/.test(lower)) found.push('tasks')
  if (/\bpayments?\b/.test(lower)) found.push('payments')
  return found
}

// ── Mode detection ────────────────────────────────────────────────────────────

/**
 * Determine if the current request should use Plan mode or Build mode.
 * Plan mode = non-mutating preview.
 * Build mode = execute immediately.
 */
export function detectBuildMode(message: string, clientMode?: string): 'plan' | 'build' {
  // Client can explicitly set mode
  if (clientMode === 'plan') return 'plan'
  if (clientMode === 'build') return 'build'

  const lower = message.toLowerCase()

  // Explicit plan requests
  if (/\b(plan|propose|design|architect|what would|show me the architecture|outline|sketch)\b/.test(lower)) {
    return 'plan'
  }

  // "What would a ... backend look like" → plan
  if (/what (would|does|should) .* (look like|need|require|include)/.test(lower)) {
    return 'plan'
  }

  // Default: build
  return 'build'
}
