/**
 * SELFOPS-BENCH — the runner
 * ==========================
 *
 * One case is one experiment, and the experiment is only valid if each step is
 * proven rather than assumed:
 *
 *   1. BUILD a correct backend, then observe it. If the oracle does not read
 *      clean here, the fixture is wrong and the case is void — not a pass.
 *      Skipping this check is how a suite ends up "healing" backends that were
 *      never broken.
 *
 *   2. INJECT the fault, then observe again. If the backend still reads clean,
 *      the injection did not take. That is `never_faulted`, and it is scored as
 *      a void case, never as a success. A benchmark that counts failed
 *      injections as passes is a benchmark that improves when it breaks.
 *
 *   3. CYCLE the platform's loop, observing between every cycle, until the
 *      oracle reads healthy or the budget runs out.
 *
 *   4. GRADE from the final observation only. The platform's own opinion of
 *      what it repaired is recorded in the trace for the reader, and is not an
 *      input to the verdict.
 *
 * ── Stall detection ─────────────────────────────────────────────────────────
 *
 * A loop that has stopped acting will not start again on cycle 40 if it did
 * nothing on cycles 5 through 12. Running the full budget anyway would multiply
 * suite runtime for no information, so a case ends early once the loop has been
 * idle — no repairs, no new findings — for `STALL_CYCLES` consecutive cycles.
 * The result records that it ended on a stall rather than on the budget, since
 * "gave up after 3 idle cycles" and "still trying at cycle 40" are different
 * claims about a platform.
 */

import type {
  CaseResult,
  FaultCase,
  LaneAdapter,
  Observation,
  TickResult,
} from './types'
import { verdictFor } from './types'

/** Cycles a case gets before it is declared unhealed. */
export const DEFAULT_MAX_CYCLES = 12

/** Consecutive idle cycles after which the loop is considered to have stopped. */
export const STALL_CYCLES = 4

export interface RunOptions {
  maxCycles?: number
  /** Called after every cycle so a long run is not silent. */
  onProgress?: (caseId: string, cycle: number, tick: TickResult) => void
}

const healthy = (o: Observation): boolean => !o.vulnerable && o.functional

/** Flatten any thrown value into something a reader of the receipt can act on. */
function describeError(err: any): string {
  if (!err) return 'unknown error (nothing was thrown)'
  const parts = [
    err.name && err.name !== 'Error' ? err.name : null,
    err.code ? `[${err.code}]` : null,
    err.message || null,
    // Prisma surfaces the useful detail here when `message` is empty.
    err.meta ? `meta=${JSON.stringify(err.meta)}` : null,
    err.detail || null,
  ].filter(Boolean)
  const head = parts.length ? parts.join(' ') : String(err)
  const frame = typeof err.stack === 'string'
    ? err.stack.split('\n').slice(1, 3).map((s: string) => s.trim()).join(' <- ')
    : ''
  return frame ? `${head} (${frame})` : head
}

export async function runCase(
  fault: FaultCase,
  lane: LaneAdapter,
  options: RunOptions = {},
): Promise<CaseResult> {
  const maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES

  const base: CaseResult = {
    caseId: fault.id,
    lane: lane.name,
    task: fault.task,
    scope: fault.scope,
    severity: fault.severity,
    crossPlatform: fault.crossPlatform,
    verdict: 'harness_error',
    before: null,
    after: null,
    ticksToDetect: null,
    ticksToRepair: null,
    ticksRun: 0,
    fixesApplied: 0,
    escalations: 0,
    tokensSpent: 0,
    trace: [],
  }

  let ctx: Awaited<ReturnType<LaneAdapter['provision']>> | null = null

  try {
    ctx = await lane.provision()

    // ── 1. The fixture must start clean ──────────────────────────────────────
    await fault.setup(ctx)
    const baseline = await fault.observe(ctx)
    if (!healthy(baseline)) {
      return {
        ...base,
        before: baseline,
        error:
          `Fixture did not start healthy (vulnerable=${baseline.vulnerable} ` +
          `functional=${baseline.functional}): ${baseline.evidence}. The case cannot ` +
          `attribute anything to the injection, so it is void rather than failed.`,
      }
    }

    // ── 2. The injection must actually break something ───────────────────────
    await fault.inject(ctx)
    const before = await fault.observe(ctx)
    if (healthy(before)) {
      return {
        ...base,
        before,
        verdict: 'never_faulted',
        error:
          `Injection left the backend healthy: ${before.evidence}. Scored as void — ` +
          `a case whose fault never existed must never count as a repair.`,
      }
    }

    // ── 3. Cycle the loop ────────────────────────────────────────────────────
    const trace: TickResult[] = []
    let ticksToDetect: number | null = null
    let ticksToRepair: number | null = null
    let fixesApplied = 0
    let escalations = 0
    let tokensSpent = 0
    let idleCycles = 0
    let lastFindings = -1
    let after: Observation = before

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      const tick = await lane.tick(ctx)
      trace.push(tick)
      options.onProgress?.(fault.id, cycle, tick)

      fixesApplied += tick.applied
      escalations += tick.escalated
      tokensSpent += tick.tokensSpent

      // Detection = the platform demonstrably located the fault this cycle.
      //
      // This was originally `openFindings > 0` alone, and that was a measurement
      // bug, caught only by running on a second architecture. `openFindings` is
      // sampled AFTER the cycle returns, so when the loop raises a finding,
      // repairs it, and reaps it all within one cycle, the count reads zero and
      // detection is never recorded — for a fault that was visibly repaired.
      //
      // It produced an impossible row: `rls-engine-dialect-mismatch` reported
      // `detect=- repair=2` on Linux while reporting `detect=1` on Windows, from
      // the same code against the same corpus. Nothing can be repaired without
      // first being found, so a metric that says otherwise is measuring its own
      // sampling window.
      //
      // An attempted repair is proof of detection, so it counts. This makes the
      // detection number timing-independent rather than a race against the
      // finding reaper.
      const located = tick.openFindings > 0 || tick.attempted > 0 || tick.applied > 0
      if (ticksToDetect === null && located) ticksToDetect = cycle

      after = await fault.observe(ctx)
      if (healthy(after)) {
        ticksToRepair = cycle
        break
      }

      const idle =
        tick.applied === 0 && tick.attempted === 0 && tick.openFindings === lastFindings
      idleCycles = idle ? idleCycles + 1 : 0
      lastFindings = tick.openFindings
      if (idleCycles >= STALL_CYCLES) break
    }

    return {
      ...base,
      verdict: verdictFor(after),
      before,
      after,
      ticksToDetect,
      ticksToRepair,
      ticksRun: trace.length,
      fixesApplied,
      escalations,
      tokensSpent,
      trace,
    }
  } catch (err: any) {
    // Capture enough to diagnose from the receipt alone. Prisma and pg both
    // throw errors whose `message` can be empty while `code` and the stack
    // carry the whole story, and a published result file that says only
    // `"error": ""` is worse than no result file.
    return { ...base, error: describeError(err) }
  } finally {
    if (ctx) await lane.teardown(ctx).catch(() => {})
  }
}

export async function runSuite(
  cases: FaultCase[],
  lane: LaneAdapter,
  options: RunOptions = {},
): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  for (const fault of cases) {
    results.push(await runCase(fault, lane, options))
  }
  return results
}
