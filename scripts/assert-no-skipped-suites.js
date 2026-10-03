#!/usr/bin/env node
/**
 * Fail a CI run whose "green" came from skipping.
 *
 * jest exits 0 for a suite that skipped every test in it, so a listed suite can
 * sit on a blocking job forever, reporting pass, asserting nothing. That is
 * worse than not listing it: the job spends its credibility vouching for
 * coverage that never ran.
 *
 * This nearly happened. suite1.core-integration and suite1.real-engine-integration
 * are gated on ENGINE_MODE=runtime, and jest.setup.js assigns
 * ENGINE_MODE='integration' for every suite, so both skip unconditionally. Both
 * exited 0 and were measured as passing before anyone looked at the assertion
 * count (#7).
 *
 * Usage: node scripts/assert-no-skipped-suites.js <jest --json output file>
 */
const fs = require('fs')

const file = process.argv[2]
if (!file) {
  console.error('usage: assert-no-skipped-suites.js <jest-json-file>')
  process.exit(2)
}

let report
try {
  report = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`could not read jest report at ${file}: ${err.message}`)
  process.exit(2)
}

const offenders = []
for (const suite of report.testResults || []) {
  const tests = suite.assertionResults || []
  if (tests.length === 0) continue

  const ran = tests.filter(t => t.status === 'passed' || t.status === 'failed')
  if (ran.length === 0) {
    const name = (suite.name || suite.testFilePath || 'unknown')
      .replace(/\\/g, '/')
      .replace(/^.*?\/(?=(__tests__|tests)\/)/, '')
    offenders.push(`${name} (${tests.length} test(s), none ran)`)
  }
}

if (offenders.length > 0) {
  console.error('')
  console.error('These suites are listed in CI but ran no assertions at all:')
  for (const o of offenders) console.error(`  - ${o}`)
  console.error('')
  console.error('A suite that skips itself cannot fail, so it cannot guard anything.')
  console.error('Either make it run, or move it to .github/suites-not-in-ci.txt')
  console.error('with the reason, so "not run" stays a decision someone made.')
  process.exit(1)
}

const total = (report.testResults || []).length
console.log(`no vacuous suites: all ${total} listed suite(s) ran at least one assertion`)
