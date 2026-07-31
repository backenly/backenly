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

/**
 * Env fallback when the plan can't be resolved. `null` = unlimited, which is
 * also the default: healing is not metered on any plan, so an unresolvable
 * plan must not invent a ceiling that silently stops a backend repairing itself.
 */
function envMaxActions(): number | null {
  const raw = process.env.AUTONOMY_MAX_ACTIONS_PER_WINDOW
  if (raw === undefined || raw === '') return null
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Max autonomous mutations per project per rolling window.
 *
 * `null` means UNLIMITED and is the norm — every plan (Free included) heals
 * every minute without a per-window fix cap. A finite value only exists as an
 * ops escape hatch (AUTONOMY_MAX_ACTIONS_PER_WINDOW, or a per-plan override)
 * for pinning a project during an incident.
 *
 * Config-resolution failure falls back to unlimited. That is deliberate: the
 * ledger read below still fails closed, so a genuine storm is bounded by the
 * absolute ceiling — but a flaky plan lookup must never quietly stop healing.
 */
async function maxActionsForProject(projectId: string): Promise<number | null> {
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

/**
 * Absolute anti-storm ceiling, independent of plan and never a pricing lever.
 *
 * Unlimited healing means no user ever hits a fix cap in normal operation. It
 * does NOT mean a flapping detector may rewrite a project forever: a probe that
 * "fixes" the same gap every minute would otherwise mutate real user data
 * unboundedly. This ceiling exists only to catch that pathology, so it is set
 * far above any legitimate workload — a project needing 500 autonomous repairs
 * in an hour is broken, not busy.
 */
function stormCeiling(): number {
  const v = Number(process.env.AUTONOMY_STORM_CEILING)
  return Number.isFinite(v) && v > 0 ? v : 500
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
  /**
   * True when this project has no per-window fix cap — the normal state on
   * every plan. Callers must treat `remaining` as advisory when this is set:
   * it reports headroom to the anti-storm ceiling, not a budget to ration.
   */
  unlimited: boolean
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
  const planMax = await maxActionsForProject(projectId)
  const unlimited = planMax === null
  // Unlimited plans are still bounded by the anti-storm ceiling — a number no
  // real project reaches, so it never reads as a quota to the user.
  const max = planMax ?? stormCeiling()
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
      unlimited,
      used: max,
      remaining: 0,
      windowMinutes: win,
      reason: `autonomy circuit breaker failed safe (ledger unreadable: ${err?.message ?? 'unknown error'})`,
    }
  }

  if (used >= max) {
    return {
      allowed: false,
      unlimited,
      used,
      remaining: 0,
      windowMinutes: win,
      reason: unlimited
        ? `autonomy anti-storm ceiling reached: ${used} autonomous actions in the last ${win} min for this project — this indicates a flapping detector, not a plan limit`
        : `autonomy circuit breaker open: ${used}/${max} autonomous actions already taken in the last ${win} min for this project`,
    }
  }

  return { allowed: true, unlimited, used, remaining: max - used, windowMinutes: win }
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
