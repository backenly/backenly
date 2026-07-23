/**
 * AGENT ORCHESTRATOR
 * ==================
 * Runs all specialized agents in parallel, synthesizes results via the planner agent.
 * Replaces the single-LLM-chain approach with true multi-agent specialization.
 *
 * Pipeline:
 *   1. Load tables + schema context
 *   2. Run security / performance / migration / repair agents in Promise.all
 *   3. Deduplicate findings (same table + category = same issue)
 *   4. Run planner agent to phase and brief results
 *   5. Return unified OrchestratorResult + PlannerOutput
 */

import { runSecurityAgent } from './agents/security-agent'
import { runPerformanceAgent } from './agents/performance-agent'
import { runMigrationAgent } from './agents/migration-agent'
import { runRepairAgent } from './agents/repair-agent'
import { planAgentResults } from './agents/planner-agent'
import { OrchestrationGovernor } from './orchestration-governor'
import { emitTrace } from './execution-tracer'
import { shouldSkipLLM, schemaFingerprint, getCachedResult, setCachedResult, recordLLMUsage } from './cost-governor'
import type { AgentInput, AgentFinding, AgentResult, OrchestratorResult } from './agents/types'
import type { PlannerOutput } from './agents/types'

export type { OrchestratorResult, PlannerOutput }

export interface FullOrchestrationResult {
  orchestrator: OrchestratorResult
  plan: PlannerOutput
  governanceInfo?: {
    budgetRemaining: number
    autoFixCap: number
    conflictsResolved: number
    llmSkipped: boolean
    cacheHit: boolean
  }
}

// ── Severity weight for sorting / dedup priority ──────────────────────────────

const SEV_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run all agents in parallel for a project, then synthesize via planner agent.
 * Never throws — errors from individual agents are isolated.
 *
 * @param projectId   The project to analyze
 * @param schemaCtx   Optional DDL snippet (passed to LLM agents for richer context)
 */
export async function runAllAgents(
  projectId: string,
  schemaCtx?: string,
): Promise<FullOrchestrationResult> {
  const start = Date.now()
  const governor = new OrchestrationGovernor(projectId)

  // ── Governance: acquire lock + check budget ────────────────────────────────
  const lock = await governor.acquireLock()
  if (!lock.acquired) {
    await emitTrace(projectId, { type: 'lock_contention', skipReason: lock.reason, skipped: true })
    return makeEmptyResult(projectId, lock.reason ?? 'lock contention')
  }

  const tables = await loadTableNames(projectId)
  const budget = await governor.checkBudget()

  if (!budget.allowed) {
    await governor.releaseLock(lock.lockId!)
    await emitTrace(projectId, { type: 'budget_exceeded', skipReason: budget.reason, skipped: true })
    return makeEmptyResult(projectId, budget.reason ?? 'budget exceeded')
  }

  await emitTrace(projectId, { type: 'orchestration_start', details: { tables: tables.length } })

  try {
    // ── Cache check — skip full run if schema unchanged ──────────────────────
    const fingerprint = schemaFingerprint(tables)
    const cacheKey = `${projectId}:orchestration:${fingerprint}`
    const cached = getCachedResult<FullOrchestrationResult>(cacheKey)
    if (cached) {
      console.log(`[AgentOrchestrator] Cache hit for project ${projectId}`)
      return { ...cached, governanceInfo: { ...(cached.governanceInfo ?? {} as any), cacheHit: true } }
    }

    // ── Cost: decide whether LLM agents can run ──────────────────────────────
    const llmSkipped = await shouldSkipLLM(projectId, tables)
    if (llmSkipped) {
      console.log(`[AgentOrchestrator] LLM skipped for project ${projectId} (budget or size threshold)`)
    }

    // ── Build shared input ───────────────────────────────────────────────────
    const input: AgentInput = {
      projectId,
      tables,
      schemaContext: schemaCtx,
    }

    // ── Run 4 specialist agents in parallel ──────────────────────────────────
    const [secResult, perfResult, migResult, repResult] = await Promise.all([
      safeRun('security', () => runSecurityAgent(input)),
      safeRun('performance', () => runPerformanceAgent(input)),
      safeRun('migration', () => runMigrationAgent(input)),
      safeRun('repair', () => runRepairAgent(input)),
    ])

    const agentResults: AgentResult[] = [secResult, perfResult, migResult, repResult]

    // Emit per-agent traces
    for (const r of agentResults) {
      await emitTrace(projectId, {
        type: 'agent_run',
        agentType: r.agentType,
        durationMs: r.durationMs,
        findingsCount: r.findings.length,
        autoFixedCount: r.autoFixed.length,
        skipped: r.skipped,
      })

      // Record LLM usage estimate (rough: ~500 tokens per LLM agent run)
      if (!r.skipped && !llmSkipped) {
        recordLLMUsage(projectId, 500).catch(() => {})
      }
    }

    // ── Collect + deduplicate findings ───────────────────────────────────────
    const allFindings = agentResults.flatMap(r => r.findings)
    const deduped = deduplicateFindings(allFindings)

    // ── Conflict resolution via governor ─────────────────────────────────────
    const resolved = governor.resolveConflicts(deduped)
    const conflictsResolved = deduped.length - resolved.length

    // ── Auto-fix cap enforcement ──────────────────────────────────────────────
    const capped = governor.capAutoFixes(resolved, budget.autoFixCap)

    // ── Build orchestrator result ─────────────────────────────────────────────
    const autoFixedCount = agentResults.reduce((s, r) => s + r.autoFixed.length, 0)
    const pendingApproval = capped.filter(f => f.fix?.requiresApproval).length

    const topFindings = [...capped]
      .sort((a, b) => (SEV_WEIGHT[b.severity] ?? 0) - (SEV_WEIGHT[a.severity] ?? 0))
      .slice(0, 5)

    const orchestrator: OrchestratorResult = {
      projectId,
      ranAt: new Date().toISOString(),
      totalFindings: capped.length,
      criticalCount: capped.filter(f => f.severity === 'critical').length,
      autoFixedCount,
      pendingApprovalCount: pendingApproval,
      agentResults,
      topFindings,
    }

    // ── Run planner to synthesize phases + CTO brief ──────────────────────────
    const plan = await planAgentResults(input, capped)

    const durationMs = Date.now() - start
    const governanceInfo = {
      budgetRemaining: budget.remaining,
      autoFixCap: budget.autoFixCap,
      conflictsResolved,
      llmSkipped,
      cacheHit: false,
    }

    await governor.recordExecution(durationMs, capped.length)
    await emitTrace(projectId, {
      type: 'orchestration_complete',
      durationMs,
      findingsCount: capped.length,
      autoFixedCount,
      conflictsResolved,
    })

    console.log(
      `[AgentOrchestrator] Done in ${durationMs}ms: ${capped.length} findings ` +
      `(${orchestrator.criticalCount} critical, ${autoFixedCount} auto-fixed, ` +
      `${pendingApproval} pending, ${conflictsResolved} conflicts resolved).`,
    )

    const result: FullOrchestrationResult = { orchestrator, plan, governanceInfo }

    // Cache result for 1 hour (schema fingerprint keyed)
    setCachedResult(cacheKey, result)

    return result
  } finally {
    await governor.releaseLock(lock.lockId!)
  }
}

// ── Auto-fix execution ────────────────────────────────────────────────────────

/**
 * Execute all Phase 1 (auto-fixable) findings from a plan.
 * Uses raw SQL for index creation, executor actions for API/trigger generation.
 * Returns list of applied fix titles.
 */
export async function executeAutoFixes(
  projectId: string,
  plan: PlannerOutput,
): Promise<string[]> {
  const phase1 = plan.executionPlan.find(p => p.canAutoRun)
  if (!phase1 || phase1.actions.length === 0) return []

  const { checkBreaker, auditBreakerTrip, recordAutonomousAction } = await import(
    '@/lib/autonomy/circuit-breaker'
  )

  const applied: string[] = []

  for (const finding of phase1.actions) {
    if (!finding.fix) continue

    // Autonomy circuit breaker — re-checked per action so a long auto-fix
    // batch cannot blow past the per-project/window ceiling. When tripped we
    // stop here; the remaining findings stay open for the observer / approval
    // path (safe degradation, never a silent drop).
    const breaker = await checkBreaker(projectId)
    if (!breaker.allowed) {
      await auditBreakerTrip(projectId, breaker.reason ?? 'circuit open')
      console.warn(
        `[AgentOrchestrator] Circuit breaker open for ${projectId} — ` +
        `stopping auto-fix batch after ${applied.length} applied. ${breaker.reason ?? ''}`,
      )
      break
    }

    try {
      let didApply = false
      if (finding.fix.sql) {
        // Execute raw SQL (index creation, RLS additions)
        const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
        const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
        const { Pool } = await import('pg')
        const pool = new Pool({ connectionString: process.env.DATABASE_URL })
        try {
          // Replace any placeholder schema references
          const sql = finding.fix.sql.replace(/\{schema\}/g, postgresSchema)
          await pool.query(sql)
          applied.push(finding.title)
          didApply = true
        } finally {
          await pool.end()
        }
      } else if (finding.fix.executorAction) {
        // Route through AI executor
        const { executeAction } = await import('./minimal-executor')
        const result = await executeAction(
          {
            action: finding.fix.executorAction as any,
            params: finding.fix.executorParams ?? {},
          },
          projectId,
        )
        if (result.success) {
          applied.push(finding.title)
          didApply = true
        }
      }

      // Record into the breaker ledger so this path is counted consistently
      // with the auto-fix-engine paths (it previously wrote no audit at all).
      if (didApply) {
        await recordAutonomousAction(projectId, 'AGENT_AUTO_FIXED', {
          title: finding.title,
          category: finding.category,
          location: finding.location,
          via: finding.fix.sql ? 'sql' : 'executor',
        })
      }
    } catch (err: any) {
      console.warn(`[AgentOrchestrator] Auto-fix failed for "${finding.title}":`, err?.message)
    }
  }

  return applied
}

// ── Table loader ──────────────────────────────────────────────────────────────

async function loadTableNames(projectId: string): Promise<string[]> {
  try {
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      const rows = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [postgresSchema],
      )
      return rows.rows.map(r => r.table_name)
    } finally {
      await pool.end()
    }
  } catch {
    return []
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateFindings(findings: AgentFinding[]): AgentFinding[] {
  const seen = new Map<string, AgentFinding>()

  for (const f of findings) {
    const key = `${f.category}:${f.location}`
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, f)
    } else {
      // Keep higher severity
      if ((SEV_WEIGHT[f.severity] ?? 0) > (SEV_WEIGHT[existing.severity] ?? 0)) {
        seen.set(key, f)
      }
    }
  }

  return [...seen.values()]
}

// ── Empty result (returned when governance blocks execution) ──────────────────

function makeEmptyResult(projectId: string, reason: string): FullOrchestrationResult {
  const emptyPlan: PlannerOutput = {
    executionPlan: [],
    ctoBrief: `Scan skipped: ${reason}`,
    estimatedFixTime: 'N/A',
  }
  return {
    orchestrator: {
      projectId,
      ranAt: new Date().toISOString(),
      totalFindings: 0,
      criticalCount: 0,
      autoFixedCount: 0,
      pendingApprovalCount: 0,
      agentResults: [],
      topFindings: [],
    },
    plan: emptyPlan,
    governanceInfo: {
      budgetRemaining: 0,
      autoFixCap: 0,
      conflictsResolved: 0,
      llmSkipped: true,
      cacheHit: false,
    },
  }
}

// ── Safe runner ───────────────────────────────────────────────────────────────

async function safeRun(
  agentType: string,
  fn: () => Promise<AgentResult>,
): Promise<AgentResult> {
  const start = Date.now()
  try {
    return await fn()
  } catch (err: any) {
    console.warn(`[AgentOrchestrator] Agent "${agentType}" failed:`, err?.message)
    return {
      agentType: agentType as any,
      durationMs: Date.now() - start,
      findings: [],
      autoFixed: [],
      skipped: true,
    }
  }
}
