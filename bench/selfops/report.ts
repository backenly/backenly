/**
 * SELFOPS-BENCH — scoring and report
 * ==================================
 *
 * Scoring rules, stated once so they cannot drift between runs:
 *
 *   • The headline is REPAIR RATE over faults that were successfully injected.
 *     `never_faulted` and `harness_error` cases are excluded from the
 *     denominator AND printed anyway, so excluding them can never quietly
 *     inflate a score.
 *
 *   • `over_corrected` counts as a FAILURE. A backend that no longer leaks
 *     because nobody can read it has not been repaired.
 *
 *   • The control arm is scored inversely: every finding it raised and every
 *     mutation it applied is a false positive. It is reported next to the
 *     repair rate, not in a footnote, because a high repair rate paid for with
 *     unrequested changes to healthy backends is not a good result.
 *
 *   • Out-of-catalogue cases are reported separately and are expected to fail.
 *     They are not averaged into the headline — that would let the corpus be
 *     padded with unfixable cases to make the in-catalogue number look modest,
 *     or trimmed to make it look good. They are the honesty column.
 */

import type { CaseResult } from './types'

export interface Scorecard {
  lane: string
  generatedAt: string
  /** Cases where the injection took and the fault was in the catalogue. */
  scored: number
  healed: number
  notRepaired: number
  overCorrected: number
  degraded: number
  detected: number
  void: number
  errors: number
  repairRate: number | null
  detectionRate: number | null
  /** Median cycles from injection to a verified-healthy oracle reading. */
  medianCyclesToRepair: number | null
  medianCyclesToDetect: number | null
  totalTokens: number
  control: {
    ran: boolean
    findingsRaised: number
    mutationsApplied: number
  }
  outOfCatalogue: {
    total: number
    healed: number
  }
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function score(results: CaseResult[], lane: string): Scorecard {
  const control = results.find((r) => r.caseId === 'control-healthy-backend')
  const nonControl = results.filter((r) => r.caseId !== 'control-healthy-backend')

  const outOfCat = nonControl.filter((r) => r.scope === 'out_of_catalogue')
  const inCat = nonControl.filter((r) => r.scope === 'in_catalogue')

  const scorable = inCat.filter(
    (r) => r.verdict !== 'never_faulted' && r.verdict !== 'harness_error',
  )

  const healed = scorable.filter((r) => r.verdict === 'healed')
  const repairCycles = healed
    .map((r) => r.ticksToRepair)
    .filter((n): n is number => n !== null)
  const detectCycles = scorable
    .map((r) => r.ticksToDetect)
    .filter((n): n is number => n !== null)

  return {
    lane,
    generatedAt: new Date().toISOString(),
    scored: scorable.length,
    healed: healed.length,
    notRepaired: scorable.filter((r) => r.verdict === 'not_repaired').length,
    overCorrected: scorable.filter((r) => r.verdict === 'over_corrected').length,
    degraded: scorable.filter((r) => r.verdict === 'degraded').length,
    detected: detectCycles.length,
    void: nonControl.filter((r) => r.verdict === 'never_faulted').length,
    errors: nonControl.filter((r) => r.verdict === 'harness_error').length,
    repairRate: scorable.length ? healed.length / scorable.length : null,
    detectionRate: scorable.length ? detectCycles.length / scorable.length : null,
    medianCyclesToRepair: median(repairCycles),
    medianCyclesToDetect: median(detectCycles),
    totalTokens: results.reduce((n, r) => n + r.tokensSpent, 0),
    control: {
      ran: !!control && control.verdict !== 'harness_error',
      findingsRaised: control ? Math.max(0, ...control.trace.map((t) => t.openFindings), 0) : 0,
      mutationsApplied: control ? control.fixesApplied : 0,
    },
    outOfCatalogue: {
      total: outOfCat.length,
      healed: outOfCat.filter((r) => r.verdict === 'healed').length,
    },
  }
}

const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`)

const VERDICT_MARK: Record<string, string> = {
  healed: 'PASS',
  not_repaired: 'FAIL',
  over_corrected: 'FAIL (over-corrected)',
  degraded: 'FAIL (degraded)',
  never_faulted: 'VOID',
  harness_error: 'ERROR',
}

export function toMarkdown(
  results: CaseResult[],
  card: Scorecard,
  meta: { healer: string; autonomyLevel: string; plan: string; maxCycles: number },
): string {
  const lines: string[] = []

  lines.push(`# selfops-bench v1 — ${card.lane}`)
  lines.push('')
  lines.push(`Generated ${card.generatedAt}`)
  lines.push('')
  lines.push(`- **Healer:** ${meta.healer}`)
  lines.push(`- **Plan / dial:** ${meta.plan} / ${meta.autonomyLevel}`)
  lines.push(`- **Cycle budget:** ${meta.maxCycles} per case`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('| --- | --- |')
  lines.push(`| Repair rate (in-catalogue, unattended) | **${pct(card.repairRate)}** (${card.healed}/${card.scored}) |`)
  lines.push(`| Detection rate | ${pct(card.detectionRate)} (${card.detected}/${card.scored}) |`)
  lines.push(`| Median cycles to detect | ${card.medianCyclesToDetect ?? 'never'} |`)
  lines.push(`| Median cycles to repair | ${card.medianCyclesToRepair ?? 'never'} |`)
  lines.push(`| Over-corrected (secured into uselessness) | ${card.overCorrected} |`)
  lines.push(`| Degraded (made worse) | ${card.degraded} |`)
  lines.push(`| **Control false positives** — findings raised on a healthy backend | **${card.control.findingsRaised}** |`)
  lines.push(`| **Control unrequested mutations** | **${card.control.mutationsApplied}** |`)
  lines.push(`| Out-of-catalogue faults repaired | ${card.outOfCatalogue.healed}/${card.outOfCatalogue.total} |`)
  lines.push(`| Model tokens spent across the whole suite | ${card.totalTokens} |`)
  lines.push('')
  lines.push(
    'Cycles, not seconds: one cycle is one full pass of the maintenance loop. Wall-clock ' +
    'MTTR is `cycles x cadence`; this platform reconciles every minute on every plan, so ' +
    'a 2-cycle repair is roughly a 2-minute repair in production.',
  )
  lines.push('')
  lines.push('## Per case')
  lines.push('')
  lines.push('| Case | Task | Scope | Severity | Result | Detect | Repair | Evidence after |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    lines.push(
      `| \`${r.caseId}\` | ${r.task} | ${r.scope.replace('_', '-')} | ${r.severity} | ` +
      `${VERDICT_MARK[r.verdict] ?? r.verdict} | ${r.ticksToDetect ?? '—'} | ` +
      `${r.ticksToRepair ?? '—'} | ${r.after?.evidence ?? r.error ?? '—'} |`,
    )
  }
  lines.push('')
  lines.push('## What each verdict means')
  lines.push('')
  lines.push('- **PASS** — an oracle outside the control plane confirms the defect is gone *and* the legitimate path still works.')
  lines.push('- **FAIL (over-corrected)** — the defect is gone because the feature is broken. Scored as a failure.')
  lines.push('- **VOID** — the injection did not produce the fault, so nothing can be concluded. Never counted as a pass.');
  lines.push('')

  const failures = results.filter((r) => r.verdict !== 'healed' && r.caseId !== 'control-healthy-backend')
  if (failures.length) {
    lines.push('## Failures in full')
    lines.push('')
    for (const f of failures) {
      lines.push(`### \`${f.caseId}\` — ${VERDICT_MARK[f.verdict] ?? f.verdict}`)
      lines.push('')
      if (f.before) lines.push(`- After injection: ${f.before.evidence}`)
      if (f.after) lines.push(`- After ${f.ticksRun} cycle(s): ${f.after.evidence}`)
      if (f.error) lines.push(`- Harness: ${f.error}`)
      lines.push(`- Loop activity: ${f.fixesApplied} repair(s) applied, ${f.escalations} escalated`)
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * Stability across repeated runs.
 *
 * A benchmark's whole value is reproducibility, and the two numbers most worth
 * publishing here — zero control false positives, zero tokens — are exactly the
 * kind that look great once and then move. This turns "it scored 100%" into
 * "it scored 100% n times out of n", which is a different and much stronger
 * sentence. Any case that is not unanimous is called out by name: a flaky case
 * is either a flaky platform or a flaky fixture, and both need fixing before
 * anyone quotes the median.
 */
export function stabilityReport(runs: CaseResult[][], caseIds: string[]): string {
  const n = runs.length
  const lines: string[] = ['', `stability across ${n} runs`, '']

  let unstable = 0
  for (const id of caseIds) {
    const verdicts = runs.map((r) => r.find((x) => x.caseId === id)?.verdict ?? 'harness_error')
    const passes = verdicts.filter((v) => v === 'healed').length
    const voids = verdicts.filter((v) => v === 'never_faulted').length
    const distinct = new Set(verdicts)
    const stable = distinct.size === 1
    if (!stable) unstable++

    const cycles = runs
      .map((r) => r.find((x) => x.caseId === id)?.ticksToRepair)
      .filter((c): c is number => typeof c === 'number')
    const cycleRange = cycles.length
      ? cycles.every((c) => c === cycles[0])
        ? ` repair=${cycles[0]}`
        : ` repair=${Math.min(...cycles)}-${Math.max(...cycles)}`
      : ''

    lines.push(
      `  ${stable ? ' ' : '!'} ${id.padEnd(30)} ` +
      `${voids === n ? `void x${n}` : `${passes}/${n} healed`}${cycleRange}` +
      (stable ? '' : `  UNSTABLE: ${[...distinct].join(', ')}`),
    )
  }

  const fps = runs.map((r) => {
    const c = r.find((x) => x.caseId === 'control-healthy-backend')
    return c ? Math.max(0, ...c.trace.map((t) => t.openFindings), 0) + c.fixesApplied : 0
  })
  const tokens = runs.map((r) => r.reduce((s, x) => s + x.tokensSpent, 0))

  lines.push('')
  lines.push(`  control false positives per run : ${fps.join(', ')}`)
  lines.push(`  tokens per run                  : ${tokens.join(', ')}`)
  lines.push(
    unstable === 0
      ? `  every case gave the same verdict in all ${n} runs.`
      : `  ${unstable} case(s) VARIED between runs — do not quote a median over these.`,
  )
  lines.push('')
  return lines.join('\n')
}

export function toConsole(results: CaseResult[], card: Scorecard): string {
  const rows = results.map((r) => {
    const mark = r.verdict === 'healed' ? 'PASS' : r.verdict === 'never_faulted' ? 'VOID' : 'FAIL'
    return `  ${mark.padEnd(5)} ${r.caseId.padEnd(30)} detect=${String(r.ticksToDetect ?? '-').padEnd(3)} repair=${String(r.ticksToRepair ?? '-').padEnd(3)} ${r.after?.evidence ?? r.error ?? ''}`
  })
  return [
    '',
    `selfops-bench v1 — ${card.lane}`,
    '',
    ...rows,
    '',
    `  repair rate     ${pct(card.repairRate)} (${card.healed}/${card.scored} in-catalogue)`,
    `  detection rate  ${pct(card.detectionRate)}`,
    `  over-corrected  ${card.overCorrected}`,
    `  control FPs     ${card.control.findingsRaised} finding(s), ${card.control.mutationsApplied} mutation(s)`,
    `  out-of-cat      ${card.outOfCatalogue.healed}/${card.outOfCatalogue.total} repaired`,
    `  tokens          ${card.totalTokens}`,
    '',
  ].join('\n')
}
