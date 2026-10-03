/**
 * The rehearsal launcher's whole AWS conversation, pinned.
 *
 * Each scenario runs the real launcher in a child process with the `aws` binary
 * replaced by canned responses, and compares exit code, output and the ordered
 * argv of every AWS call against a recorded transcript. The transcript was first
 * recorded from the launcher as it stood at bb52ff44, before the staging
 * mechanics moved into scripts/lib/staging-fargate-task.ts, so a refactor that
 * changes a guard, a refusal or the registered task shape fails here.
 *
 * Changing behaviour on purpose means re-recording with record.cjs and saying
 * why in the commit that does it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runScenario, ROOT } = require('./fixtures/staging-fargate-launcher/run-scenario.cjs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scenarios: Array<{ name: string }> = require('./fixtures/staging-fargate-launcher/scenarios.cjs')

const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'staging-fargate-launcher', 'rehearsal-launcher.transcripts.json'), 'utf8'),
)
const LAUNCHER = join(ROOT, 'scripts', 'run-rds-rehearsal-fargate.ts')

describe('rehearsal launcher transcript', () => {
  it('has a recorded transcript for every scenario', () => {
    expect(Object.keys(golden.transcripts).sort()).toEqual(scenarios.map(s => s.name).sort())
  })

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      expect(runScenario(LAUNCHER, scenario)).toEqual(golden.transcripts[scenario.name])
    }, 60_000)
  }
})
