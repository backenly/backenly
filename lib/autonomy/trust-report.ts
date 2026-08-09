/**
 * TRUST REPORT — the data behind the autonomy trust UI
 * ====================================================
 *
 * "127 autonomous fixes · 0 rollbacks · 100% verified" is, per every funded
 * autonomous platform, the single most important trust element: it is the
 * track record that earns the right to raise the autonomy dial. This module
 * computes that scoreboard plus the activity feed, approval inbox, and the
 * latest shadow-mode decision — all from the existing audit ledger.
 *
 * Read-only. No mutation. Every aggregate is derived from durable AuditLog /
 * HealthFinding rows so the numbers survive restarts and match the real
 * autonomous history exactly.
 */

import { prisma } from '@/lib/db/prisma'
import { AUTONOMOUS_AUDIT_ACTIONS } from './circuit-breaker'
import {
  getProjectAutonomyLevel,
  getProjectAutonomyCap,
  getProjectPlanName,
  planDisplayName,
  type AutonomyLevel,
} from './autonomy-level'
import { explainAutonomyEvent } from './because-copy'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { classifyFix } from '@/lib/core/fix-classifier'
import { revertEligibility } from '@/lib/core/auto-fix-engine'
import { INVARIANTS } from './desired-state'

export interface TrustScoreboard {
  windowDays: number
  /** Autonomous fixes the loop applied on its own (all execute paths). */
  autonomousFixes: number
  /** Fixes the loop chose to escalate to a human instead of acting. */
  escalations: number
  /** Times the circuit breaker tripped (runaway protection fired). */
  breakerTrips: number
  /** Rollbacks of autonomous actions (the trust-critical "0" we want). */
  rollbacks: number
  /**
   * Share of autonomous fixes whose gap was re-probed after the fix and
   * confirmed gone, 0..1 (null if there were no fixes). NOT "share not rolled
   * back" — that number could never fall and so measured nothing.
   */
  verifiedRate: number | null
}

export interface ActivityItem {
  at: string
  action: string
  kind:
    | 'auto_fix'
    | 'applied'
    | 'escalation'
    | 'breaker'
    | 'rollback'
    | 'shadow'
    | 'failed'
    | 'other'
  summary: string
  /**
   * How many consecutive occurrences this row stands for (1 = just itself).
   *
   * The loop re-escalates a finding it may not fix on every tick, and the tick
   * is every minute on every plan — so one unresolved finding writes an audit
   * row every minute, indefinitely, until someone decides on it. Rendered
   * one-per-row that is a feed of the same sentence repeated down the page —
   * it reads as a system thrashing, when it is a system correctly refusing to
   * touch auth without permission. The count says "still this, N times" in one
   * line; `at` remains the MOST RECENT occurrence.
   */
  repeat: number
}

export interface PendingApproval {
  id: string
  type: string
  severity: string
  detectedAt: string
  reason: string
  /**
   * WHY this row is waiting on a human — computed server-side from what
   * actually happened, never guessed client-side from the finding type. The
   * old client guess printed "auth changes always require approval" for
   * findings the loop had actually TRIED to fix and escalated after failed
   * verification — making Autopilot read as if it gates safe fixes on
   * clicks, which is precisely the debug-agent impression we are not.
   */
  heldBecause: {
    kind: 'escalated' | 'recurrence' | 'guardrail' | 'held'
    text: string
  }
  /** Where this came from: an autonomy-detected issue vs. a risk-flagged AI change. */
  source: string
  /** Human-readable affected resource, e.g. a table/API/action name — for display only. */
  resource?: string
  /**
   * The finding's own details, passed through verbatim.
   *
   * The queue folds approvals by ROOT CAUSE (lib/core/finding-groups) so one
   * bad policy dialect across nine tables is one row with one "approve all",
   * not nine identical rows. That fold needs the cause discriminator — the
   * policy name, the probe error — which lives only in details. Sending just
   * the pre-rendered `reason` meant the client could see that nine sentences
   * differed by a table name but not whether they shared a cause.
   */
  details: Record<string, unknown>
}

/**
 * A change Backenly applied on its own, with whether it can still be undone.
 *
 * The product has told users on every autonomy surface that "every autonomous
 * action is snapshotted, reversible, and written to the audit log". Two thirds
 * of that was true: the snapshot and the ledger shipped, `revertAutoFix` was
 * written and tested, `DELETE /health/approve` was wired to it — and nothing in
 * the UI ever called it. The promise was accurate about the engine and false
 * about the product, which is the worst shape for a trust claim.
 *
 * `revertible` is computed from the SAME predicate the engine gates on, so a
 * row can never offer an undo the engine will refuse.
 */
export interface AppliedChange {
  findingId: string
  type: string
  severity: string
  /** When the fix was applied (falls back to detection time on legacy rows). */
  at: string
  /** "Backenly did X because Y" — the canonical sentence, same as the feed. */
  summary: string
  /** Table / column / surface the change landed on, for display only. */
  resource?: string
  /** True when the loop re-probed the gap afterwards and confirmed it closed. */
  verified: boolean
  revertible: boolean
  /** Undo removes protection (RLS) and needs an explicit second confirmation. */
  requiresConfirmation: boolean
  /** Why it cannot be undone automatically. Present only when !revertible. */
  revertBlockedReason?: string
}

export interface ShadowPreview {
  at: string
  level: string
  summary: string
  autoBudget: number
  counts: Record<string, number>
}

export interface TrustReport {
  projectId: string
  level: AutonomyLevel
  /**
   * The highest level this project's plan allows. The UI / chat clamp the
   * dial to this; raising the dial past it requires upgrading the plan.
   * Free → CONSERVATIVE, Pro & Enterprise → AGGRESSIVE (cadence is the diff).
   */
  cap: AutonomyLevel
  /**
   * The owner's current plan, as the user-facing label (Free / Pro / Enterprise).
   * The cap alone can't distinguish Pro from Enterprise — both cap at AGGRESSIVE —
   * so the UI reads this to label the plan pill and target the upgrade CTA.
   */
  plan: string
  /**
   * How many declarative invariants the loop continuously reconciles toward
   * (the K of MAPE-K). Surfaced under the Observe node of the dashboard's
   * self-healing loop so the number can never drift from the real catalogue.
   */
  invariantCount: number
  scoreboard: TrustScoreboard
  recentActivity: ActivityItem[]
  pendingApprovals: PendingApproval[]
  /** Changes the loop applied on its own, newest first, each with its undo state. */
  appliedChanges: AppliedChange[]
  /** What the closed loop would do right now (present only in shadow mode). */
  shadowPreview: ShadowPreview | null
}

const ROLLBACK_PREFIX = 'ROLLBACK_'

// Internal cadence/billing bookkeeping rows — written on every cron tick purely
// to gate scan frequency, never a "guardrail action" a user would recognize.
// Excluded from the activity feed so it doesn't fill up with "autonomy tick".
// Run-markers, not user-meaningful actions: a live run's per-tick bookkeeping
// (attempted/applied counts) is noise in the human feed — the individual
// HEALTH_AUTO_FIXED rows carry the real "what happened + why". Keeping the run
// marker out means the "last action" surfaces the actual fix, not "autonomy
// live run". The audit rows still exist for the breaker + precision analysis.
//
// HEALTH_FIX_DEFERRED belongs here for the same reason. auto-fix-engine writes
// it as, in its own words, "a low-noise audit row for observability" — the loop
// deciding to retry a finding on the next tick. It changes nothing, asks
// nothing, and leaves the finding exactly where it was. But it was missing from
// this list, so it fell through humanize()'s default branch and printed to
// users as the bare string "health fix deferred", once per finding per tick.
// Half of a real project's guardrail feed was this row: an internal retry
// marker, rendered as if it were a guardrail action, saying nothing about what
// or why. The audit rows still exist for the breaker and precision analysis —
// they just stop pretending to be news.
const INTERNAL_ONLY_ACTIONS = [
  'AUTONOMY_TICK',
  'AUTONOMY_SCAN_CONSUMED',
  'AUTONOMY_LIVE_RUN',
  'HEALTH_FIX_DEFERRED',
]

function classify(action: string): ActivityItem['kind'] {
  if ((AUTONOMOUS_AUDIT_ACTIONS as readonly string[]).includes(action)) return 'auto_fix'
  if (action === 'HEALTH_FIX_ESCALATED') return 'escalation'
  if (action === 'AUTONOMY_CIRCUIT_OPEN') return 'breaker'
  if (action.startsWith(ROLLBACK_PREFIX) || action === 'HEALTH_FIX_ROLLED_BACK') return 'rollback'
  if (action === 'AUTONOMY_SHADOW_DECISION') return 'shadow'
  // A human approved and the engine executed the fix — recorded, but NOT an
  // autonomous fix (the scoreboard counts are independent Prisma queries, so
  // this classification only drives the feed's colour + copy, never a number).
  if (action === 'HEALTH_FIX_EXECUTED') return 'applied'
  if (action === 'HEALTH_FIX_EXECUTION_FAILED') return 'failed'
  return 'other'
}

/** Human-readable label for the actions the feed shows verbatim today. */
function prettyAction(action: string): string {
  switch (action) {
    case 'HEALTH_FIX_APPROVED':       return 'You approved a fix — applying it now'
    case 'AUTONOMY_LEVEL_CHANGED':    return 'You changed the autonomy level'
    case 'HEALTH_FINDING_DISMISSED':  return 'You dismissed a finding'
    default:                          return action.replace(/_/g, ' ').toLowerCase()
  }
}

function humanize(action: string, details: string | null): string {
  let d: any = {}
  try { d = details ? JSON.parse(details) : {} } catch { /* details may be free text */ }
  switch (classify(action)) {
    case 'auto_fix':
      // The trust UI's headline rows — render the canonical "what because why"
      // sentence so the trust feed and the activity feed agree word-for-word.
      return explainAutonomyEvent(d).full
    case 'escalation':
      // Never the raw type. `Held back for your approval: rls_expression_invalid`
      // told the user nothing they could act on, and every escalation on a
      // different table produced a byte-identical row — six lines that looked
      // like one line repeated six times. summariseFinding is the single
      // finding→sentence renderer and it names the table, so each row is
      // distinguishable and legible.
      return d.findingType
        ? `Held back for your approval: ${summariseFinding(d.findingType, d)}`
        : 'Held back for your approval'
    case 'breaker':
      return `Safety circuit tripped — autonomous actions paused (${d.reason ?? 'rate ceiling reached'})`
    case 'applied': {
      const what = d.title || (d.findingType ? d.findingType.replace(/_/g, ' ') : null)
      // Only claim verification when the kernel actually re-probed and confirmed
      // it. This row asserted "verified & snapshotted" on every applied fix,
      // including the ones whose type no probe can re-check — the ledger was
      // vouching for work nothing had looked at.
      const suffix =
        d.verification === 'confirmed'
          ? ' — re-checked and confirmed, snapshot captured'
          : ' — applied and snapshotted (not independently re-checked)'
      return what
        ? `Applied your approved fix: ${what}${suffix}`
        : `Applied your approved fix${suffix}`
    }
    case 'failed':
      return `Approved fix could not be applied${d.findingType ? ` (${d.findingType.replace(/_/g, ' ')})` : ''} — left for your review`
    case 'rollback':
      return `Rolled back a previous change${d.findingType ? `: ${d.findingType.replace(/_/g, ' ')}` : ''}`
    case 'shadow':
      return d.summary ?? 'Evaluated what it would do (shadow mode)'
    default:
      if (action === 'AUTONOMY_LEVEL_CHANGED' && d.level) {
        return `You set the autonomy level to ${String(d.level).toLowerCase()}`
      }
      // Same bare-type leak as the escalation rows: this printed as
      // "health fix requested", which names neither what was requested nor
      // what came of it — and the outcome is always a separate row directly
      // beside it. Kept in the feed (it is a real thing a human did, and the
      // audit row exists so History can show who asked) but given the subject
      // that makes it worth a line.
      if (action === 'HEALTH_FIX_REQUESTED') {
        return d.findingType
          ? `You asked Backenly to fix: ${summariseFinding(d.findingType, d)}`
          : 'You asked Backenly to fix a finding'
      }
      return prettyAction(action)
  }
}

/**
 * Build the full trust report for one project over the trailing `windowDays`
 * (default 30). Every number traces to a durable audit/finding row.
 */
/**
 * Why a pending row is actually waiting on a human. Priority order mirrors
 * how the row got here:
 *
 *   1. escalation  — the loop TRIED (fix ran, or errored) and stopped after
 *                    honest verification; the queue must say so, because
 *                    "Autopilot attempted this and it didn't hold" is the
 *                    opposite story from "policy forbids Autopilot to act".
 *   2. recurrence  — auto-fixed repeatedly, kept coming back; escalate-on-flap.
 *   3. guardrail   — classifyFix genuinely gates this type on approval
 *                    (auth / external / destructive — the safety floor).
 *   4. held        — anything else (legacy rows without context).
 */
function heldBecauseFor(
  type: string,
  severity: string,
  det: Record<string, any>,
): PendingApproval['heldBecause'] {
  const esc = det.escalation as { reason?: string } | undefined
  if (esc?.reason) {
    return { kind: 'escalated', text: esc.reason }
  }

  const rec = det.recurrence as { priorAutoFixCount?: number; windowHours?: number; note?: string } | undefined
  if (rec) {
    const n = rec.priorAutoFixCount ?? 0
    return {
      kind: 'recurrence',
      text:
        rec.note ??
        `Autopilot fixed this ${n} time${n === 1 ? '' : 's'} in the last ${rec.windowHours ?? 24}h and it kept returning — the fix is not holding, so it stopped retrying.`,
    }
  }

  // Risk-flagged AI actions (approval-system) are genuine guardrail holds.
  if (type === 'ai_action_pending') {
    return {
      kind: 'guardrail',
      text:
        severity === 'critical'
          ? 'High-risk and hard to reverse. No autonomy mode can apply this without you.'
          : 'Flagged as risky by your guardrails — held for your one-click confirmation.',
    }
  }

  const classification = classifyFix(type, det)
  if (classification.decision === 'approval') {
    return { kind: 'guardrail', text: classification.reason }
  }

  return { kind: 'held', text: 'Waiting for your review.' }
}

export async function buildTrustReport(
  projectId: string,
  windowDays = 30,
): Promise<TrustReport> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const [
    level,
    cap,
    planName,
    autonomousFixes,
    escalations,
    breakerTrips,
    rollbacks,
    confirmedFixes,
    activityRows,
    pending,
    applied,
    lastShadow,
  ] = await Promise.all([
    getProjectAutonomyLevel(projectId),
    getProjectAutonomyCap(projectId),
    getProjectPlanName(projectId),
    prisma.auditLog.count({
      where: { projectId, timestamp: { gte: since }, action: { in: AUTONOMOUS_AUDIT_ACTIONS as unknown as string[] } },
    }),
    prisma.auditLog.count({
      where: { projectId, timestamp: { gte: since }, action: 'HEALTH_FIX_ESCALATED' },
    }),
    prisma.auditLog.count({
      where: { projectId, timestamp: { gte: since }, action: 'AUTONOMY_CIRCUIT_OPEN' },
    }),
    prisma.auditLog.count({
      where: { projectId, timestamp: { gte: since }, action: { startsWith: ROLLBACK_PREFIX } },
    }),
    // Fixes whose gap was re-probed after the fix and confirmed gone. The
    // kernel stamps `verification` into the HEALTH_AUTO_FIXED payload
    // (auto-fix-engine → recheckGap); `details` is a JSON string column, so
    // this matches on the serialised field rather than a JSON path.
    prisma.auditLog.count({
      where: {
        projectId,
        timestamp: { gte: since },
        action: 'HEALTH_AUTO_FIXED',
        details: { contains: '"verification":"confirmed"' },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        projectId,
        timestamp: { gte: since },
        action: { notIn: INTERNAL_ONLY_ACTIONS },
        OR: [
          { type: { in: ['autonomy', 'health'] } },
          { action: { startsWith: ROLLBACK_PREFIX } },
        ],
      },
      orderBy: { timestamp: 'desc' },
      take: 25,
      select: { action: true, details: true, timestamp: true },
    }),
    prisma.healthFinding.findMany({
      where: { projectId, status: 'pending_approval' },
      orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
      take: 25,
      select: { id: true, type: true, severity: true, detectedAt: true, details: true },
    }),
    // Ordered by fixAppliedAt, not detectedAt: a finding raised last week and
    // healed a minute ago belongs at the top of "what just changed".
    // `nulls: 'last'` keeps legacy rows (fixed before the column was stamped)
    // from sorting above genuinely recent work.
    prisma.healthFinding.findMany({
      where: { projectId, status: 'auto_fixed', autoFixed: true },
      orderBy: [{ fixAppliedAt: { sort: 'desc', nulls: 'last' } }, { detectedAt: 'desc' }],
      take: 25,
      select: {
        id: true, type: true, severity: true,
        detectedAt: true, fixAppliedAt: true, details: true,
      },
    }),
    prisma.auditLog.findFirst({
      where: { projectId, action: 'AUTONOMY_SHADOW_DECISION' },
      orderBy: { timestamp: 'desc' },
      select: { details: true, timestamp: true },
    }),
  ])

  // VERIFIED means re-probed and confirmed gone — nothing else.
  //
  // This was `(autonomousFixes - rollbacks) / autonomousFixes`, i.e. the share
  // of fixes nobody had undone. With zero rollbacks it read 100% unconditionally
  // while the loop was re-"fixing" the same five tables every 24 hours, so the
  // one number a founder is asked to trust the autonomy dial on was structurally
  // incapable of falling. It now counts only fixes the kernel positively
  // re-verified (see recheckGap + auto-fix-engine's `verification` stamp).
  //
  // HEALTH_AUTO_FIXED rows are a subset of AUTONOMOUS_AUDIT_ACTIONS, so the
  // ratio is clamped: older rows predate the stamp and read as unverified,
  // which is the honest reading — they were never verified.
  const verifiedRate =
    autonomousFixes > 0
      ? Math.max(0, Math.min(1, confirmedFixes / autonomousFixes))
      : null

  // Rows are newest-first, so folding CONSECUTIVE identical summaries keeps
  // `at` on the most recent occurrence and never merges two runs separated by
  // something that actually happened in between.
  const recentActivity: ActivityItem[] = []
  for (const r of activityRows) {
    const summary = humanize(r.action, r.details ?? null)
    const prev = recentActivity[recentActivity.length - 1]
    if (prev && prev.action === r.action && prev.summary === summary) {
      prev.repeat += 1
      continue
    }
    recentActivity.push({
      at: r.timestamp.toISOString(),
      action: r.action,
      kind: classify(r.action),
      summary,
      repeat: 1,
    })
  }

  const pendingApprovals: PendingApproval[] = pending.map(p => {
    const det = (p.details ?? {}) as Record<string, any>
    return {
      id: p.id,
      type: p.type,
      severity: p.severity,
      detectedAt: p.detectedAt.toISOString(),
      heldBecause: heldBecauseFor(p.type, p.severity, det),
      // summariseFinding is the single finding→sentence renderer (curated line →
      // detector's own details.reason → humanised type). The old fallback chain
      // ended in explainAutonomyEvent().why, whose generic branch emits the
      // clause fragment "it would have caused silent damage from going
      // unnoticed." — a broken headline for any type it doesn't know.
      reason: summariseFinding(p.type, det),
      source: det.source ?? 'autonomy',
      resource: det.location ?? det.tableName ?? undefined,
      details: det,
    }
  })

  const appliedChanges: AppliedChange[] = applied.map(f => {
    const det = (f.details ?? {}) as Record<string, any>
    const eligibility = revertEligibility(f.type, det)
    return {
      findingId: f.id,
      type: f.type,
      severity: f.severity,
      at: (f.fixAppliedAt ?? f.detectedAt).toISOString(),
      // The same renderer the activity feed uses, so a change described one way
      // in the feed is not described another way beside its Undo button.
      summary: explainAutonomyEvent({ findingType: f.type, ...det }).full,
      resource: det.location ?? det.tableName ?? undefined,
      // Only the kernel's positive re-probe counts. `rollbackData.verification`
      // is stamped by evaluateFixOutcome; anything else means nothing looked.
      verified: (det.rollbackData as Record<string, unknown> | undefined)?.verification === 'confirmed',
      revertible: eligibility.revertible,
      requiresConfirmation: eligibility.requiresConfirmation,
      revertBlockedReason: eligibility.reason,
    }
  })

  let shadowPreview: ShadowPreview | null = null
  if (lastShadow?.details) {
    try {
      const s = JSON.parse(lastShadow.details)
      shadowPreview = {
        at: lastShadow.timestamp.toISOString(),
        level: s.level ?? level,
        summary: s.summary ?? '',
        autoBudget: s.autoBudget ?? 0,
        counts: s.counts ?? {},
      }
    } catch { /* tolerate legacy/free-text rows */ }
  }

  return {
    projectId,
    level,
    cap,
    plan: planDisplayName(planName),
    invariantCount: INVARIANTS.length,
    scoreboard: {
      windowDays,
      autonomousFixes,
      escalations,
      breakerTrips,
      rollbacks,
      verifiedRate,
    },
    recentActivity,
    pendingApprovals,
    appliedChanges,
    shadowPreview,
  }
}
