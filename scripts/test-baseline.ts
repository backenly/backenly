#!/usr/bin/env tsx
/**
 * Test-failure baseline: catch NEW failures, not a failure COUNT.
 *
 * The repository has 156 jest suites. CI runs 134 of them on blocking jobs and
 * is green, so for those a regression already fails CI by construction. The
 * other 22 are named in .github/suites-not-in-ci.txt and each one currently
 * fails, which means they are exactly where a regression can hide: nothing
 * watches a suite that is already red.
 *
 * Comparing totals cannot see that. "259 before, 259 after" is equally true of
 * a refactor that broke nothing and one that fixed nine tests while breaking
 * nine others. So the baseline records every failing test BY NAME.
 *
 * Environment tolerance is the other half. A suite that cannot run here (no
 * database, no live model provider, no HTTP server) must never be reported as
 * a regression, or the baseline becomes machine-specific and gets ignored. So
 * `check` only compares suites present in BOTH the baseline and the current
 * run, and reports coverage changes separately from regressions.
 *
 * Usage:
 *   npx jest <selection> --ci --json --outputFile=report.json || true
 *   tsx scripts/test-baseline.ts capture report.json [more.json ...]
 *   tsx scripts/test-baseline.ts check   report.json [more.json ...]
 *
 * Note the `|| true`: jest exits non-zero when tests fail, which is the normal
 * case here. The report is still written.
 *
 * MEASURE SUITES THE WAY CI RUNS THEM, which for these means one at a time.
 * Multiple report files are accepted and merged for exactly this reason. A
 * single monolithic `npx jest` run is NOT a valid source: 167 suites sharing
 * one database, several of which create and drop schemas, seed findings and
 * VACUUM, interfere with each other badly enough to invent failures wholesale.
 * Measured here: tests/probes/rls-isolation.spec.ts reported 11 failures in a
 * combined run and passes 11/11 alone, and three suites reported 61 failures
 * between them while passing completely in isolation. A baseline built from
 * that run would have recorded the RLS isolation probes and the autonomy
 * engine as known-broken, which is precisely the coverage this file exists to
 * protect.
 */
import * as fs from 'fs'
import * as path from 'path'

const BASELINE_PATH = path.join(process.cwd(), 'tests', 'baseline-failures.json')

/** A suite that threw before any test could run (bad import, dead database). */
const SUITE_FAILED_TO_RUN = '__SUITE_FAILED_TO_RUN__'

/**
 * Directories whose contents are never a real suite, enforced HERE rather than
 * left to the caller's shell.
 *
 * `.next/standalone` holds a full copy of the test tree (173 files) because the
 * build output bundles it. Passing `--testPathIgnorePatterns "/.next/"` through
 * Git Bash silently fails: MSYS rewrites the leading-slash pattern into a
 * Windows path that matches nothing, so jest happily runs the stale duplicates
 * and they get captured as if they were real suites. That contaminated a
 * baseline once. A shell-quoting accident must not be able to decide what the
 * regression net covers, so the check lives in the tool.
 */
const NEVER_A_SUITE = ['.next/', 'node_modules/', 'workspace/']

interface Baseline {
  generatedAt: string
  note: string
  /** suite path (repo-relative, forward slashes) -> sorted failing test names */
  failures: Record<string, string[]>
}

interface JestAssertion {
  fullName?: string
  title?: string
  status?: string
}

interface JestSuite {
  name?: string
  testFilePath?: string
  status?: string
  message?: string
  assertionResults?: JestAssertion[]
}

/**
 * Absolute Windows paths in a committed file would make the baseline
 * unreadable on any other machine, so normalise to repo-relative POSIX.
 */
function relSuite(suite: JestSuite): string {
  const raw = suite.name || suite.testFilePath || 'unknown'
  const abs = raw.replace(/\\/g, '/')
  const root = process.cwd().replace(/\\/g, '/')
  return abs.startsWith(root) ? abs.slice(root.length).replace(/^\/+/, '') : abs
}

function readReport(file: string): JestSuite[] {
  let parsed: { testResults?: JestSuite[] }
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`could not read jest report at ${file}: ${(err as Error).message}`)
    console.error('generate one with: npx jest <selection> --ci --json --outputFile=<file>')
    process.exit(2)
  }
  const suites = parsed.testResults
  if (!Array.isArray(suites) || suites.length === 0) {
    console.error(`jest report at ${file} contains no suites`)
    process.exit(2)
  }

  // Refuse a contaminated report outright. Filtering the offenders out would be
  // worse: the run that produced them also spent its time on them, so the set
  // that actually executed is not the set anyone intended, and a baseline built
  // from it would quietly under-cover the real tree.
  const contaminated = suites
    .map(relSuite)
    .filter(p => NEVER_A_SUITE.some(dir => p.startsWith(dir) || p.includes(`/${dir}`)))
  if (contaminated.length > 0) {
    console.error(`jest report at ${file} includes ${contaminated.length} path(s) that are not real suites:`)
    for (const p of contaminated.slice(0, 5)) console.error(`  - ${p}`)
    if (contaminated.length > 5) console.error(`  ... and ${contaminated.length - 5} more`)
    console.error('')
    console.error('These live under a build-output or dependency directory. Re-run jest')
    console.error('without overriding testPathIgnorePatterns; jest.config.js already')
    console.error('excludes them, and overriding it from Git Bash silently does not.')
    process.exit(2)
  }

  return suites
}

/** suite path -> failing test names. Suites with zero failures are omitted. */
function extractFailures(suites: JestSuite[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const suite of suites) {
    const key = relSuite(suite)
    const tests = suite.assertionResults || []
    const failed = tests
      .filter(t => t.status === 'failed')
      .map(t => t.fullName || t.title || '<unnamed test>')

    // No assertions at all plus a failed suite status means the file threw on
    // import. That is one fact, not zero failures, and it must be recorded or
    // a suite that stops loading entirely would read as an improvement.
    if (tests.length === 0 && suite.status === 'failed') {
      out[key] = [SUITE_FAILED_TO_RUN]
      continue
    }
    if (failed.length > 0) out[key] = failed.sort()
  }
  return out
}

/** Every suite the report covers, failing or not. Defines comparison scope. */
function suitesInReport(suites: JestSuite[]): Set<string> {
  return new Set(suites.map(relSuite))
}

function loadBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`no baseline at ${path.relative(process.cwd(), BASELINE_PATH)}`)
    console.error('create one with: tsx scripts/test-baseline.ts capture <jest-json>')
    process.exit(2)
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(failures: Record<string, string[]>): void {
  const ordered: Record<string, string[]> = {}
  for (const key of Object.keys(failures).sort()) ordered[key] = failures[key]

  const baseline: Baseline = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note:
      'Known-failing tests, by name. Regenerate ONLY when a failure is ' +
      'deliberately accepted or genuinely fixed, never to make a red check ' +
      'green. See scripts/test-baseline.ts.',
    failures: ordered,
  }
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8')

  const suiteCount = Object.keys(ordered).length
  const testCount = Object.values(ordered).reduce((n, v) => n + v.length, 0)
  console.log(`baseline written: ${testCount} known failure(s) across ${suiteCount} suite(s)`)
  console.log(path.relative(process.cwd(), BASELINE_PATH))
}

function check(suites: JestSuite[]): void {
  const current = extractFailures(suites)
  const ran = suitesInReport(suites)
  const baseline = loadBaseline()

  const regressions: string[] = []
  const fixed: string[] = []

  // Regressions: failing now, not known-failing in the baseline.
  for (const [suite, tests] of Object.entries(current)) {
    const known = new Set(baseline.failures[suite] || [])
    for (const t of tests) {
      if (!known.has(t)) regressions.push(`${suite}\n      ${t}`)
    }
  }

  // Fixes: known-failing, and the suite ran this time without that failure.
  // Restricted to suites that actually ran, so a narrower selection is never
  // misreported as having fixed everything it did not execute.
  for (const [suite, tests] of Object.entries(baseline.failures)) {
    if (!ran.has(suite)) continue
    const nowFailing = new Set(current[suite] || [])
    for (const t of tests) {
      if (!nowFailing.has(t)) fixed.push(`${suite}\n      ${t}`)
    }
  }

  const notRun = Object.keys(baseline.failures).filter(s => !ran.has(s))

  console.log(`compared ${ran.size} suite(s) against the baseline`)
  if (notRun.length > 0) {
    console.log(
      `${notRun.length} baseline suite(s) did not run in this selection and were skipped`
    )
  }

  if (fixed.length > 0) {
    console.log('')
    console.log(`${fixed.length} baseline failure(s) now PASS:`)
    for (const f of fixed) console.log(`  - ${f}`)
    console.log('')
    console.log('Good news. Re-capture so the baseline cannot drift back:')
    console.log('  tsx scripts/test-baseline.ts capture <jest-json>')
  }

  if (regressions.length > 0) {
    console.error('')
    console.error(`${regressions.length} NEW test failure(s) not in the baseline:`)
    for (const r of regressions) console.error(`  - ${r}`)
    console.error('')
    console.error('These were not failing when the baseline was captured.')
    console.error('Fix them. Do not re-capture the baseline to bury them.')
    process.exit(1)
  }

  console.log('')
  console.log('no new test failures')
}

/**
 * Merge several jest reports into one suite list. A suite appearing twice is a
 * mistake worth stopping on, not something to silently last-write-wins: the two
 * runs can disagree, and picking one arbitrarily is how a real failure gets
 * dropped.
 */
function readReports(files: string[]): JestSuite[] {
  const merged: JestSuite[] = []
  const seen = new Map<string, string>()
  for (const file of files) {
    for (const suite of readReport(file)) {
      const key = relSuite(suite)
      const prior = seen.get(key)
      if (prior) {
        console.error(`suite appears in two reports: ${key}`)
        console.error(`  ${prior}`)
        console.error(`  ${file}`)
        console.error('Merge inputs must not overlap, or the recorded result is arbitrary.')
        process.exit(2)
      }
      seen.set(key, file)
      merged.push(suite)
    }
  }
  return merged
}

function main(): void {
  const [mode, ...reportFiles] = process.argv.slice(2)
  if (!mode || reportFiles.length === 0 || (mode !== 'capture' && mode !== 'check')) {
    console.error('usage: tsx scripts/test-baseline.ts <capture|check> <jest-json-file> [more.json ...]')
    process.exit(2)
  }
  const suites = readReports(reportFiles)
  if (mode === 'capture') writeBaseline(extractFailures(suites))
  else check(suites)
}

main()
