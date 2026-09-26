/**
 * Build the MCP acceptance matrix from results CI already produced.
 *
 *   npx tsx scripts/mcp-acceptance/matrix.ts \
 *     --unit jest-unit.json --integration jest-integration.json \
 *     --job mcp-server=success [--live acceptance-live.json] \
 *     [--require-all] --out acceptance-matrix
 *
 *   --unit / --integration  jest --json output of tests/unit and the database-backed suites
 *   --job name=result       a CI job's result (success | failure | cancelled | skipped)
 *   --live                  scripts/mcp-harness --json output from the final staging run;
 *                           turns the deferred cases it covers into PASS or FAIL
 *   --require-all           a source that was not supplied fails its cases (CI sets this)
 *
 * Writes <out>/acceptance-matrix.json and <out>/acceptance-matrix.md, prints the
 * counts, and exits 1 when any case is FAIL. The cases and their evidence are
 * scripts/mcp-acceptance/cases.ts; the rules are scripts/mcp-acceptance/evaluate.ts.
 */

import fs from 'fs'
import path from 'path'
import { ACCEPTANCE_CASES } from './cases'
import { evaluate, fromHarnessJson, fromJestJson, renderMarkdown, summarise, type Inputs } from './evaluate'

function parse(argv: string[]) {
  const out: { unit?: string; integration?: string; live?: string; out: string; requireAll: boolean; jobs: Record<string, string> } =
    { out: 'acceptance-matrix', requireAll: false, jobs: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--unit') out.unit = next()
    else if (a === '--integration') out.integration = next()
    else if (a === '--live') out.live = next()
    else if (a === '--out') out.out = next()
    else if (a === '--require-all') out.requireAll = true
    else if (a === '--job') {
      const [name, result] = String(next()).split('=')
      if (name && result) out.jobs[name] = result
    }
  }
  return out
}

function readJson(file: string | undefined, label: string, sources: string[]): any | null {
  if (!file) return null
  if (!fs.existsSync(file)) {
    console.warn(`  ${label}: ${file} does not exist; its cases are judged as not supplied`)
    return null
  }
  sources.push(`${label}=${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function main() {
  const args = parse(process.argv.slice(2))
  const sources: string[] = []
  const unit = readJson(args.unit, 'unit', sources)
  const integration = readJson(args.integration, 'integration', sources)
  const live = readJson(args.live, 'live', sources)
  for (const [job, result] of Object.entries(args.jobs)) sources.push(`job ${job}=${result}`)

  const inputs: Inputs = {
    jest: {
      ...(unit ? { unit: fromJestJson(unit) } : {}),
      ...(integration ? { integration: fromJestJson(integration) } : {}),
    },
    jobs: args.jobs,
    live: live ? fromHarnessJson(live) : null,
    requireAll: args.requireAll,
  }

  const outcomes = ACCEPTANCE_CASES.map((c) => evaluate(c, inputs))
  const counts = summarise(outcomes)

  fs.mkdirSync(args.out, { recursive: true })
  fs.writeFileSync(path.join(args.out, 'acceptance-matrix.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sources, counts, cases: outcomes }, null, 2))
  fs.writeFileSync(path.join(args.out, 'acceptance-matrix.md'), renderMarkdown(outcomes, sources))

  console.log(`\n  MCP acceptance matrix: ${outcomes.length} cases`)
  console.log(`  PASS ${counts.PASS} · FAIL ${counts.FAIL} · SKIP_WITH_REASON ${counts.SKIP_WITH_REASON} · DEFERRED_TO_FINAL_STAGING_RELEASE_GATE ${counts.DEFERRED_TO_FINAL_STAGING_RELEASE_GATE}`)
  for (const o of outcomes.filter((x) => x.status === 'FAIL')) console.log(`  FAIL  ${o.id}: ${o.detail}`)
  console.log(`  written to ${args.out}/\n`)
  process.exit(counts.FAIL > 0 ? 1 : 0)
}

main()
