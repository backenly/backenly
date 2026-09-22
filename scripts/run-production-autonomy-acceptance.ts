/**
 * AUTONOMY ACCEPTANCE LAUNCHER — PRODUCTION
 * =========================================
 *
 * Runs one mode of `scripts/autonomy-acceptance-fixture.ts` against production,
 * as a one-shot Fargate task inside the production VPC.
 *
 * ── Why this does not reuse the staging launcher ────────────────────────────
 *
 * `scripts/lib/staging-fargate-task.ts` is the STAGING execution surface: its
 * guards assert "staging", and it is what the replay and rehearsal tasks ride
 * on. Adding a production target to it would put one flag between a rehearsal
 * and production. The duplication here is the point, and it is the same choice
 * `run-production-lineage-capture.ts` made.
 *
 * ── What it may touch ───────────────────────────────────────────────────────
 *
 * One disposable project, owned by a dedicated fixture user, found by the exact
 * name the fixture hardcodes. It cannot be pointed at a real project: no
 * project id, project name, table or SQL is accepted from a caller, by this
 * launcher or by the fixture. The bundle is audited before it is shipped, so a
 * fixture that had lost its own guards cannot be the thing that runs.
 *
 * Nothing runs without `--confirm-production-fixture`, and no default points at
 * production: the account id is supplied from outside.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   PRODUCTION_AWS_ACCOUNT_ID=<account> npx tsx scripts/run-production-autonomy-acceptance.ts \
 *     --mode prepare --confirm-production-fixture
 *
 *   PRODUCTION_AWS_ACCOUNT_ID=<account> npx tsx scripts/run-production-autonomy-acceptance.ts \
 *     --mode teardown --confirm-destroy <projectId> --confirm-production-fixture
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

const REGION = 'ap-south-1'
const CLUSTER = 'backenly-production'
const SERVICE = 'backenly-production-runtime'
const LOG_GROUP = '/ecs/backenly-production/runtime'
const LOG_PREFIX = 'autonomy-acceptance'
const FAMILY = 'backenly-production-autonomy-acceptance'
const CONTAINER = 'autonomy-acceptance'

const ENTRY = 'scripts/autonomy-acceptance-fixture.ts'
const RESULT_MARKER = 'ACCEPTANCE-RESULT '
const ENV_BUDGET_BYTES = 58 * 1024

const MODES = ['prepare', 'fault', 'authority', 'freeze-begin', 'freeze-end', 'observe', 'diagnose', 'teardown'] as const
const FAULTS = ['healthy', 'rls_disabled', 'missing_index', 'wide_open_policy'] as const
const ACTIONS = ['declare_intent', 'grant', 'revoke'] as const

/**
 * Markers that must survive bundling.
 *
 * Each one is a guard the fixture performs before it writes anything. A bundle
 * missing any of them is not the fixture this launcher is willing to run
 * against production, whatever the file on disk currently says.
 */
const REQUIRED_MARKERS = [
  '__backenly_autonomy_acceptance_v1__',
  'ALLOW_PRODUCTION_FIXTURE',
  'CONFIRM_DESTROY',
  'EXPECT_ENVIRONMENT',
  'refusing to guess',
]

const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/autonomy-acceptance.cjs',z.brotliDecompressSync(Buffer.from(process.env.FIXTURE_B64,'base64')));" +
  "require('/tmp/autonomy-acceptance.cjs')"

function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : null
}

function die(msg: string): never {
  console.error(`\n  REFUSED: ${msg}\n`)
  process.exit(2)
}

const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function assertProductionAccount(): void {
  const expected = process.env.PRODUCTION_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!expected) {
    die('PRODUCTION_AWS_ACCOUNT_ID is not set. It is deliberately not hardcoded: this repository is public.')
  }
  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== expected) die(`account is ${id?.Account}, expected ${expected}`)
  if (!CLUSTER.includes('production') || CLUSTER.includes('staging')) die(`cluster "${CLUSTER}" is not production`)
  if (!SERVICE.includes('production') || SERVICE.includes('staging')) die(`service "${SERVICE}" is not production`)
  console.log(`  account ${id.Account} · region ${REGION} · cluster ${CLUSTER}`)
}

/** One secret, and it must be production's. Nothing that can decrypt anything. */
function productionDbSecret(taskDef: any): Array<{ name: string; valueFrom: string }> {
  const all: Array<{ name: string; valueFrom: string }> = taskDef.containerDefinitions?.[0]?.secrets ?? []
  const wanted = all.filter(s => s.name === 'DATABASE_URL')
  if (wanted.length !== 1) die('production task definition does not expose exactly one DATABASE_URL secret')
  const { valueFrom } = wanted[0]
  if (/staging/i.test(valueFrom)) die(`DATABASE_URL resolves to a staging ARN: ${valueFrom}`)
  if (!/production/i.test(valueFrom)) die(`DATABASE_URL does not identify a production resource: ${valueFrom}`)
  return wanted
}

/**
 * `BACKENLY_ENV` as the deployed production service declares it.
 *
 * The fixture compares its `EXPECT_ENVIRONMENT` against this. Inventing it here
 * would make that check agree with itself.
 */
function deployedEnvironment(srcDef: any): string {
  const env: Array<{ name: string; value: string }> = srcDef.containerDefinitions?.[0]?.environment ?? []
  const found = env.find(e => e.name === 'BACKENLY_ENV')?.value
  if (!found) die('the production task definition declares no BACKENLY_ENV, so the environment cannot be proven')
  if (found !== 'production') die(`the deployed task definition says BACKENLY_ENV=${found}, not production`)
  return found
}

function readLogStream(stream: string): string[] {
  const lines: string[] = []
  let token: string | undefined
  for (let page = 0; page < 1000; page++) {
    const args = ['logs', 'get-log-events', '--log-group-name', LOG_GROUP, '--log-stream-name', stream, '--start-from-head']
    if (token) args.push('--next-token', token)
    const res = aws(args)
    for (const e of res?.events ?? []) lines.push(String(e.message))
    const next: string | undefined = res?.nextForwardToken
    if (!next || next === token) return lines
    token = next
  }
  throw new Error(`log stream ${stream} did not end within 1000 pages`)
}

const sleep = (ms: number) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function bundle(): Promise<{ code: string; sourceSha: string }> {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [join(process.cwd(), ...ENTRY.split('/'))],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['@prisma/client', '.prisma/client', 'pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  const missing = REQUIRED_MARKERS.filter(m => !code.includes(m))
  if (missing.length > 0) {
    die(`the bundled fixture is missing its own guards: ${missing.join(', ')}`)
  }
  const sourceSha = createHash('sha256')
    .update(readFileSync(join(process.cwd(), ...ENTRY.split('/'))))
    .digest('hex')
  console.log(`  fixture bundled: ${(code.length / 1024).toFixed(1)} KB · source sha256 ${sourceSha.slice(0, 16)}…`)
  return { code, sourceSha }
}

async function main(): Promise<number> {
  if (!process.argv.includes('--confirm-production-fixture')) {
    die('production needs --confirm-production-fixture, typed deliberately')
  }
  const mode = argValue('--mode') ?? ''
  if (!(MODES as readonly string[]).includes(mode)) die(`--mode must be one of ${MODES.join('|')}`)
  const fault = argValue('--fault') ?? ''
  if (mode === 'fault' && !(FAULTS as readonly string[]).includes(fault)) die(`--fault must be one of ${FAULTS.join('|')}`)
  const action = argValue('--action') ?? ''
  if (mode === 'authority' && !(ACTIONS as readonly string[]).includes(action)) die(`--action must be one of ${ACTIONS.join('|')}`)
  const confirmDestroy = argValue('--confirm-destroy') ?? ''
  if (mode === 'teardown' && !confirmDestroy) die('teardown needs --confirm-destroy <projectId>')
  const since = argValue('--since') ?? ''

  const { code, sourceSha } = await bundle()
  const compressed = brotliCompressSync(Buffer.from(code, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64')

  const emit = argValue('--emit-bundle')
  if (emit) {
    writeFileSync(emit, compressed)
    console.log(`  wrote ${emit}`)
    return 0
  }

  const envBytes = BOOTSTRAP.length + compressed.length
  console.log(`  environment payload: ${(envBytes / 1024).toFixed(1)} KB`)
  if (envBytes > ENV_BUDGET_BYTES) die(`payload is over the ${ENV_BUDGET_BYTES / 1024} KB task-definition budget`)

  assertProductionAccount()

  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE])?.services?.[0]
  if (!svc) die(`service ${SERVICE} not found in ${CLUSTER}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('production service has no awsvpc configuration to mirror')
  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SERVICE])?.taskDefinition
  if (!srcDef) die('could not read the production task definition')
  const secrets = productionDbSecret(srcDef)
  const backenlyEnv = deployedEnvironment(srcDef)
  console.log(`  deployed task definition declares BACKENLY_ENV=${backenlyEnv}`)

  const container = {
    name: CONTAINER,
    image: srcDef.containerDefinitions[0].image,
    essential: true,
    command: ['sh', '-c', 'exec node -e "$FIXTURE_BOOTSTRAP"'],
    environment: [
      { name: 'FIXTURE_BOOTSTRAP', value: BOOTSTRAP },
      { name: 'FIXTURE_B64', value: compressed },
      { name: 'NODE_PATH', value: '/app/node_modules' },
      { name: 'BACKENLY_ENV', value: backenlyEnv },
      { name: 'EXPECT_ENVIRONMENT', value: 'production' },
      { name: 'ALLOW_PRODUCTION_FIXTURE', value: 'yes' },
      { name: 'ACCEPTANCE_MODE', value: mode },
      ...(mode === 'fault' ? [{ name: 'ACCEPTANCE_FAULT', value: fault }] : []),
      ...(mode === 'authority' ? [{ name: 'ACCEPTANCE_ACTION', value: action }] : []),
      ...(since ? [{ name: 'OBSERVE_SINCE', value: since }] : []),
      ...(mode === 'teardown'
        ? [
            { name: 'CONFIRM_DESTROY', value: confirmDestroy },
            { name: 'CONFIRM_ENV', value: 'production' },
          ]
        : []),
    ],
    secrets,
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': LOG_GROUP,
        'awslogs-region': REGION,
        'awslogs-stream-prefix': LOG_PREFIX,
      },
    },
  }

  const registered = aws([
    'ecs', 'register-task-definition',
    '--family', FAMILY,
    '--requires-compatibilities', 'FARGATE',
    '--network-mode', 'awsvpc',
    '--cpu', '512',
    '--memory', '1024',
    '--execution-role-arn', srcDef.executionRoleArn,
    '--container-definitions', JSON.stringify([container]),
  ])?.taskDefinition
  const taskDefArn: string = registered.taskDefinitionArn
  console.log(`  registered ${taskDefArn.split('/').pop()}`)

  let exit = 1
  try {
    const run = aws([
      'ecs', 'run-task',
      '--cluster', CLUSTER,
      '--task-definition', taskDefArn,
      '--launch-type', 'FARGATE',
      '--network-configuration', JSON.stringify({
        awsvpcConfiguration: {
          subnets: net.subnets,
          securityGroups: net.securityGroups,
          assignPublicIp: net.assignPublicIp,
        },
      }),
      '--started-by', `autonomy-acceptance-${mode}`,
    ])
    if (run?.failures?.length) die(`run-task failed: ${JSON.stringify(run.failures)}`)

    const taskArn: string = run.tasks[0].taskArn
    const taskId = taskArn.split('/').pop()!
    console.log(`  task ${taskId} starting…`)
    execFileSync('aws', ['ecs', 'wait', 'tasks-stopped', '--cluster', CLUSTER, '--tasks', taskArn, '--region', REGION], {
      stdio: 'inherit',
    })
    const done = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn])?.tasks?.[0]
    const containerExit = done?.containers?.[0]?.exitCode ?? null
    console.log(`  task stopped: ${done?.stoppedReason ?? 'n/a'} (exit ${containerExit})`)

    const stream = `${LOG_PREFIX}/${CONTAINER}/${taskId}`
    let lines: string[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        lines = readLogStream(stream)
        if (lines.some(l => l.includes(RESULT_MARKER))) break
      } catch (err) {
        console.error('  could not read task logs:', err instanceof Error ? err.message : err)
      }
      if (attempt < 6) sleep(5000)
    }

    const line = lines.find(l => l.includes(RESULT_MARKER))
    if (!line) {
      console.error('  no ACCEPTANCE-RESULT line in the task logs')
      console.error(lines.slice(-25).join('\n'))
      exit = 1
    } else {
      const parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length))
      console.log(`\n${JSON.stringify({ ...parsed, fixtureSourceSha256: sourceSha }, null, 2)}\n`)
      exit = parsed.ok === true && containerExit === 0 ? 0 : 2
    }
  } finally {
    try {
      aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
      console.log(`  deregistered ${taskDefArn.split('/').pop()}`)
    } catch (err) {
      console.error(`  CLEANUP FAILED: ${taskDefArn} is still registered`)
      if (exit === 0) exit = 3
    }
  }
  return exit
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`\n  FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
