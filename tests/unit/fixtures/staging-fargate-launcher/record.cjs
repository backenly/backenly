// Records launcher transcripts for every scenario.
//
//   node record.cjs <launcher.ts> <out.json> [--from <label>]
//
// The committed golden was recorded from the launcher as it stood before the
// shared staging module was extracted:
//
//   git show bb52ff44:scripts/run-rds-rehearsal-fargate.ts > /tmp/original.ts
//   node tests/unit/fixtures/staging-fargate-launcher/record.cjs /tmp/original.ts \
//     tests/unit/fixtures/staging-fargate-launcher/rehearsal-launcher.transcripts.json --from bb52ff44

const fs = require('node:fs')
const { runScenario } = require('./run-scenario.cjs')
const scenarios = require('./scenarios.cjs')

const [launcher, out] = process.argv.slice(2)
const fromIdx = process.argv.indexOf('--from')
if (!launcher || !out) {
  console.error('usage: node record.cjs <launcher.ts> <out.json> [--from <label>]')
  process.exit(2)
}

const transcripts = {}
for (const s of scenarios) {
  transcripts[s.name] = runScenario(launcher, s)
  console.log(`  ${String(transcripts[s.name].exitCode).padEnd(4)} ${s.name}`)
}

fs.writeFileSync(
  out,
  JSON.stringify({ recorded_from: fromIdx > 0 ? process.argv[fromIdx + 1] : launcher, transcripts }, null, 2) + '\n',
)
console.log(`  wrote ${out}`)
