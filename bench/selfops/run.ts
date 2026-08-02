/**
 * SELFOPS-BENCH — CLI
 * ===================
 *
 *   npm run bench:selfops
 *   BENCH_DATABASE_URL=postgres://… npm run bench:selfops -- --cycles 20 --out results/
 *
 * Writes a JSON result set and a Markdown report. Both are meant to be
 * published together: the Markdown is the claim, the JSON is the receipt.
 *
 * SAFETY. Every case provisions its own throwaway user, project and workspace
 * schema, and drops them in a `finally`. It still creates real rows in whatever
 * database it points at, so it refuses to run against anything that looks like
 * production unless explicitly forced.
 */

// FIRST — pins DATABASE_URL for Prisma, the probe pools and every detector to
// the same instance the oracle grades. Must precede every other import.
import { assertNotProduction, redactedUrl } from './env'

import * as fs from 'fs'
import * as path from 'path'

import { CORPUS_V1 } from './corpus'
import { runSuite, DEFAULT_MAX_CYCLES } from './harness'
import { score, toMarkdown, toConsole, stabilityReport } from './report'
import type { CaseResult } from './types'
import { backenlyLane, laneInfo, disconnectLane } from './adapters/backenly'
import { closeOracle } from './oracle'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main(): Promise<void> {
  assertNotProduction()

  const maxCycles = Number(arg('cycles', String(DEFAULT_MAX_CYCLES)))
  const outDir = arg('out', path.join('bench', 'selfops', 'results'))!
  const only = arg('only')

  const cases = only ? CORPUS_V1.filter((c) => c.id === only) : CORPUS_V1
  if (cases.length === 0) {
    throw new Error(`No case matched --only ${only}. Known: ${CORPUS_V1.map((c) => c.id).join(', ')}`)
  }

  // A single run is an anecdote. `--repeat` exists so the headline can be a
  // claim: same corpus, fresh projects every time, and the spread reported
  // alongside the median. A metric that moves between runs is not a property of
  // the platform, and the only way to know which one you have is to repeat.
  const repeat = Math.max(1, Number(arg('repeat', '1')))

  console.log(
    `\nselfops-bench v1 — ${cases.length} case(s), ${maxCycles} cycle budget` +
    (repeat > 1 ? `, ${repeat} runs` : '') + `\n` +
    `database: ${redactedUrl()}\n`,
  )

  const runs: CaseResult[][] = []
  for (let r = 1; r <= repeat; r++) {
    if (repeat > 1) console.log(`\n── run ${r}/${repeat} ─────────────────────────────`)
    runs.push(
      await runSuite(cases, backenlyLane, {
        maxCycles,
        onProgress: (caseId, cycle, tick) => {
          const bits = [
            `findings=${tick.openFindings}`,
            `attempted=${tick.attempted}`,
            `applied=${tick.applied}`,
            tick.escalated ? `escalated=${tick.escalated}` : '',
            tick.note ? `(${tick.note})` : '',
          ].filter(Boolean)
          console.log(`  ${caseId} · cycle ${cycle} · ${bits.join(' ')}`)
        },
      }),
    )
  }

  // The last run is the one written out in full; stability is computed across all.
  const results = runs[runs.length - 1]
  const card = score(results, backenlyLane.name)
  console.log(toConsole(results, card))

  if (repeat > 1) {
    console.log(stabilityReport(runs, cases.map((c) => c.id)))
  }

  const meta = {
    healer: backenlyLane.healer,
    autonomyLevel: laneInfo.resolvedLevel,
    plan: laneInfo.plan,
    maxCycles,
  }

  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(outDir, `${backenlyLane.name}-${stamp}.json`)
  const mdPath = path.join(outDir, `${backenlyLane.name}-${stamp}.md`)

  fs.writeFileSync(jsonPath, JSON.stringify({ meta, card, results }, null, 2))
  fs.writeFileSync(mdPath, toMarkdown(results, card, meta))

  console.log(`  receipts: ${jsonPath}`)
  console.log(`            ${mdPath}\n`)

  // A harness error means the suite did not measure what it claims to measure.
  // Exit non-zero so CI cannot report a green run over a broken experiment.
  if (card.errors > 0) {
    console.error(`${card.errors} case(s) failed to run. The suite did not measure them.`)
    process.exitCode = 1
  }

  // `--require-healed` turns the suite from a report into a regression gate.
  //
  // Without it a case can go from PASS to FAIL and CI still reports green,
  // because an unrepaired fault is deliberately a result rather than a broken
  // build. That is the right default while a corpus still contains known
  // misses. It is the wrong default once a case passes: the two wide-open-RLS
  // repairs were shipped precisely because they were broken, and nothing would
  // have told us if they broke again.
  //
  // Named cases rather than a rate, so that widening the corpus with new
  // expected-to-fail cases can never silently lower the bar.
  const required = arg('require-healed')
  if (required) {
    const want = required.split(',').map((s) => s.trim()).filter(Boolean)
    const byId = new Map(results.map((r) => [r.caseId, r]))
    const regressed = want.filter((id) => byId.get(id)?.verdict !== 'healed')
    const unknown = want.filter((id) => !byId.has(id))

    if (unknown.length) {
      console.error(`--require-healed names case(s) this run did not execute: ${unknown.join(', ')}`)
      process.exitCode = 1
    }
    if (regressed.length) {
      for (const id of regressed) {
        console.error(
          `REGRESSION: ${id} is required to heal but returned ` +
          `${byId.get(id)?.verdict ?? 'no result'}.`,
        )
      }
      process.exitCode = 1
    }
    if (!regressed.length && !unknown.length) {
      console.log(`  ✓ all ${want.length} required case(s) healed\n`)
    }
  }
}

main()
  .catch((err) => {
    console.error(`\nselfops-bench failed: ${err?.message ?? err}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectLane()
    await closeOracle()
  })
