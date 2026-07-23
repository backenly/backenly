/**
 * BACKGROUND MONITOR — Autonomous Backend Lifecycle Loop
 * =======================================================
 * Extends the existing background-health system with full multi-agent orchestration.
 *
 * Flow per project:
 *   1. Run all agents in parallel (security, performance, migration, repair)
 *   2. Execute auto-fixable Phase 1 findings immediately (no user action needed)
 *   3. Store Phase 2 (pending approval) findings as HealthFindings
 *   4. Write AutonomousAction notification for "while you were away" banner
 *   5. Trigger evolution update for the long-horizon orchestrator
 *
 * Called by:
 *   - app/api/cron/background-health/route.ts (every 15 minutes for active projects)
 *   - Directly after significant builds (optional fast-path)
 *
 * Never throws. One project failure never blocks others.
 */

import { prisma } from '@/lib/db/prisma'
import { runAllAgents, executeAutoFixes } from './agent-orchestrator'
import { runReconciler, computeReconciliationPlan } from '@/lib/autonomy/reconciler'
import { getUserSubscription } from '@/lib/billing'
import type { AgentFinding } from './agents/types'

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Full autonomous health scan using multi-agent orchestration.
 * Drop-in replacement for the older `runAutonomousHealthScan` from background-agent.ts.
 *
 * Differences from legacy:
 *  - Runs 4 specialized agents in parallel (vs 1 monolithic scan)
 *  - Security, performance, migration, repair each have focused prompts
 *  - Auto-fixes go through the same `executeAutoFixes` path (SQL or executor)
 *  - HealthFindings stored for pending-approval items (queryable from API)
 *  - PlannerAgent generates CTO brief (surfaced in notification)
 */
export async function runMonitoredHealthScan(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    // ── Plan-driven cadence + monthly budget gate ──────────────────────────
    // Autonomy is the headline promise ("describe it once, we keep it healthy
    // forever") and the platform funds the AI for it on paid tiers. The two
    // levers that bound that cost are now Plan-driven, not single global envs:
    //
    //   • autonomyScanIntervalMin   — how often the expensive multi-agent scan
    //     may run (Free 24h, Pro/Enterprise 30m).
    //   • autonomyMonthlyScanBudget — a hard monthly cap on expensive scans
    //     (Free ~30; paid = null = unlimited / fair-use).
    //
    // When a bounded (Free) project exhausts its monthly budget it does NOT go
    // silent and does NOT keep spending: it degrades to cheap detect-only and
    // surfaces a single "issues found — upgrade to auto-repair" prompt. The
    // limit itself becomes the conversion lever.
    const ownerPlan = (await getUserSubscription(userId).catch(() => null))?.plan ?? null
    const intervalMin =
      ownerPlan?.autonomyScanIntervalMin ??
      (Number(process.env.AUTONOMY_SCAN_INTERVAL_MIN) || 60)
    const lastScan = await prisma.autonomousAction.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }).catch(() => null)

    const nextScanDue = new Date(Date.now() - intervalMin * 60 * 1000)
    if (lastScan && lastScan.createdAt > nextScanDue) return

    // Monthly budget enforcement (only for bounded plans — paid plans have a
    // null budget = unlimited within their cadence).
    const monthlyBudget = ownerPlan?.autonomyMonthlyScanBudget ?? null
    if (monthlyBudget !== null) {
      const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z')
      const consumed = await prisma.auditLog.count({
        where: { projectId, action: 'AUTONOMY_SCAN_CONSUMED', timestamp: { gte: monthStart } },
      }).catch(() => 0)

      if (consumed >= monthlyBudget) {
        await runDetectOnlyWithUpgradePrompt(projectId, userId).catch(() => {})
        return
      }

      // Budget available — record one expensive scan against the month.
      await prisma.auditLog.create({
        data: {
          projectId,
          action: 'AUTONOMY_SCAN_CONSUMED',
          type: 'autonomy',
          details: JSON.stringify({ month: monthStart.toISOString().slice(0, 7), plan: ownerPlan?.name }),
          timestamp: new Date(),
        },
      }).catch(() => {})
    }

    // ── Run all agents ─────────────────────────────────────────────────────
    const { orchestrator, plan } = await runAllAgents(projectId)

    // ── Reap stale performance findings ────────────────────────────────────
    // Delegated to the shared kernel (lib/core/finding-reaper) with this run's
    // RAW detection set (pre-dedup, pre-budget-cap) so capping can never close
    // a real finding; skipped entirely when the agent itself skipped or
    // errored — silence must never reap real findings.
    try {
      const perfRun = orchestrator.agentResults.find(r => r.agentType === 'performance')
      if (perfRun && !perfRun.skipped) {
        const { reapPerformanceFindings } = await import('@/lib/core/finding-reaper')
        await reapPerformanceFindings(
          projectId,
          new Set(perfRun.findings.map(f => `${f.category}_${f.location}`)),
        )
      }
    } catch { /* best-effort — a failed cleanup must never fail the scan */ }

    // Same withdrawal for the migration agent's findings (missing_table,
    // missing_column, type_mismatch, extra_table, extra_column) — a dropped
    // table (e.g. left behind by a load-test/fuzz run) otherwise sits as an
    // open finding forever: nothing in the classifier/reconciler recognizes
    // its dynamic type, so it can never be auto-fixed, escalated, or cleared.
    //
    // Deliberately does NOT reuse migRun.findings/migRun.skipped the way the
    // performance reap above reuses perfRun: migration-agent.ts's `skipped`
    // is true both when the scan is genuinely clean (0 drifts) AND when
    // detectSchemaDrift silently swallowed an internal error into the same
    // empty shape — the two are indistinguishable at the AgentResult level.
    // reapMigrationFindings() re-runs the (cheap, deterministic, LLM-free)
    // drift check itself and only trusts it when `snapshotVersion` proves the
    // compare actually happened, so it is the one call site with that signal.
    try {
      const migRun = orchestrator.agentResults.find(r => r.agentType === 'migration')
      if (migRun) {
        const { reapMigrationFindings } = await import('@/lib/core/finding-reaper')
        await reapMigrationFindings(projectId)
      }
    } catch { /* best-effort — a failed cleanup must never fail the scan */ }

    // The legacy agent scan finding nothing must NOT skip the reconciler — the
    // reconciler is an independent MAPE-K loop with its own desired-state probe
    // and routinely catches invariant violations the agents do not. So the
    // agent-fix block is now conditional; the reconciler always runs below.
    const agentHasWork =
      !(orchestrator.totalFindings === 0 && orchestrator.autoFixedCount === 0)

    if (agentHasWork) {
      // ── Auto-fix Phase 1 findings ────────────────────────────────────────
      const applied = await executeAutoFixes(projectId, plan)

      // ── Store Phase 2 findings in HealthFinding table ────────────────────
      const phase2 = plan.executionPlan.find(p => !p.canAutoRun && p.name.includes('Approval'))
      if (phase2 && phase2.actions.length > 0) {
        await storeHealthFindings(projectId, phase2.actions)
      }

      // ── Surface "while you were away" notification ───────────────────────
      const pendingReviewCount = plan.executionPlan
        .filter(p => !p.canAutoRun)
        .reduce((s, p) => s + p.actions.length, 0)

      if (applied.length > 0 || pendingReviewCount > 0) {
        await saveMonitorNotification(projectId, userId, applied, pendingReviewCount, plan.ctoBrief)
      }

      console.log(
        `[BackgroundMonitor] Project ${projectId}: ` +
        `${applied.length} auto-fixed, ${pendingReviewCount} pending approval. ` +
        `Brief: "${plan.ctoBrief.slice(0, 80)}…"`,
      )
    } else {
      console.log(`[BackgroundMonitor] Project ${projectId}: no agent issues — running reconciler loop`)
    }

    // ── Closed-loop reconciler — ALWAYS runs once the cadence gate passes ───
    // Independent of the legacy agent scan (it does its own desired-state
    // probing). Runs after agent fixes settle so it sees post-fix live state
    // and never double-acts. Master switch FLAGS.ENABLE_AUTONOMY_RECONCILER is
    // checked inside the dispatcher. Per project: dial OFF ⇒ shadow (observe +
    // record); any other level ⇒ live execution, bounded by tier + circuit
    // breaker + incident change-freeze, reusing the auto-fix kernel. Safe.
    await runReconciler(projectId)
  } catch (err: any) {
    console.warn(`[BackgroundMonitor] Scan failed for ${projectId}:`, err?.message)
  }
}

// ── Free detect-only fallback (the conversion lever) ──────────────────────────
//
// When a bounded plan has spent its monthly autonomy budget we still WATCH the
// backend — using only the cheap, deterministic desired-state probe (no LLM
// agents, no auto-repair) — and tell the owner what we found and that upgrading
// lets Backenly fix it for them. This keeps the cost at ~zero while turning the
// limit into the strongest upgrade prompt: the user sees real problems being
// detected and hits the wall exactly where the value is (fixing them).
async function runDetectOnlyWithUpgradePrompt(
  projectId: string,
  userId: string,
): Promise<void> {
  const plan = await computeReconciliationPlan(projectId).catch(() => null)
  if (!plan) return

  const violations = plan.report.violations ?? []
  if (violations.length === 0) return

  // Persist findings so the dashboard "things to clear" view shows them,
  // deduped against anything already open.
  try {
    const existingOpen = await prisma.healthFinding.findMany({
      where: { projectId, status: { in: ['open', 'pending_approval'] } },
      select: { type: true },
    })
    const existingTypes = new Set(existingOpen.map((e) => e.type))
    const toCreate = violations.filter((v) => !existingTypes.has(v.type))
    if (toCreate.length > 0) {
      await prisma.healthFinding.createMany({
        data: toCreate.map((v) => ({
          projectId,
          type: v.type,
          severity: v.severity,
          details: v.details as any,
          status: 'open',
          autoFixed: false,
        })),
      })
    }
  } catch (err: any) {
    console.warn(`[BackgroundMonitor] detect-only finding persist failed for ${projectId}:`, err?.message)
  }

  // One upgrade prompt per 24h per user — never spam the cron's cadence.
  // PlatformNotification has no projectId column; projectId lives in metadata.
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recent = await prisma.platformNotification.count({
      where: { userId, type: 'autonomy_budget_reached', createdAt: { gte: dayAgo } },
    })
    if (recent === 0) {
      const n = violations.length
      await prisma.platformNotification.create({
        data: {
          userId,
          type: 'autonomy_budget_reached',
          title: `${n} issue${n === 1 ? '' : 's'} detected in your backend`,
          body:
            `Backenly found ${n} issue${n === 1 ? '' : 's'} that need attention. ` +
            `Your plan's monthly auto-repair is used up for this month — ` +
            `upgrade to let Backenly fix ${n === 1 ? 'it' : 'them'} automatically and keep your backend healthy continuously.`,
          read: false,
          metadata: JSON.parse(JSON.stringify({
            projectId,
            findings: n,
            reason: 'autonomy_monthly_budget_exhausted',
            cta: 'upgrade',
          })),
        },
      })
    }
  } catch (err: any) {
    console.warn(`[BackgroundMonitor] detect-only notification failed for ${projectId}:`, err?.message)
  }

  console.log(
    `[BackgroundMonitor] project=${projectId} detect-only — ${violations.length} issue(s) found, ` +
    `monthly autonomy budget exhausted, upgrade prompt surfaced`,
  )
}

// ── HealthFinding persistence ─────────────────────────────────────────────────

async function storeHealthFindings(
  projectId: string,
  findings: AgentFinding[],
): Promise<void> {
  try {
    // Deduplicate against every live status: 'open' alone duplicated any
    // finding that had moved to pending_approval, and ignoring 'dismissed'
    // re-nagged users who had explicitly dismissed one. Reaper-withdrawn rows
    // (details.withdrawnBy) are the one exception — those may be re-created
    // when the condition genuinely returns.
    const existingLive = await prisma.healthFinding.findMany({
      where: { projectId, status: { in: ['open', 'pending_approval', 'dismissed'] } },
      select: { type: true, status: true, details: true },
    })
    const existingTypes = new Set(
      existingLive
        .filter(e => !(
          e.status === 'dismissed' &&
          typeof (e.details as { withdrawnBy?: unknown } | null)?.withdrawnBy === 'string'
        ))
        .map(e => e.type),
    )

    const toCreate = findings.filter(f => {
      const key = `${f.category}_${f.location}`
      return !existingTypes.has(key)
    })

    if (toCreate.length === 0) return

    await prisma.healthFinding.createMany({
      data: toCreate.map(f => ({
        projectId,
        type: `${f.category}_${f.location}`,
        severity: mapSeverity(f.severity),
        details: {
          agentType: f.agentType,
          title: f.title,
          description: f.description,
          location: f.location,
          fix: f.fix ? {
            description: f.fix.description,
            sql: f.fix.sql,
            requiresApproval: f.fix.requiresApproval,
          } : null,
        },
        status: 'open',
        autoFixed: false,
      })),
    })
  } catch (err: any) {
    console.warn('[BackgroundMonitor] Failed to store health findings:', err?.message)
  }
}

// ── Notification persistence ──────────────────────────────────────────────────

async function saveMonitorNotification(
  projectId: string,
  userId: string,
  appliedFixes: string[],
  pendingCount: number,
  ctoBrief: string,
): Promise<void> {
  try {
    // Write AutonomousAction audit record (same model as legacy system)
    await prisma.autonomousAction.create({
      data: {
        projectId,
        appliedFixes: JSON.parse(JSON.stringify(appliedFixes)),
        pendingReview: JSON.parse(JSON.stringify(
          pendingCount > 0 ? [`${pendingCount} finding(s) require your review`] : []
        )),
        summary: ctoBrief.slice(0, 500),
        source: 'multi_agent_monitor',
      } as any,
    }).catch(() => {
      // autonomousAction shape may vary — log and continue
      console.warn('[BackgroundMonitor] AutonomousAction create failed (non-fatal)')
    })

    // Write PlatformNotification if significant
    if (appliedFixes.length > 0 || pendingCount > 0) {
      await prisma.platformNotification.create({
        data: {
          userId,
          projectId,
          type: 'autonomous_action',
          title: appliedFixes.length > 0
            ? `Auto-fixed ${appliedFixes.length} backend issue(s)`
            : `${pendingCount} backend issue(s) need your review`,
          body: ctoBrief.slice(0, 300),
          metadata: JSON.parse(JSON.stringify({
            appliedFixes,
            pendingCount,
            source: 'multi_agent_monitor',
          })),
          read: false,
        } as any,
      }).catch(() => {})
    }
  } catch (err: any) {
    console.warn('[BackgroundMonitor] Failed to save notification:', err?.message)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapSeverity(s: string): string {
  const map: Record<string, string> = { critical: 'critical', high: 'warning', medium: 'warning', low: 'info' }
  return map[s] ?? 'info'
}
