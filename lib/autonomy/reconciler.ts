/**
 * RECONCILER — the MAPE-K closed loop (SHADOW MODE)
 * =================================================
 *
 * This is the Plan stage of the autonomous control loop. It ties the three
 * Phase-1/2 primitives together:
 *
 *   Knowledge   → computeDesiredStateDiff   (what is wrong, tier-tagged)
 *   Risk dial   → getProjectAutonomyLevel   (how much the owner trusts it)
 *   Safety      → checkBreaker              (how much it may do this window)
 *
 * and produces an ordered decision for every gap: would it auto-apply, queue
 * for approval, or hold back — and exactly why.
 *
 * DELIBERATE SHADOW-FIRST CONTRACT:
 *   This module executes NOTHING. It decides and records the decision to the
 *   audit log so the loop's precision can be measured for weeks before any
 *   live-execution path is ever introduced. A bad autonomous action on real
 *   user data is unrecoverable trust loss — so the loop earns the right to act
 *   by first proving, in shadow, that its decisions would have been correct.
 *   Live execution is intentionally a later phase, gated separately, and will
 *   reuse the existing deterministic kernel (auto-fix-engine) — never a second
 *   execution path bolted on here.
 */

import { prisma } from '@/lib/db/prisma'
import { computeDesiredStateDiff, summarizeDesiredState, gapIdentity } from './desired-state'
import type { DesiredStateGap, DesiredStateReport } from './desired-state'
import {
  getProjectAutonomyLevel,
  isTierAutoAllowed,
  breakerMultiplier,
  type AutonomyLevel,
} from './autonomy-level'
import { checkBreaker } from './circuit-breaker'
import { classifyFix } from '@/lib/core/fix-classifier'
import { computeHealthSignal } from './telemetry'
import { LOOP_TICK_ACTIONS } from './loop-tick'
import { runAutoFix } from '@/lib/core/auto-fix-engine'
import { FLAGS } from '@/lib/config/flags'

export type ReconcileAction =
  | 'WOULD_AUTO_APPLY'     // tier within dial + breaker budget available
  | 'NEEDS_APPROVAL'       // Tier-2 — always human-gated
  | 'NOTIFY_ONLY'          // Tier-3 — escalate, never auto
  | 'BLOCKED_BY_LEVEL'     // tier is auto-eligible but dial is set lower
  | 'BLOCKED_BY_BREAKER'   // would auto-apply but window ceiling reached

export interface ReconcileDecision {
  invariantId: string
  type: string
  tier: number
  severity: string
  action: ReconcileAction
  reason: string
  /** The underlying gap — carried so the live path can act without re-probing. */
  gap: DesiredStateGap
}

export interface ReconciliationPlan {
  projectId: string
  evaluatedAt: string
  level: AutonomyLevel
  summary: string
  /** Effective per-window auto-apply ceiling = breaker base × level multiplier. */
  autoBudget: number
  decisions: ReconcileDecision[]
  counts: Record<ReconcileAction, number>
  /** Carried through so callers can render gap detail without re-probing. */
  report: DesiredStateReport
}

// Critical first, then by ascending blast-radius tier (cheap/safe fixes first).
const SEV_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }
function orderGaps(a: DesiredStateGap, b: DesiredStateGap): number {
  const s = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3)
  return s !== 0 ? s : a.tier - b.tier
}

/**
 * Decide what the loop WOULD do for every gap. Pure: no project mutation, no
 * audit write. Read-only probes only.
 */
export async function computeReconciliationPlan(projectId: string): Promise<ReconciliationPlan> {
  const [report, level, breaker] = await Promise.all([
    computeDesiredStateDiff(projectId),
    getProjectAutonomyLevel(projectId),
    checkBreaker(projectId),
  ])

  // Effective budget for THIS window.
  //
  // On an unlimited plan (the norm — healing is not metered) the loop repairs
  // everything it legitimately can, so the budget is simply "every gap we
  // found". The dial still decides WHICH tiers auto-apply via isTierAutoAllowed
  // below; it must not re-impose a count quota that the plan does not have.
  // A zero multiplier (OFF) still floors the budget at 0.
  //
  // Kept finite deliberately: this value is serialised into the trust report,
  // and Infinity would round-trip through JSON as null.
  const multiplier = breakerMultiplier(level)
  const autoBudget =
    breaker.unlimited && multiplier > 0
      ? report.violations.length
      : Math.max(0, Math.floor(breaker.remaining * multiplier))

  let spent = 0
  const decisions: ReconcileDecision[] = []
  const counts: Record<ReconcileAction, number> = {
    WOULD_AUTO_APPLY: 0,
    NEEDS_APPROVAL: 0,
    NOTIFY_ONLY: 0,
    BLOCKED_BY_LEVEL: 0,
    BLOCKED_BY_BREAKER: 0,
  }

  for (const gap of [...report.violations].sort(orderGaps)) {
    let action: ReconcileAction
    let reason: string

    if (gap.tier >= 3) {
      action = 'NOTIFY_ONLY'
      reason = 'Irreversible / no automated remediation — escalated to the owner.'
    } else if (gap.tier === 2) {
      action = 'NEEDS_APPROVAL'
      reason = 'Auth/external/destructive — always requires human approval, at every level.'
    } else if (!isTierAutoAllowed(level, gap.tier as 0 | 1)) {
      action = 'BLOCKED_BY_LEVEL'
      reason = `Auto-eligible (Tier ${gap.tier}) but the project autonomy level is ${level}.`
    } else if (spent >= autoBudget) {
      action = 'BLOCKED_BY_BREAKER'
      reason = breaker.allowed
        ? `Per-window auto-apply budget exhausted (${autoBudget} this ${breaker.windowMinutes} min window at ${level}).`
        : (breaker.reason ?? 'Circuit breaker open.')
    } else {
      action = 'WOULD_AUTO_APPLY'
      reason = `Tier ${gap.tier} within ${level} dial and within window budget.`
      spent++
    }

    counts[action]++
    decisions.push({
      invariantId: gap.invariantId,
      type: gap.type,
      tier: gap.tier,
      severity: gap.severity,
      action,
      reason,
      gap,
    })
  }

  return {
    projectId,
    evaluatedAt: report.evaluatedAt,
    level,
    summary: summarizeDesiredState(report),
    autoBudget,
    decisions,
    counts,
    report,
  }
}

/**
 * Run the reconciler in SHADOW mode: compute the plan and persist a single
 * audit row capturing exactly what the loop would have done and why. Acts on
 * nothing. Never throws — one project's failure must never stall the cron.
 *
 * The persisted AUTONOMY_SHADOW_DECISION rows are the dataset used to measure
 * decision precision before live execution is ever enabled.
 */
export async function runReconcilerShadow(projectId: string): Promise<ReconciliationPlan | null> {
  try {
    const plan = await computeReconciliationPlan(projectId)

    // Skip the audit write entirely when there is nothing to decide — keeps
    // the ledger signal-dense for the precision analysis.
    if (plan.decisions.length === 0 && plan.report.errors.length === 0) {
      return plan
    }

    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'AUTONOMY_SHADOW_DECISION',
        type: 'autonomy',
        details: JSON.stringify({
          mode: 'shadow',
          level: plan.level,
          summary: plan.summary,
          autoBudget: plan.autoBudget,
          counts: plan.counts,
          // Compact per-decision record — enough to later diff shadow choices
          // against human/ground-truth outcomes for precision measurement.
          decisions: plan.decisions.map(d => ({
            inv: d.invariantId,
            type: d.type,
            tier: d.tier,
            sev: d.severity,
            act: d.action,
          })),
          probeErrors: plan.report.errors,
          evaluatedAt: plan.evaluatedAt,
        }),
        timestamp: new Date(),
      },
    }).catch((e: any) =>
      console.warn(`[Reconciler] shadow audit write failed for ${projectId}:`, e?.message),
    )

    console.log(
      `[Reconciler:shadow] project=${projectId} level=${plan.level} ` +
      `wouldAutoApply=${plan.counts.WOULD_AUTO_APPLY} ` +
      `approval=${plan.counts.NEEDS_APPROVAL} ` +
      `blockedLevel=${plan.counts.BLOCKED_BY_LEVEL} ` +
      `blockedBreaker=${plan.counts.BLOCKED_BY_BREAKER} ` +
      `notify=${plan.counts.NOTIFY_ONLY}`,
    )

    return plan
  } catch (err: any) {
    console.warn(`[Reconciler:shadow] failed for ${projectId}:`, err?.message)
    return null
  }
}

// ── Live execution ────────────────────────────────────────────────────────────

export interface LiveReconcileResult {
  projectId: string
  level: AutonomyLevel
  /** True when changes were frozen because the project is mid-incident. */
  frozen: boolean
  attempted: number
  applied: number
  escalated: number
  /** Blocked by a transient timing condition; left open, retried next tick. */
  deferred: number
  plan: ReconciliationPlan
}

/**
 * Stable identity for a gap so we never create duplicate findings for the same
 * underlying problem (mirrors the observer's type+location dedupe).
 */
function gapKey(g: DesiredStateGap): string {
  // Delegates to the ONE identity definition (column-precise) — a table-scoped
  // key here collapsed two different columns' gaps into one finding and made
  // the fix for the first column fail verification against the second.
  return gapIdentity(g.type, g.details as Record<string, unknown>)
}

/**
 * Suppress re-creating a finding for a gap we already auto-fixed within this
 * window. If the detector re-sees the same `type+location` after we just acted
 * on it, the fix didn't actually plug the gap (or the detector is wrong) —
 * re-running it on every cadence tick spams 30 identical audit rows and burns
 * the breaker budget on no-op work. After this many recurrences inside the
 * window we ESCALATE the still-open repeat to a human — silent re-loops are
 * the failure mode that turns autonomy into noise.
 */
const RECURRENCE_WINDOW_HOURS = 24
const RECURRENCE_ESCALATE_AFTER = 3

/**
 * How long to wait before re-attempting a fix that FAILED, by attempt number.
 *
 * A failure escalation is a diagnosis, not a verdict: it says "this fix did not
 * work against the backend as it stood at that moment". Backends move. The
 * ladder starts short enough to catch a condition that clears within the hour
 * and ends long enough that a genuinely unfixable gap stops costing anything.
 * After the last rung the finding stays with the human for good.
 */
export const ESCALATION_RETRY_BACKOFF_HOURS = [1, 6, 24, 72] as const

/** What a stuck `pending_approval` row carries about its last failed attempt. */
export interface EscalationRecord {
  reason?: unknown
  at?: unknown
  retryCount?: unknown
  lastRetryAt?: unknown
}

export interface RetryDecision {
  retry: boolean
  /** 1-based attempt number this retry would be. 0 when not retrying. */
  attempt: number
  reason: string
}

/**
 * Should a failed fix be attempted again? Pure, so the rule is provable without
 * a database — the same discipline fix-acceptance.ts and sensor-health.ts hold
 * themselves to, and the reason this lives in `tests/unit` where CI runs it.
 *
 * `isAutoFixable` is the classifier's verdict for the finding. It is the safety
 * floor: a fix a human must approve is never retried by the loop, no matter how
 * old the escalation is.
 */
export function shouldRetryEscalation(
  isAutoFixable: boolean,
  escalation: EscalationRecord | null | undefined,
  now: Date = new Date(),
): RetryDecision {
  if (!isAutoFixable) {
    return { retry: false, attempt: 0, reason: 'Policy escalation — a human owns this decision.' }
  }

  const e = escalation ?? {}
  const attempts = typeof e.retryCount === 'number' ? e.retryCount : 0
  if (attempts >= ESCALATION_RETRY_BACKOFF_HOURS.length) {
    return {
      retry: false,
      attempt: 0,
      reason: `Retried ${attempts} time(s) without success — left for review permanently.`,
    }
  }

  const lastRaw = (e.lastRetryAt ?? e.at) as string | undefined
  const lastMs = typeof lastRaw === 'string' ? Date.parse(lastRaw) : NaN

  // No usable timestamp means the row predates the bookkeeping (every stuck
  // production row is in this shape). Retry it now rather than stranding it —
  // but the write below stamps `lastRetryAt`, so it enters the ladder and cannot
  // retry again until the first rung elapses.
  if (Number.isFinite(lastMs)) {
    const waitMs = ESCALATION_RETRY_BACKOFF_HOURS[attempts] * 60 * 60 * 1000
    const elapsed = now.getTime() - lastMs
    if (elapsed < waitMs) {
      return {
        retry: false,
        attempt: 0,
        reason: `Backing off — ${ESCALATION_RETRY_BACKOFF_HOURS[attempts]}h has not elapsed since the last attempt.`,
      }
    }
  }

  return {
    retry: true,
    attempt: attempts + 1,
    reason: `Failure escalation is stale — re-attempting (${attempts + 1}/${ESCALATION_RETRY_BACKOFF_HOURS.length}).`,
  }
}

/**
 * Decide whether a `pending_approval` finding may be handed back to the kernel.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * `pending_approval` was treated as terminal: matched it, returned null, done.
 * That conflates two states that are not the same thing.
 *
 *   • POLICY escalation — the classifier rated the fix `approval` or
 *     `notify_only` (auth, external credentials, destructive). A human decides.
 *     Retrying would be the loop acting behind someone's back. Still returns
 *     null, forever, exactly as before.
 *
 *   • FAILURE escalation — an `auto`-rated fix RAN and did not work, so
 *     `_escalate` parked it. Nothing about that is a human decision; it is a
 *     record of one failed attempt against one moment in time.
 *
 * Only the second kind was mishandled, and it was mishandled completely: there
 * was no path back. Production proved the cost. On 2026-07-18 seven `missing_fk`
 * fixes failed with `42P17 — infinite recursion detected in policy for relation
 * "organization_members"`. The recursive policy was repaired days later. The
 * findings never moved. For the thirteen days after, the loop re-detected all
 * seven every sixty seconds, wrote an AUTONOMY_LIVE_RUN row that reads like
 * work, and logged `applied=0 escalated=0 deferred=0 attempted=0` — 7,636 times.
 * The fixes succeed on the current schema; nothing was retrying them.
 *
 * Bounded on purpose: the backoff ladder above, a hard attempt cap, and the
 * classifier gate mean the worst case is four extra attempts spread over four
 * days before the finding is left alone permanently.
 */
async function reopenIfRetryable(
  findingId: string,
  projectId: string,
  gap: DesiredStateGap,
  rawDetails: unknown,
): Promise<string | null> {
  const details = (rawDetails ?? {}) as Record<string, unknown>
  const escalation = (details.escalation ?? {}) as EscalationRecord

  // The safety floor comes from the classifier rather than the gap tier: the
  // classifier is the single source of truth the kernel itself re-checks, so
  // disagreeing with it here would let the two gates drift.
  const isAutoFixable =
    classifyFix(gap.type, gap.details as Record<string, unknown>).decision === 'auto'

  const decision = shouldRetryEscalation(isAutoFixable, escalation)
  if (!decision.retry) return null

  // Hand it back to the kernel. The retry bookkeeping is written BEFORE the
  // attempt so a fix that crashes the process still burns its attempt — the
  // alternative is a poisoned finding that retries every tick forever, which is
  // the failure mode this whole function exists to end.
  const updated = await prisma.healthFinding
    .update({
      where: { id: findingId, status: 'pending_approval' },
      data: {
        status: 'open',
        details: {
          ...details,
          escalation: {
            ...escalation,
            retryCount: decision.attempt,
            lastRetryAt: new Date().toISOString(),
          },
        } as any,
      },
      select: { id: true },
    })
    .catch(() => null)
  if (!updated) return null

  await prisma.auditLog
    .create({
      data: {
        projectId,
        action: 'AUTONOMY_ESCALATION_RETRIED',
        type: 'autonomy',
        details: JSON.stringify({
          findingId,
          findingType: gap.type,
          gapKey: gapKey(gap),
          tableName: (gap.details as Record<string, unknown>)?.tableName ?? null,
          attempt: decision.attempt,
          maxAttempts: ESCALATION_RETRY_BACKOFF_HOURS.length,
          priorFailure:
            typeof escalation.reason === 'string' ? escalation.reason.slice(0, 300) : null,
        }),
        timestamp: new Date(),
      },
    })
    .catch(() => {})

  return findingId
}

/**
 * Find an existing actionable HealthFinding for this gap, or create one. The
 * live path then delegates execution entirely to runAutoFix — reusing the
 * deterministic kernel (classification gate, circuit breaker, pre-snapshot,
 * audit ledger, escalate-on-failure). No second execution path is introduced.
 */
async function ensureFinding(projectId: string, gap: DesiredStateGap): Promise<string | null> {
  try {
    const key = gapKey(gap)

    // ── 1) Same gap already actionable? ──────────────────────────────────────
    const open = await prisma.healthFinding.findMany({
      where: { projectId, type: gap.type, status: { in: ['open', 'pending_approval'] } },
      select: { id: true, status: true, details: true },
      take: 50,
    })
    // Prefer an `open` row over a `pending_approval` one for the SAME identity.
    // Both can exist: a fix that failed leaves a pending_approval row, and a
    // later scan path (the observer, a deep scan) can mint a fresh `open` row
    // for the same gap because it does not consult this dedupe. Taking whichever
    // Prisma returned first meant the actionable row was permanently shadowed by
    // the stuck one — prod carried `missing_fk::prompts.user_id` in BOTH states,
    // and the open one was never once attempted.
    const matches = open.filter(
      f => gapIdentity(gap.type, (f.details ?? {}) as Record<string, unknown>) === key,
    )
    const matchOpen = matches.find(f => f.status === 'open') ?? matches[0]
    if (matchOpen) {
      if (matchOpen.status === 'pending_approval') {
        return reopenIfRetryable(matchOpen.id, projectId, gap, matchOpen.details)
      }
      return matchOpen.id
    }

    // ── 2) Recurrence suppression ────────────────────────────────────────────
    // Same `type+location` was auto-fixed inside the recurrence window: don't
    // mint a fresh finding and don't burn another autonomy slot on it. This is
    // the single bug that produced 30 identical "added a missing FK index on
    // 'a table'" rows on the dashboard.
    const since = new Date(Date.now() - RECURRENCE_WINDOW_HOURS * 60 * 60 * 1000)
    const recentFixed = await prisma.healthFinding.findMany({
      where: {
        projectId,
        type: gap.type,
        status: 'auto_fixed',
        fixAppliedAt: { gte: since },
      },
      select: { id: true, details: true, fixAppliedAt: true },
      orderBy: { fixAppliedAt: 'desc' },
      take: 50,
    })
    const recurrences = recentFixed.filter(
      f => gapIdentity(gap.type, (f.details ?? {}) as Record<string, unknown>) === key,
    )

    // Suppressions count toward the escalation threshold, and without this the
    // threshold was UNREACHABLE.
    //
    // `recurrences` counts prior auto_fixed rows — but the suppression branch
    // below deliberately creates no finding and therefore no new auto_fixed row.
    // So the count froze at 1 no matter how many times the gap came back, never
    // reached RECURRENCE_ESCALATE_AFTER, and the escalate-on-flap path was dead
    // code. The observable result on prod: the same five tables were re-"fixed"
    // once every 24 hours (one window roll-off apart) for as long as the gap
    // existed, each pass logged as a successful autonomous fix, and no human was
    // ever told the fix wasn't holding.
    const suppressedCount = await prisma.auditLog.count({
      where: {
        projectId,
        action: 'AUTONOMY_RECURRENCE_SUPPRESSED',
        timestamp: { gte: since },
        // details is a JSON string column; the gap key is matched on the two
        // fields the suppression row records.
        AND: [
          { details: { contains: `"findingType":"${gap.type}"` } },
          { details: { contains: `"gapKey":"${key}"` } },
        ],
      },
    }).catch(() => 0)

    const recurrenceCount = recurrences.length + suppressedCount

    if (recurrenceCount > 0) {
      // Threshold reached → the fix demonstrably isn't holding. Stop auto-acting
      // on it; open ONE pending_approval finding so a human can investigate the
      // detector or the fix path. This is the "escalate on flap" pattern every
      // serious autonomous system uses (K8s pod-restart loops, AWS Auto Scaling
      // cooldown, SRE error-budget burn alerts).
      if (recurrenceCount >= RECURRENCE_ESCALATE_AFTER) {
        const created = await prisma.healthFinding.create({
          data: {
            projectId,
            type: gap.type,
            severity: 'warning',
            details: {
              ...(gap.details as Record<string, unknown>),
              recurrence: {
                priorAutoFixCount: recurrences.length,
                suppressedCount,
                recurrenceCount,
                windowHours: RECURRENCE_WINDOW_HOURS,
                lastFixAt: recurrences[0]?.fixAppliedAt?.toISOString() ?? null,
                note: 'Same gap re-detected after auto-fix — fix did not hold. Escalated for review.',
              },
            } as any,
            status: 'pending_approval',
            autoFixed: false,
          },
          select: { id: true },
        })
        await prisma.auditLog.create({
          data: {
            projectId,
            action: 'AUTONOMY_RECURRENCE_ESCALATED',
            type: 'autonomy',
            details: JSON.stringify({
              findingId: created.id,
              findingType: gap.type,
              gapKey: key,
              tableName: (gap.details as Record<string, unknown>)?.tableName ?? null,
              priorAutoFixCount: recurrences.length,
              suppressedCount,
              recurrenceCount,
              windowHours: RECURRENCE_WINDOW_HOURS,
            }),
            timestamp: new Date(),
          },
        }).catch(() => {})
        // Returning null keeps the live loop from also running this on the
        // same tick — the row is in pending_approval, awaiting the human.
        return null
      }

      // Below escalation threshold → suppress silently. One low-noise audit
      // row so the trust report can later measure "% of fixes that recurred"
      // (the honest quality signal for the loop itself).
      await prisma.auditLog.create({
        data: {
          projectId,
          action: 'AUTONOMY_RECURRENCE_SUPPRESSED',
          type: 'autonomy',
          details: JSON.stringify({
            findingType: gap.type,
            // The identity this suppression is FOR. Recorded because the next
            // tick counts these rows toward the escalation threshold — without
            // the key it could not tell one gap's suppressions from another's.
            gapKey: key,
            tableName: (gap.details as Record<string, unknown>)?.tableName ?? null,
            priorAutoFixCount: recurrences.length,
            suppressedSoFar: suppressedCount,
            recurrenceCount,
            windowHours: RECURRENCE_WINDOW_HOURS,
          }),
          timestamp: new Date(),
        },
      }).catch(() => {})
      return null
    }

    // ── 3) Fresh gap → mint a finding for the kernel to act on ───────────────
    const created = await prisma.healthFinding.create({
      data: {
        projectId,
        type: gap.type,
        severity: gap.severity,
        details: gap.details as any,
        status: 'open',
        autoFixed: false,
      },
      select: { id: true },
    })
    return created.id
  } catch (err: any) {
    console.warn(`[Reconciler:live] ensureFinding failed for ${projectId}/${gap.type}:`, err?.message)
    return null
  }
}

/**
 * Close the loop for real. Reuses the deterministic kernel for every mutation.
 *
 * Safety properties (in addition to the kernel's own snapshot/rollback/audit):
 *   • CHANGE FREEZE — if telemetry says the project is mid-incident
 *     (state = anomalous), auto-apply is suspended this tick. Mutating a
 *     backend that is already failing is how automation makes outages worse;
 *     every serious SRE system freezes changes during an active anomaly.
 *   • Only WOULD_AUTO_APPLY decisions run — the dial + breaker already filtered
 *     everything else into approval/notify/blocked upstream.
 *
 * Never throws. One project's failure never stalls the cron.
 */
export async function runReconcilerLive(projectId: string): Promise<LiveReconcileResult | null> {
  try {
    const plan = await computeReconciliationPlan(projectId)
    const base = { projectId, level: plan.level, plan }

    // Withdraw invariant findings the probes no longer support — the same tick
    // that can CREATE findings must also be able to CLOSE them, or a gap whose
    // target disappeared (dropped table) waits in the approval queue forever.
    // Reuses this tick's report: zero extra probe runs.
    await import('@/lib/core/finding-reaper')
      .then(m => m.reapInvariantFindings(projectId, plan.report))
      .catch(() => 0)

    const toApply = plan.decisions.filter(d => d.action === 'WOULD_AUTO_APPLY')
    if (toApply.length === 0) {
      return { ...base, frozen: false, attempted: 0, applied: 0, escalated: 0, deferred: 0 }
    }

    // ── Change freeze during an active incident ──────────────────────────────
    const health = await computeHealthSignal(projectId).catch(() => null)
    if (health?.state === 'anomalous') {
      await prisma.auditLog.create({
        data: {
          projectId,
          action: 'AUTONOMY_CHANGE_FREEZE',
          type: 'autonomy',
          details: JSON.stringify({
            reason: 'project is mid-incident — autonomous changes frozen this tick',
            health: health.reasons,
            wouldHaveApplied: toApply.length,
          }),
          timestamp: new Date(),
        },
      }).catch(() => {})
      console.warn(
        `[Reconciler:live] FROZEN project=${projectId} — anomaly active, ` +
        `${toApply.length} auto-fixes deferred. ${health.reasons.join(' ')}`,
      )
      return { ...base, frozen: true, attempted: 0, applied: 0, escalated: 0, deferred: 0 }
    }

    let applied = 0
    let escalated = 0
    let deferred = 0
    let attempted = 0

    for (const decision of toApply) {
      const findingId = await ensureFinding(projectId, decision.gap)
      if (!findingId) continue
      attempted++
      // The kernel re-checks the classifier (defence in depth) and the circuit
      // breaker, captures a pre-snapshot for schema-touching fixes, writes the
      // HEALTH_AUTO_FIXED ledger row, escalates genuine failures, and DEFERS
      // transient timing conditions (mutation cooldown / lock / breaker).
      const res = await runAutoFix(findingId, projectId)
      if (res.outcome === 'auto_fixed') {
        applied++
      } else if (res.outcome === 'deferred') {
        deferred++
        // The mutation kernel enforces a cooldown between writes. Hammering it
        // would just defer the rest too. Stop now — the remaining gaps stay
        // OPEN and the next tick picks them up. This is what makes the loop
        // genuinely autonomous instead of piling work into the approval queue.
        break
      } else if (res.outcome === 'escalated' || res.outcome === 'pending_approval') {
        escalated++
      }
    }

    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'AUTONOMY_LIVE_RUN',
        type: 'autonomy',
        details: JSON.stringify({
          level: plan.level,
          attempted,
          applied,
          escalated,
          deferred,
          autoBudget: plan.autoBudget,
        }),
        timestamp: new Date(),
      },
    }).catch(() => {})

    console.log(
      `[Reconciler:live] project=${projectId} level=${plan.level} ` +
      `applied=${applied} escalated=${escalated} deferred=${deferred} attempted=${attempted}`,
    )

    return { ...base, frozen: false, attempted, applied, escalated, deferred }
  } catch (err: any) {
    console.warn(`[Reconciler:live] failed for ${projectId}:`, err?.message)
    return null
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * The single entry point the cron calls. Three switches, by design:
 *
 *   1. FLAGS.ENABLE_AUTONOMY_RECONCILER — master on/off. Off ⇒ the loop does
 *      not run at all (the explicit, reversible production lever).
 *   2. The owner's plan cadence (autonomyScanIntervalMin) — 1 minute on EVERY
 *      plan including Free (see prisma/seed-billing.ts; the schema default of
 *      360 is a fallback, not a live value). The cron fires every minute and
 *      no plan is throttled below it: "self-healing every minute" is what the
 *      pricing page promises on the Free tier, so the gate must not contradict
 *      it. Free↔Pro is separated by scan BUDGET and actions per window, not by
 *      how often the loop is allowed to look.
 *
 *      The gate stays because the field is per-plan and live-editable — an
 *      Enterprise contract can widen it, and a future plan could throttle —
 *      but with today's values it is a no-op for every real subscriber.
 *      Resolved cadence is a floor: if the plan read fails we clamp to the
 *      SAFE fallback (24h), so a transient DB blip degrades to slow rather
 *      than to unbounded.
 *
 *      This loop is deterministic: runReconciler → auto-fix-engine →
 *      executeAction, none of which call a model. A Pro project reconciling
 *      every minute costs DB work and audit rows, not tokens.
 *   3. The per-project autonomy dial — OFF ⇒ observe only (shadow); any other
 *      level ⇒ the loop executes, bounded by tier + breaker + change-freeze.
 */
export async function runReconciler(
  projectId: string,
): Promise<ReconciliationPlan | LiveReconcileResult | null> {
  if (!FLAGS.ENABLE_AUTONOMY_RECONCILER) return null

  // Plan-driven cadence gate. The "tick" is any prior reconciler audit row
  // — live, shadow, change-freeze, or the dispatcher-written TICK marker. The
  // marker is needed because both the shadow path (empty plan) and the live
  // path (nothing to apply) intentionally skip their own audit write to keep
  // the precision dataset signal-dense. Without the marker, those silent runs
  // would never register and the gate would let the next cron tick straight
  // through.
  if (await isWithinCadenceCooldown(projectId)) return null

  // Record the tick BEFORE doing per-mode work so even an exception inside
  // shadow/live still counts toward cadence (preventing a poisoned project
  // from re-entering the loop on every tick).
  await prisma.auditLog
    .create({
      data: {
        projectId,
        action: 'AUTONOMY_TICK',
        type: 'autonomy',
        details: JSON.stringify({}),
        timestamp: new Date(),
      },
    })
    .catch(() => {})

  const level = await getProjectAutonomyLevel(projectId)
  if (level === 'OFF' || !FLAGS.ENABLE_AUTONOMY_LIVE_EXECUTION) {
    // Loop is on but this project opted out of action — still observe + record.
    return runReconcilerShadow(projectId)
  }
  return runReconcilerLive(projectId)
}

/**
 * The plan cadence floor in minutes. Falls back to 24h on any failure — an
 * unresolvable plan must degrade to slow, never to unbounded.
 */
const SAFE_CADENCE_MIN = 1_440

async function getProjectAutonomyCadenceMin(projectId: string): Promise<number> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return SAFE_CADENCE_MIN
    const sub = await prisma.subscription.findFirst({
      where: { userId: project.userId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
      include: { plan: { select: { autonomyScanIntervalMin: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const raw = sub?.plan?.autonomyScanIntervalMin
    return typeof raw === 'number' && raw > 0 ? raw : SAFE_CADENCE_MIN
  } catch {
    return SAFE_CADENCE_MIN
  }
}

async function isWithinCadenceCooldown(projectId: string): Promise<boolean> {
  const cadenceMin = await getProjectAutonomyCadenceMin(projectId)
  // Subtract a small jitter floor so a project whose cadence equals the cron
  // period doesn't drift to double it on clock skew (≈1 min slop). At the
  // current 1-min cadence this clamps to 0, i.e. every tick runs.
  const since = new Date(Date.now() - Math.max(0, cadenceMin - 1) * 60_000)
  const lastTick = await prisma.auditLog
    .findFirst({
      where: {
        projectId,
        // Shared with the dashboard's "checked N ago" reader so the cadence gate
        // and the displayed timestamp cannot disagree about what a tick is.
        action: { in: [...LOOP_TICK_ACTIONS] },
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    })
    .catch(() => null)
  return !!lastTick
}
