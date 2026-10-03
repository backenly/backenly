// Runs one launcher under the aws shim and returns a normalised transcript:
// exit code, stdout, stderr and the ordered argv of every aws call.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SHIM = path.join(__dirname, 'aws-shim.cjs')

function runScenario(launcherPath, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-parity-'))
  try {
    const bundle = path.join(dir, 'bundle.b64')
    fs.writeFileSync(bundle, Buffer.from('console.log("fixture bundle")').toString('base64'))
    if (scenario.staleBundle) fs.utimesSync(bundle, new Date(0), new Date(0))

    const log = path.join(dir, 'aws-calls.jsonl')
    const env = {
      ...process.env,
      SHIM_SCENARIO: JSON.stringify(scenario.aws),
      SHIM_LOG: log,
      // Log-delivery retries would otherwise sleep between attempts.
      STAGING_TASK_LOG_POLL_MS: '0',
    }
    delete env.REHEARSAL_AWS_ACCOUNT_ID
    if (scenario.account !== undefined) env.REHEARSAL_AWS_ACCOUNT_ID = scenario.account

    const r = spawnSync(
      process.execPath,
      ['--require', SHIM, '--import', 'tsx', launcherPath, '--bundle', bundle],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
    )
    if (r.error) throw r.error

    const normalise = s =>
      String(s ?? '')
        .split(dir)
        .join('<TMP>')
        // The separator after the placeholder is a backslash on Windows and a
        // slash on Linux. Recording it would pin the transcript to whichever
        // machine produced it, and CI runs on the other one.
        .replace(/<TMP>\\/g, '<TMP>/')
        .replace(/\r\n/g, '\n')
        .split('\n')
        // Stack frames name whichever file path ran, which differs between a
        // checked-out launcher and a historical copy. The message is the contract.
        .filter(line => !/^\s+at /.test(line))
        .join('\n')

    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).args)
      : []

    return { exitCode: r.status, stdout: normalise(r.stdout), stderr: normalise(r.stderr), awsCalls: calls }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { runScenario, ROOT }
