/**
 * AUTONOMY ACCEPTANCE LAUNCHER — STAGING
 * ======================================
 *
 * Runs one mode of `scripts/autonomy-acceptance-fixture.ts` inside the staging
 * VPC as a one-shot Fargate task. The fixture needs the staging database, which
 * is `PubliclyAccessible: false`, and it must run as the same code the deployed
 * services run, so it rides the staging runtime image.
 *
 * This launcher only prepares state and reads ground truth back. It never
 * repairs anything: the repairs come from the scheduler in the web task, which
 * is the thing being qualified. Between two modes there is a wait, and that
 * wait is the point — it is where the real loop acts.
 *
 * ── The environment is read, never asserted ────────────────────────────────
 *
 * `EXPECT_ENVIRONMENT` is checked inside the fixture against the container's
 * own `BACKENLY_ENV`. If this launcher invented that value the check would only
 * be agreeing with itself, so `BACKENLY_ENV` is copied from the deployed
 * staging task definition and refused unless the deployed service itself says
 * "staging".
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/run-autonomy-acceptance-fargate.ts --mode prepare
 *   npx tsx scripts/run-autonomy-acceptance-fargate.ts --mode fault --fault rls_disabled
 *   npx tsx scripts/run-autonomy-acceptance-fargate.ts --mode authority --action grant
 *   npx tsx scripts/run-autonomy-acceptance-fargate.ts --mode observe --since 2026-09-22T10:00:00Z
 *   npx tsx scripts/run-autonomy-acceptance-fargate.ts --mode teardown --confirm-destroy <projectId>
 *
 * Split-platform bundling (Windows repo, WSL AWS CLI) works exactly as it does
 * for the other launchers: `--emit-bundle <file>` then `--bundle <file>`.
 */

import { brotliCompressSync, constants } from 'node:zlib'
import { writeFileSync } from 'node:fs'

import {
  argValue,
  assertStagingOnly,

  die,
  resolveBundle,
  resolveStagingTaskContext,
  runTaskAndReadResult,
  withEphemeralTaskDefinition,
} from './lib/staging-fargate-task'

const ENTRY = 'scripts/autonomy-acceptance-fixture.ts'
const FAMILY = 'backenly-staging-autonomy-acceptance'
const CONTAINER = 'autonomy-acceptance'
const LOG_PREFIX = 'autonomy-acceptance'
const RESULT_MARKER = 'ACCEPTANCE-RESULT '

/** Headroom under the 64 KB task-definition limit for the rest of the definition. */
const ENV_BUDGET_BYTES = 58 * 1024

const MODES = ['prepare', 'fault', 'authority', 'freeze-begin', 'freeze-end', 'observe', 'teardown'] as const
const FAULTS = ['healthy', 'rls_disabled', 'missing_index', 'wide_open_policy'] as const
const ACTIONS = ['declare_intent', 'grant', 'revoke'] as const

const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/autonomy-acceptance.cjs',z.brotliDecompressSync(Buffer.from(process.env.FIXTURE_B64,'base64')));" +
  "require('/tmp/autonomy-acceptance.cjs')"

const brotli = (text: string) =>
  brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64')

/**
 * `BACKENLY_ENV` as the deployed staging service declares it.
 *
 * Refuses rather than defaulting: a task definition with no environment marker
 * is one this launcher cannot prove is staging, and the fixture's identity
 * check would then be comparing a value this file made up.
 */
function deployedEnvironment(srcDef: any): string {
  const env: Array<{ name: string; value: string }> = srcDef.containerDefinitions?.[0]?.environment ?? []
  const found = env.find(e => e.name === 'BACKENLY_ENV')?.value
  if (!found) die('the staging task definition declares no BACKENLY_ENV, so the environment cannot be proven')
  if (found !== 'staging') die(`the deployed task definition says BACKENLY_ENV=${found}, not staging`)
  return found
}

async function main(): Promise<number> {
  const mode = argValue('--mode') ?? ''
  if (!(MODES as readonly string[]).includes(mode)) die(`--mode must be one of ${MODES.join('|')}`)

  const fault = argValue('--fault') ?? ''
  if (mode === 'fault' && !(FAULTS as readonly string[]).includes(fault)) {
    die(`--fault must be one of ${FAULTS.join('|')}`)
  }
  const action = argValue('--action') ?? ''
  if (mode === 'authority' && !(ACTIONS as readonly string[]).includes(action)) {
    die(`--action must be one of ${ACTIONS.join('|')}`)
  }
  const confirmDestroy = argValue('--confirm-destroy') ?? ''
  if (mode === 'teardown' && !confirmDestroy) {
    die('teardown needs --confirm-destroy <projectId>, naming the fixture project exactly')
  }
  const since = argValue('--since') ?? ''

  const b64 = await resolveBundle({
    entry: ENTRY,
    label: 'acceptance fixture',
    // Resolvable inside the runtime image at /app/node_modules (NODE_PATH).
    external: ['@prisma/client', '.prisma/client', 'pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
  })

  const emit = argValue('--emit-bundle')
  if (emit) {
    writeFileSync(emit, b64)
    console.log(`  wrote ${emit}`)
    return 0
  }

  const compressed = brotli(Buffer.from(b64, 'base64').toString('utf8'))
  const envBytes = BOOTSTRAP.length + compressed.length
  console.log(`  environment payload: ${(envBytes / 1024).toFixed(1)} KB`)
  if (envBytes > ENV_BUDGET_BYTES) {
    die(`payload is ${(envBytes / 1024).toFixed(1)} KB, over the ${ENV_BUDGET_BYTES / 1024} KB task-definition budget`)
  }

  assertStagingOnly()
  const ctx = resolveStagingTaskContext()
  const backenlyEnv = deployedEnvironment(ctx.srcDef)
  console.log(`  deployed task definition declares BACKENLY_ENV=${backenlyEnv}`)

  const environment = [
    { name: 'FIXTURE_BOOTSTRAP', value: BOOTSTRAP },
    { name: 'FIXTURE_B64', value: compressed },
    { name: 'BACKENLY_ENV', value: backenlyEnv },
    { name: 'EXPECT_ENVIRONMENT', value: 'staging' },
    { name: 'ACCEPTANCE_MODE', value: mode },
    ...(mode === 'fault' ? [{ name: 'ACCEPTANCE_FAULT', value: fault }] : []),
    ...(mode === 'authority' ? [{ name: 'ACCEPTANCE_ACTION', value: action }] : []),
    ...(since ? [{ name: 'OBSERVE_SINCE', value: since }] : []),
    ...(mode === 'teardown'
      ? [
          { name: 'CONFIRM_DESTROY', value: confirmDestroy },
          { name: 'CONFIRM_ENV', value: 'staging' },
        ]
      : []),
  ]

  const spec = {
    family: FAMILY,
    containerName: CONTAINER,
    logPrefix: LOG_PREFIX,
    startedBy: `autonomy-acceptance-${mode}`,
    command: ['sh', '-c', 'exec node -e "$FIXTURE_BOOTSTRAP"'],
    environment,
    cpu: '512',
    memory: '1024',
  }

  return withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
    const res = runTaskAndReadResult(ctx, taskDefArn, spec, {
      complete: lines => lines.some(l => l.includes(RESULT_MARKER)),
      echo: line => !line.includes(RESULT_MARKER),
    })

    const line = res.lines.find(l => l.includes(RESULT_MARKER))
    if (!line) {
      console.error('  no ACCEPTANCE-RESULT line in the task logs')
      console.error(res.lines.slice(-25).join('\n'))
      return 1
    }
    const parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length))
    console.log(`\n${JSON.stringify(parsed, null, 2)}\n`)

    // The fixture's own verdict AND the container's exit code. Either one alone
    // could report success for a run that ended badly after printing.
    if (parsed.ok !== true) return 2
    return res.containerExit === 0 ? 0 : 1
  })
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`\n  FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
