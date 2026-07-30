/**
 * AGENTIC FIX-LOOP
 * ================
 *
 * "Make my backend actually pass verification — and don't come back to me
 * until you've tried."
 *
 * This is the loop that converts a chatty linter into an agent. It runs:
 *
 *   round 0:   verify
 *   round N:   triage failures → apply curated fixes → re-verify
 *              terminate on (passed) | (no-progress) | (max-rounds) | (cancelled)
 *
 * The loop never invents raw SQL — every fix is dispatched through the
 * existing `executeAction` executor under `withBuildLock`, so:
 *   - Every mutation is audited / snapshotted / reversible
 *   - The destructive-action gate still applies
 *   - The build governance kernel sees everything
 *
 * Progress is streamed via an `emit` callback (the same SSE channel the
 * chat UI already speaks). The loop never throws — every recoverable
 * failure becomes a streamed event so the user always sees what happened.
 */

import { runBehavioralVerification } from './behavioral-verifier'
import type { BehavioralCheck, BehavioralVerificationResult } from './behavioral-verifier'
import { mapCheckToFixes, type FixCandidate } from './behavioral-check-to-fixes'
import { executeAction, type AIAction } from './minimal-executor'
import { processOpenFindings } from '@/lib/core/auto-fix-engine'
import { withBuildLock } from '@/lib/ai/build-runtime/build-lock'
import { FLAGS } from '@/lib/config/flags'
import { authorFixForCheck, MAX_AUTHORED_FIXES_PER_BUILD } from './agentic-fix-author'
import { harvestScanFixes } from './scan/scan-to-fixes'

// ── Public types ─────────────────────────────────────────────────────────────

export type FixLoopEvent =
  | { type: 'fix_loop_started'; maxRounds: number; goal: string }
  | { type: 'fix_loop_verify_start'; round: number }
  | {
      type: 'fix_loop_verify_done'
      round: number
      passed: boolean
      failedChecks: Array<{ id: string; name: string; error?: string }>
      skippedChecks: Array<{ id: string; name: string; reason?: string }>
    }
  | { type: 'fix_loop_no_fixes'; round: number; reason: string }
  | { type: 'fix_loop_health_findings_start'; round: number; openCount: number }
  | { type: 'fix_loop_health_findings_done'; round: number; autoFixed: number; pending: number; failed: number }
  | { type: 'fix_loop_scan_harvest_done'; round: number; candidates: number; uncovered: number }
  | { type: 'fix_loop_fix_start'; round: number; fix: { id: string; action: string; reason: string; sourceCheckId: string } }
  | { type: 'fix_loop_fix_done'; round: number; fix: { id: string; action: string; sourceCheckId: string }; success: boolean; message: string }
  | { type: 'fix_loop_fix_needs_approval'; round: number; fix: { id: string; action: string; reason: string } }
  | {
      /**
       * Phase 14 — Agentic Fix Author proposed a novel fix the curated
       * registry did not cover. Mirrors `agent_proposed_fix` on the SSE
       * channel so the chat UI can render "Agent authored repair".
       */
      type: 'fix_loop_agent_proposed_fix'
      round: number
      sourceCheckId: string
      action: string
      reason: string
      requiresApproval: boolean
    }
  | {
      type: 'fix_loop_complete'
      success: boolean
      rounds: number
      reason: 'passed' | 'no_progress' | 'max_rounds' | 'cancelled' | 'no_initial_failures'
      summary: string
    }

export interface FixLoopOptions {
  /** Hard cap on iterations. Defaults to 5. */
  maxRounds?: number
  /** Optional AbortSignal — cancels the loop between phases (not mid-action). */
  signal?: AbortSignal
  /** SSE emitter — every progress milestone goes here. */
  emit: (event: FixLoopEvent) => void
}

export type FixLoopTerminalReason =
  | 'passed'
  | 'no_progress'
  | 'max_rounds'
  | 'cancelled'
  | 'no_initial_failures'

export interface FixLoopResult {
  passed: boolean
  rounds: number
  reason: FixLoopTerminalReason
  finalCheckSnapshot: BehavioralVerificationResult
  appliedFixes: number
  summary: string
}

// ── Public entry ─────────────────────────────────────────────────────────────

export async function runAgenticFixLoop(
  projectId: string,
  userId: string,
  options: FixLoopOptions,
): Promise<FixLoopResult> {
  const maxRounds = options.maxRounds ?? 5
  const emit = options.emit
  const signal = options.signal

  emit({
    type: 'fix_loop_started',
    maxRounds,
    goal: 'Make the backend pass behavioral verification',
  })

  // ── Round 0: initial assessment ────────────────────────────────────────────
  emit({ type: 'fix_loop_verify_start', round: 0 })
  let snapshot = await runBehavioralVerification(projectId)
  emit({
    type: 'fix_loop_verify_done',
    round: 0,
    passed: snapshot.passed,
    failedChecks: snapshot.checks
      .filter(c => !c.passed && !c.skipped)
      .map(c => ({ id: c.id, name: c.name, error: c.error })),
    skippedChecks: snapshot.checks
      .filter(c => c.skipped)
      .map(c => ({ id: c.id, name: c.name, reason: c.skipReason })),
  })

  // Even when behavioral verification passes, /scan may still have actionable
  // findings (missing APIs, weak RLS, unwired integrations, missing indexes).
  // Only exit early when BOTH behavioral checks pass AND scan has no
  // auto-fixable candidates — otherwise fall through to the round loop so
  // the scan-derived candidates get applied.
  if (snapshot.passed) {
    const initialScanCandidates = await harvestScanFixes(projectId)
      .then(h => h.candidates.length)
      .catch(() => 0)
    if (initialScanCandidates === 0) {
      // Do not claim verification that did not happen. `passed` is true when
      // every check skipped (empty project: no tables, no auth, no triggers),
      // and telling the user their backend "already passes" in that state is the
      // same false confidence the loop is supposed to eliminate.
      const summary = snapshot.verdict === 'nothing_to_verify'
        ? 'Nothing to verify yet — no tables, auth or triggers exist to exercise, so no behavioral checks could run.'
        : 'Backend already passes behavioral verification — nothing to fix.'
      emit({ type: 'fix_loop_complete', success: true, rounds: 0, reason: 'no_initial_failures', summary })
      return { passed: true, rounds: 0, reason: 'no_initial_failures' as const, finalCheckSnapshot: snapshot, appliedFixes: 0, summary }
    }
  }

  // ── Iterative rounds ───────────────────────────────────────────────────────
  let appliedTotal = 0
  let authoredTotal = 0
  let prevFailures = countFailures(snapshot.checks)
  let prevFailedKey = failedKey(snapshot.checks)

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) {
      const summary = `Cancelled at round ${round - 1}. Applied ${appliedTotal} fix(es) so far.`
      emit({ type: 'fix_loop_complete', success: false, rounds: round - 1, reason: 'cancelled', summary })
      return { passed: false, rounds: round - 1, reason: 'cancelled' as const, finalCheckSnapshot: snapshot, appliedFixes: appliedTotal, summary }
    }

    // ── Phase A: drain HealthFindings queue (existing finding-based fixes) ──
    const openFindings = await prismaCountOpenFindings(projectId)
    if (openFindings > 0) {
      emit({ type: 'fix_loop_health_findings_start', round, openCount: openFindings })
      const results = await processOpenFindings(projectId).catch(() => [])
      const autoFixed = results.filter(r => r.outcome === 'auto_fixed').length
      const pending = results.filter(r => r.outcome === 'pending_approval').length
      const failed = results.filter(r => r.outcome === 'escalated').length
      appliedTotal += autoFixed
      emit({ type: 'fix_loop_health_findings_done', round, autoFixed, pending, failed })
    }

    // ── Phase A2: harvest scan-derived fix candidates ──────────────────────
    // Unifies /scan findings (production-intelligence + readiness + ledger +
    // integration-readiness + proof) with the behavioral fix-loop. Every
    // candidate is a typed AIAction that flows through the same executor +
    // governance kernel as Phase B's behavioral candidates.
    //
    // Why this exists: prior to this, /scan reported issues the fix-loop had
    // no way to address — the two systems spoke different data models. This
    // bridge closes that gap. Findings without a safe deterministic mapping
    // are reported as `uncovered` and surfaced in the summary so the user
    // knows what still needs manual attention.
    const candidates: FixCandidate[] = []
    let scanUncovered: Awaited<ReturnType<typeof harvestScanFixes>>['uncovered'] = []
    try {
      const scanHarvest = await harvestScanFixes(projectId)
      scanUncovered = scanHarvest.uncovered
      if (scanHarvest.candidates.length > 0) {
        candidates.push(...scanHarvest.candidates)
      }
      emit({
        type: 'fix_loop_scan_harvest_done',
        round,
        candidates: scanHarvest.candidates.length,
        uncovered: scanHarvest.uncovered.length,
      })
    } catch {
      // Scan harvest failure is non-fatal — behavioral path below still runs.
    }

    // ── Phase B: triage behavioral failures → curated fixes ─────────────────
    const uncoveredChecks: BehavioralCheck[] = []
    for (const check of snapshot.checks) {
      if (check.passed || check.skipped) continue
      const fromRegistry = mapCheckToFixes(check)
      if (fromRegistry.length > 0) {
        candidates.push(...fromRegistry)
      } else {
        uncoveredChecks.push(check)
      }
    }

    // ── Phase B′: Bounded Agency — Fix Author for uncovered failures ─────────
    // When ENABLE_AGENTIC_FIX_AUTHOR is on, the agent gets to propose ONE
    // fix per failing check the curated registry can't address. The author
    // is constrained to the safe-action whitelist and routes through the
    // same executor + governance kernel as every other fix.
    if (FLAGS.ENABLE_AGENTIC_FIX_AUTHOR && uncoveredChecks.length > 0) {
      for (const check of uncoveredChecks) {
        if (signal?.aborted) break
        if (authoredTotal >= MAX_AUTHORED_FIXES_PER_BUILD) break

        const authored = await authorFixForCheck({
          check,
          projectId,
          authoredSoFar: authoredTotal,
          signal,
        })

        if (authored.candidate) {
          authoredTotal++
          candidates.push(authored.candidate)
          emit({
            type: 'fix_loop_agent_proposed_fix',
            round,
            sourceCheckId: check.id,
            action: authored.candidate.action,
            reason: authored.candidate.reason,
            requiresApproval: !!authored.candidate.requiresApproval,
          })
        }
        // When the author declined or fell back, the deterministic
        // `fix_loop_no_fixes` event below still fires so the user sees
        // these as remaining failures.
      }
    }

    // De-dupe by (action, sourceCheckId) so we don't apply the same fix twice
    const seen = new Set<string>()
    const dedupedCandidates = candidates.filter(c => {
      const k = `${c.action}::${c.sourceCheckId}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    if (dedupedCandidates.length === 0) {
      emit({
        type: 'fix_loop_no_fixes',
        round,
        reason: 'No curated fix mapping for the remaining failures. They require manual review.',
      })
    }

    // ── Phase C: apply each candidate fix ──────────────────────────────────
    let appliedThisRound = 0
    for (const fix of dedupedCandidates) {
      if (signal?.aborted) break

      if (fix.requiresApproval) {
        emit({
          type: 'fix_loop_fix_needs_approval',
          round,
          fix: { id: fix.id, action: fix.action, reason: fix.reason },
        })
        continue
      }

      emit({
        type: 'fix_loop_fix_start',
        round,
        fix: { id: fix.id, action: fix.action, reason: fix.reason, sourceCheckId: fix.sourceCheckId },
      })

      const exec = await applyCandidate(fix, projectId)

      emit({
        type: 'fix_loop_fix_done',
        round,
        fix: { id: fix.id, action: fix.action, sourceCheckId: fix.sourceCheckId },
        success: exec.success,
        message: exec.message,
      })

      if (exec.success) {
        appliedThisRound++
        appliedTotal++
      }
    }

    // ── Phase D: re-verify ─────────────────────────────────────────────────
    emit({ type: 'fix_loop_verify_start', round })
    snapshot = await runBehavioralVerification(projectId)
    emit({
      type: 'fix_loop_verify_done',
      round,
      passed: snapshot.passed,
      failedChecks: snapshot.checks
        .filter(c => !c.passed && !c.skipped)
        .map(c => ({ id: c.id, name: c.name, error: c.error })),
      skippedChecks: snapshot.checks
        .filter(c => c.skipped)
        .map(c => ({ id: c.id, name: c.name, reason: c.skipReason })),
    })

    if (snapshot.passed) {
      const summary = snapshot.verdict === 'nothing_to_verify'
        ? `Applied ${appliedTotal} fix(es) in ${round} round(s). No behavioral checks were applicable, so this is not a confirmation that the backend behaves correctly.`
        : `All ${snapshot.checksRun} applicable check(s) pass. Fixed in ${round} round(s) by applying ${appliedTotal} fix(es).`
      emit({ type: 'fix_loop_complete', success: true, rounds: round, reason: 'passed', summary })
      return { passed: true, rounds: round, reason: 'passed' as const, finalCheckSnapshot: snapshot, appliedFixes: appliedTotal, summary }
    }

    // ── Phase E: progress check ────────────────────────────────────────────
    const currFailures = countFailures(snapshot.checks)
    const currFailedKey = failedKey(snapshot.checks)
    const sameSet = currFailedKey === prevFailedKey
    const noProgress = appliedThisRound === 0 && sameSet

    if (noProgress) {
      const summary = renderTerminalSummary(snapshot, appliedTotal, round, 'no_progress')
      emit({ type: 'fix_loop_complete', success: false, rounds: round, reason: 'no_progress', summary })
      return { passed: false, rounds: round, reason: 'no_progress' as const, finalCheckSnapshot: snapshot, appliedFixes: appliedTotal, summary }
    }

    prevFailures = currFailures
    prevFailedKey = currFailedKey
  }

  // Max rounds exhausted
  const summary = renderTerminalSummary(snapshot, appliedTotal, maxRounds, 'max_rounds')
  emit({ type: 'fix_loop_complete', success: false, rounds: maxRounds, reason: 'max_rounds', summary })
  return { passed: false, rounds: maxRounds, reason: 'max_rounds' as const, finalCheckSnapshot: snapshot, appliedFixes: appliedTotal, summary }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function countFailures(checks: BehavioralCheck[]): number {
  return checks.filter(c => !c.passed && !c.skipped).length
}

function failedKey(checks: BehavioralCheck[]): string {
  return checks
    .filter(c => !c.passed && !c.skipped)
    .map(c => c.id)
    .sort()
    .join('|')
}

async function applyCandidate(
  fix: FixCandidate,
  projectId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const governed = await withBuildLock(projectId, 'modify', async () =>
      executeAction(
        { action: fix.action as AIAction['action'], params: fix.params } as AIAction,
        projectId,
      ),
    )
    if (governed.error) {
      return { success: false, message: governed.error }
    }
    const r = governed.result
    if (!r) return { success: false, message: 'Executor returned no result.' }
    return {
      success: !!r.success,
      message: r.message || (r.success ? 'Fix applied.' : (r.error ?? 'Fix failed.')),
    }
  } catch (err: any) {
    return { success: false, message: `Fix threw: ${err?.message ?? String(err)}` }
  }
}

async function prismaCountOpenFindings(projectId: string): Promise<number> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    return prisma.healthFinding.count({ where: { projectId, status: 'open' } })
  } catch {
    return 0
  }
}

function renderTerminalSummary(
  snapshot: BehavioralVerificationResult,
  appliedTotal: number,
  rounds: number,
  reason: 'no_progress' | 'max_rounds',
): string {
  const failed = snapshot.checks.filter(c => !c.passed && !c.skipped)
  const passed = snapshot.checks.filter(c => c.passed && !c.skipped)
  const skipped = snapshot.checks.filter(c => c.skipped)

  const reasonText =
    reason === 'no_progress'
      ? "Stopped — last round made no measurable progress on the remaining failures."
      : `Reached the round budget (${rounds}). Some failures still need manual review.`

  const lines: string[] = [
    `**Agentic fix loop · ${rounds} round${rounds === 1 ? '' : 's'}, ${appliedTotal} fix${appliedTotal === 1 ? '' : 'es'} applied**`,
    '',
    reasonText,
    '',
  ]

  if (passed.length > 0) {
    lines.push(`**Passing (${passed.length}):**`)
    for (const c of passed) lines.push(`- ${c.name}`)
    lines.push('')
  }

  if (failed.length > 0) {
    lines.push(`**Still failing (${failed.length}):**`)
    for (const c of failed) {
      const short = (c.error ?? '').toString().split('\n')[0].slice(0, 160)
      lines.push(`- **${c.name}** — ${short}`)
    }
    lines.push('')
  }

  if (skipped.length > 0) {
    lines.push(`**Skipped (${skipped.length}):**`)
    for (const c of skipped) lines.push(`- ${c.name} — ${c.skipReason ?? 'not applicable'}`)
  }

  return lines.join('\n').trim()
}
