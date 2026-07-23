/**
 * ORCHESTRATION GOVERNOR
 * ======================
 * Prevents complexity explosion in the multi-agent system.
 *
 * Enforces:
 *  - Project-scoped locks      — no concurrent agent runs on the same project
 *  - Execution budgets         — max 3 orchestration runs per project per hour
 *  - Cooldown windows          — post-fix cooldown prevents cascade mutations
 *  - Conflict resolution       — migration wins over repair on same table; priority ordering
 *  - Auto-fix caps             — max 5 auto-fixes per scan, max 10 per project per day
 *
 * No LLM calls. Pure governance logic — must be fast.
 */

import { prisma } from '@/lib/db/prisma'
import type { AgentFinding } from './agents/types'

// ── Config ────────────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 5 * 60 * 1000          // 5 minutes — stale lock timeout
const MAX_RUNS_PER_HOUR = 3                  // per project
const MAX_AUTO_FIXES_PER_SCAN = 5
const MAX_AUTO_FIXES_PER_DAY = 10
const COOLDOWN_AFTER_FIX_MS = 15 * 60 * 1000   // 15 min after any auto-fix
const COOLDOWN_AFTER_MIGRATION_MS = 60 * 60 * 1000  // 1 hour after structural migration

// ── Agent priority (higher = wins conflicts) ──────────────────────────────────

const AGENT_PRIORITY: Record<string, number> = {
  migration: 10,
  security: 8,
  repair: 5,
  performance: 3,
  planner: 0,
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LockResult {
  acquired: boolean
  lockId?: string
  reason?: string
}

export interface BudgetResult {
  allowed: boolean
  remaining: number
  reason?: string
  autoFixCap: number
}

// ── Orchestration Governor class ──────────────────────────────────────────────

export class OrchestrationGovernor {
  constructor(private readonly projectId: string) {}

  // ── Lock management ─────────────────────────────────────────────────────────

  /**
   * Acquire a project-scoped execution lock.
   * Uses BackgroundJob as a distributed lock store.
   * Returns { acquired: false } if another run is active.
   */
  async acquireLock(): Promise<LockResult> {
    try {
      // Check for existing non-stale lock
      const existing = await prisma.backgroundJob.findFirst({
        where: {
          projectId: this.projectId,
          type: 'orchestration_lock',
          status: 'running',
          startedAt: { gte: new Date(Date.now() - LOCK_TTL_MS) },
        },
      })

      if (existing) {
        return {
          acquired: false,
          reason: `Agent orchestration already running for this project (started ${existing.startedAt?.toISOString()})`,
        }
      }

      // Create lock record
      const lock = await prisma.backgroundJob.create({
        data: {
          projectId: this.projectId,
          type: 'orchestration_lock',
          status: 'running',
          payload: { lockedAt: new Date().toISOString() },
          maxAttempts: 1,
          startedAt: new Date(),
          timeoutAt: new Date(Date.now() + LOCK_TTL_MS),
        },
      })

      return { acquired: true, lockId: lock.id }
    } catch {
      // If lock creation fails, allow execution (fail open — never block builds)
      return { acquired: true, lockId: 'bypass' }
    }
  }

  /** Release the project lock by completing the lock job. */
  async releaseLock(lockId: string): Promise<void> {
    if (lockId === 'bypass') return
    await prisma.backgroundJob.update({
      where: { id: lockId },
      data: { status: 'completed', completedAt: new Date() },
    }).catch(() => {})
  }

  // ── Budget enforcement ──────────────────────────────────────────────────────

  /**
   * Check whether this project is within hourly execution budget.
   * Also checks cooldown windows from recent auto-fixes.
   */
  async checkBudget(): Promise<BudgetResult> {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

      // Count orchestration runs this hour
      const runsThisHour = await prisma.executionLog.count({
        where: {
          projectId: this.projectId,
          intent: 'AGENT_ORCHESTRATION',
          createdAt: { gte: oneHourAgo },
        },
      })

      if (runsThisHour >= MAX_RUNS_PER_HOUR) {
        return {
          allowed: false,
          remaining: 0,
          autoFixCap: 0,
          reason: `Hourly budget exhausted (${runsThisHour}/${MAX_RUNS_PER_HOUR} runs). Resets in ${60 - new Date().getMinutes()} minutes.`,
        }
      }

      // Check cooldown from last fix
      const lastAction = await prisma.autonomousAction.findFirst({
        where: { projectId: this.projectId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, appliedFixes: true },
      })

      if (lastAction) {
        const fixes = lastAction.appliedFixes as string[]
        const hasMigration = fixes.some(f =>
          /migration|schema|column|table/i.test(f)
        )
        const cooldown = hasMigration ? COOLDOWN_AFTER_MIGRATION_MS : COOLDOWN_AFTER_FIX_MS
        const elapsed = Date.now() - lastAction.createdAt.getTime()

        if (elapsed < cooldown) {
          const remainingMin = Math.ceil((cooldown - elapsed) / 60000)
          return {
            allowed: false,
            remaining: MAX_RUNS_PER_HOUR - runsThisHour,
            autoFixCap: 0,
            reason: `Cooldown active — ${remainingMin} minute(s) remaining after last ${hasMigration ? 'migration' : 'fix'}.`,
          }
        }
      }

      // Check daily auto-fix cap
      const fixesToday = await prisma.autonomousAction.count({
        where: {
          projectId: this.projectId,
          createdAt: { gte: oneDayAgo },
        },
      })

      const autoFixCap = Math.max(0, MAX_AUTO_FIXES_PER_DAY - fixesToday * 2)

      return {
        allowed: true,
        remaining: MAX_RUNS_PER_HOUR - runsThisHour,
        autoFixCap: Math.min(autoFixCap, MAX_AUTO_FIXES_PER_SCAN),
      }
    } catch {
      // Fail open — governance failure never blocks builds
      return { allowed: true, remaining: MAX_RUNS_PER_HOUR, autoFixCap: MAX_AUTO_FIXES_PER_SCAN }
    }
  }

  /** Record an orchestration execution in the execution log. */
  async recordExecution(durationMs: number, findingCount: number): Promise<void> {
    await prisma.executionLog.create({
      data: {
        projectId: this.projectId,
        intent: 'AGENT_ORCHESTRATION',
        strategy: 'multi_agent_parallel',
        action: 'orchestrate',
        durationMs,
        success: true,
        metadata: { findingCount, agentCount: 4 },
      },
    }).catch(() => {})
  }

  // ── Conflict resolution ─────────────────────────────────────────────────────

  /**
   * Resolve conflicts between agent findings targeting the same resource.
   *
   * Rules:
   *  1. Same table: keep highest-priority agent's finding, defer the rest
   *  2. Migration + repair on same table: migration wins
   *  3. Security finding always survives (never deferred)
   *
   * Returns the winning set of findings.
   */
  resolveConflicts(findings: AgentFinding[]): AgentFinding[] {
    // Security findings are never suppressed
    const security = findings.filter(f => f.agentType === 'security')
    const rest = findings.filter(f => f.agentType !== 'security')

    // Group non-security findings by location
    const byLocation = new Map<string, AgentFinding[]>()
    for (const f of rest) {
      const key = f.location
      if (!byLocation.has(key)) byLocation.set(key, [])
      byLocation.get(key)!.push(f)
    }

    const winners: AgentFinding[] = []
    const conflictLog: string[] = []

    for (const [location, group] of byLocation) {
      if (group.length === 1) {
        winners.push(group[0])
        continue
      }

      // Multiple agents targeting same location — pick highest priority
      const sorted = group.sort(
        (a, b) => (AGENT_PRIORITY[b.agentType] ?? 0) - (AGENT_PRIORITY[a.agentType] ?? 0)
      )
      winners.push(sorted[0])

      const deferred = sorted.slice(1)
      if (deferred.length > 0) {
        conflictLog.push(
          `[Governor] Conflict on "${location}": ${sorted[0].agentType} wins over ${deferred.map(d => d.agentType).join(', ')}`
        )
      }
    }

    if (conflictLog.length > 0) {
      console.log(conflictLog.join('\n'))
    }

    return [...security, ...winners]
  }

  /** Cap auto-fixable findings to the budget limit. */
  capAutoFixes(findings: AgentFinding[], cap: number): AgentFinding[] {
    let autoFixCount = 0
    return findings.map(f => {
      if (!f.fix || f.fix.requiresApproval) return f
      if (autoFixCount >= cap) {
        // Demote to requires-approval when over cap
        return { ...f, fix: { ...f.fix, requiresApproval: true } }
      }
      autoFixCount++
      return f
    })
  }
}
