/**
 * AUTONOMY CIRCUIT BREAKER — the hard ceiling that stops a runaway loop
 * ====================================================================
 *
 * Every serious autonomous system (Google SRE, Kubernetes controllers, AWS
 * DevOps Guru) has exactly one non-negotiable safety primitive: a bound on how
 * many autonomous actions it may take per subject per window. Without it, one
 * bad detector or a flapping invariant can drive an unbounded mutation storm
 * against real user data. Backenly had per-scan caps but NO cross-path,
 * per-project, rolling-window ceiling. This is that ceiling.
 *
 * Design:
 *   • Backed by the existing AuditLog (already indexed by projectId+timestamp+
 *     type) — no new table, no schema change, durable across restarts.
 *   • Counts only AUTONOMOUS mutation audit rows (human-approved fixes are a
 *     human action and are deliberately NOT counted).
 *   • FAILS CLOSED: if the count cannot be read, the action is denied. The
 *     degradation is "escalate to human approval" — non-destructive by design.
 *     This is the one subsystem where a mistake is irreversible, so the safe
 *     default is to do less, not more.
 *
 * This module never mutates project data. It only counts and decides.
 */

import { prisma } from '@/lib/db/prisma'

// ── Configuration (env-overridable without a deploy) ──────────────────────────

/** Env fallback when the plan can't be resolved. */
function envMaxActions(): number {
  const v = Number(process.env.AUTONOMY_MAX_ACTIONS_PER_WINDOW)
  return Number.isFinite(v) && v > 0 ? v : 10
}

/**
 * Max autonomous mutations per project per rolling window — Plan-driven
 * (Free 3 / Pro 20 / Enterprise 50), falling back to the env default if the
 * owner's plan can't be resolved. Config-resolution failure falls back
 * (it is not the ledger read — that still fails closed below).
 */
async function maxActionsForProject(projectId: string): Promise<number> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return envMaxActions()
    const sub = await prisma.subscription.findFirst({
      where: { userId: project.userId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
      include: { plan: { select: { autonomyMaxActionsPerWindow: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const planMax = sub?.plan?.autonomyMaxActionsPerWindow
    return typeof planMax === 'number' && planMax > 0 ? planMax : envMaxActions()
  } catch {
    return envMaxActions()
  }
}

/** Rolling window length in minutes. */
function windowMinutes(): number {
  const v = Number(process.env.AUTONOMY_WINDOW_MIN)
  return Number.isFinite(v) && v > 0 ? v : 60
}

/**
 * AuditLog.action values that count as an autonomous, project-data-mutating
 * action. Every autonomous execute path MUST record one of these on success
 * (see recordAutonomousAction) so the breaker has a single, consistent ledger.
 *
 * Human-approved fixes (HEALTH_FIX approved via the dashboard) are intentionally
 * absent — a human pressing "Fix" is not the loop acting on its own.
 */
export const AUTONOMOUS_AUDIT_ACTIONS = [
  'HEALTH_AUTO_FIXED',          // auto-fix-engine._executeAutoFix
  'FIX_PLAN_AUTO_EXECUTED',     // auto-fix-engine.runFixPlan
  'AGENT_AUTO_FIXED',           // agent-orchestrator.executeAutoFixes
] as const

export interface BreakerDecision {
  /** True when another autonomous action is permitted in this window. */
  allowed: boolean
  /** Actions already taken in the current window. */
  used: number
  /** Actions still permitted in the current window (0 when tripped). */
  remaining: number
  /** Window length used for this decision, in minutes. */
  windowMinutes: number
  /** Human-readable reason when not allowed (for audit + escalation message). */
  reason?: string
}

/**
 * Decide whether one more autonomous mutation may run for this project right
 * now. Call this immediately BEFORE every autonomous action. Read-only.
 *
 * Fails closed: any error reading the ledger denies the action.
 */
export async function checkBreaker(projectId: string): Promise<BreakerDecision> {
  const max = await maxActionsForProject(projectId)
  const win = windowMinutes()
  const since = new Date(Date.now() - win * 60 * 1000)

  let used: number
  try {
    used = await prisma.auditLog.count({
      where: {
        projectId,
        timestamp: { gte: since },
        action: { in: AUTONOMOUS_AUDIT_ACTIONS as unknown as string[] },
      },
    })
  } catch (err: any) {
    return {
      allowed: false,
      used: max,
      remaining: 0,
      windowMinutes: win,
      reason: `autonomy circuit breaker failed safe (ledger unreadable: ${err?.message ?? 'unknown error'})`,
    }
  }

  if (used >= max) {
    return {
      allowed: false,
      used,
      remaining: 0,
      windowMinutes: win,
      reason: `autonomy circuit breaker open: ${used}/${max} autonomous actions already taken in the last ${win} min for this project`,
    }
  }

  return { allowed: true, used, remaining: max - used, windowMinutes: win }
}

/**
 * Record a successful autonomous mutation into the breaker's ledger.
 *
 * Paths that already write a recognised AUTONOMOUS_AUDIT_ACTIONS row on success
 * (auto-fix-engine) do NOT need to call this — their existing audit write is
 * the ledger entry. Paths that previously wrote nothing (agent-orchestrator)
 * call this so every autonomous action is counted consistently.
 */
export async function recordAutonomousAction(
  projectId: string,
  action: (typeof AUTONOMOUS_AUDIT_ACTIONS)[number],
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        projectId,
        action,
        type: 'autonomy',
        details: JSON.stringify(payload),
        timestamp: new Date(),
      },
    })
  } catch (err: any) {
    // Non-fatal: a missed ledger write only makes the breaker slightly more
    // permissive for one window — it never causes an extra mutation directly.
    console.warn(`[CircuitBreaker] Failed to record autonomous action for ${projectId}:`, err?.message)
  }
}

/**
 * Audit the moment the breaker trips, at most once per window, so the trip is
 * observable in the trust UI without spamming the log on every blocked action.
 */
export async function auditBreakerTrip(projectId: string, reason: string): Promise<void> {
  try {
    const win = windowMinutes()
    const since = new Date(Date.now() - win * 60 * 1000)
    const alreadyLogged = await prisma.auditLog.count({
      where: { projectId, action: 'AUTONOMY_CIRCUIT_OPEN', timestamp: { gte: since } },
    })
    if (alreadyLogged > 0) return
    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'AUTONOMY_CIRCUIT_OPEN',
        type: 'autonomy',
        details: JSON.stringify({ reason, at: new Date().toISOString() }),
        timestamp: new Date(),
      },
    })
  } catch {
    /* observability only — never block on this */
  }
}
