/**
 * PRODUCTION MIGRATION JOB — the Layer 3 runner, pointed at production
 * ====================================================================
 *
 * Runs `tools/managed-db/runner` as a one-shot Fargate task in the production
 * cluster, with the runner's own commands: `status`, `preflight`, `verify`,
 * `deploy`, `baseline`, `rollback`.
 *
 * ── Why this is a separate file and not `--target production` ──────────────
 *
 * The same reason `run-production-lineage-capture.ts` is separate from the
 * staging launcher: a flag is one typo away from a production write, and
 * `scripts/lib/staging-fargate-task.ts` is the surface that also carries
 * arbitrary bundled payloads for the lineage replays. Nothing from that module
 * is imported here. This file has production constants, no payload input, and
 * one fixed image whose digest is pinned by its tag.
 *
 * The duplication is deliberate and it is not large: the ECS plumbing is fifty
 * lines, and the alternative is a shared module whose guards have to be right
 * for two environments with different blast radii.
 *
 * ── Three guards, at three different depths ────────────────────────────────
 *
 *   PRODUCTION_AWS_ACCOUNT_ID   which AWS account. Never hardcoded: the
 *                               repository is public.
 *   the secret's ARN            must name a production resource and must not
 *                               name a staging one. A check on the pointer.
 *   EXPECT_DATABASE             passed into the container, where the runner
 *                               parses the URL it actually connected to and
 *                               refuses if the database is not that one. A
 *                               check on the connection.
 *
 * The third exists because the first two can both pass while the secret's
 * CONTENTS point somewhere else. Baselining writes migration history into
 * whatever it reaches and re-running does not undo it.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   # Windows (tsx cannot run from WSL: node_modules holds a win32 esbuild)
 *   npx esbuild scripts/run-production-migration-job.ts --bundle \
 *     --platform=node --format=cjs --outfile=<scratch>/prod-migrate.cjs
 *
 *   # WSL (authenticated AWS CLI)
 *   PRODUCTION_AWS_ACCOUNT_ID=<account> PRODUCTION_DB_NAME=<database> \
 *     node <scratch>/prod-migrate.cjs --command status --image <ecr uri>
 *
 * `status`, `preflight` and `verify --migration <id>` are read-only and need no
 * confirmation. `deploy` needs `--confirm-production-deploy`, and the runner
 * runs its ownership preflight first. `baseline` needs BOTH
 * `--confirm-production-baseline` AND the runner's own MIGRATE_BASELINE_CONFIRM
 * naming the same migration, because it is a one-time action that rewrites what
 * the database believes about its own history. `rollback` is the same kind of
 * action for a FAILED migration: `--confirm-production-rollback <id>` must name
 * the migration, the runner checks that again, and it resolves only after that
 * migration's absence proof passes. It is for a failed row that actually
 * exists, never a routine step.
 *
 * `--image` is the runner by an immutable reference: a `migrate-<sha>` tag or
 * an `@sha256:` digest. Release records name digests.
 */

import { execFileSync } from 'node:child_process'

import { readMigrationJobOutcome, type RunnerCommand } from '../tools/managed-db/migration-job-outcome'

const REGION = 'ap-south-1'
const CLUSTER = 'backenly-production'
const SERVICE = 'backenly-production-runtime'
const LOG_GROUP = '/ecs/backenly-production/runtime'
const LOG_PREFIX = 'migrate'
const FAMILY = 'backenly-production-migration-job'
const CONTAINER = 'migrate'

type Command = RunnerCommand
const COMMANDS: readonly Command[] = ['status', 'preflight', 'verify', 'deploy', 'baseline', 'rollback']

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

/**
 * The two secrets Prisma migrate needs, and both must be production's.
 *
 * `schema.prisma` declares `directUrl`, so DIRECT_URL is not optional here the
 * way it was for the read-only capture.
 */
function productionDbSecrets(taskDef: any): Array<{ name: string; valueFrom: string }> {
  const all: Array<{ name: string; valueFrom: string }> = taskDef.containerDefinitions?.[0]?.secrets ?? []
  const wanted = all.filter(s => s.name === 'DATABASE_URL' || s.name === 'DIRECT_URL')
  if (wanted.length !== 2) {
    die(`production task definition exposes ${wanted.length} of the 2 required secrets (DATABASE_URL, DIRECT_URL)`)
  }
  for (const { name, valueFrom } of wanted) {
    if (/staging/i.test(valueFrom)) die(`${name} resolves to a staging ARN: ${valueFrom}`)
    if (!/production/i.test(valueFrom)) die(`${name} does not identify a production resource: ${valueFrom}`)
  }
  return wanted
}

/** Every page of one log stream; the CLI does not paginate this operation. */
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

async function main(): Promise<void> {
  const command = (argValue('--command') ?? '') as Command
  if (!COMMANDS.includes(command)) {
    die(
      'usage: --command status|preflight|verify|deploy|baseline|rollback --image <ecr uri> [--migration <id>] ' +
        '[--confirm-production-deploy | --confirm-production-baseline | --confirm-production-rollback <id>]',
    )
  }

  const image = argValue('--image')
  if (!image) die('--image is required: the migration runner image to run')
  if (!/^\d+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\//.test(image)) die(`--image is not an ECR image: ${image}`)
  if (!/:migrate-[0-9a-f]{7,40}$/.test(image) && !/@sha256:[0-9a-f]{64}$/.test(image)) {
    // Immutable and content-identified: a migrate-<sha> tag or a digest.
    // `:latest` on a production migration is a different image every time it
    // is pulled.
    die(`--image must carry a migrate-<git sha> tag or an @sha256 digest, not a floating reference: ${image}`)
  }

  const database = process.env.PRODUCTION_DB_NAME?.trim()
  if (!database) die('PRODUCTION_DB_NAME is not set; state the database this job is allowed to touch')

  const args: string[] = [command]
  const environment: Array<{ name: string; value: string }> = [
    { name: 'EXPECT_DATABASE', value: database },
  ]

  if (command === 'deploy' && !process.argv.includes('--confirm-production-deploy')) {
    die('deploy applies migrations to the production database; pass --confirm-production-deploy')
  }
  if (command === 'baseline') {
    const migration = argValue('--migration')
    if (!migration) die('baselining needs --migration <id>')
    if (!process.argv.includes('--confirm-production-baseline')) {
      die('baselining rewrites what production believes about its own history; pass --confirm-production-baseline')
    }
    args.push(migration)
    environment.push({ name: 'MIGRATE_BASELINE_CONFIRM', value: migration })
  }
  if (command === 'rollback') {
    const migration = argValue('--migration')
    if (!migration) die('rollback needs --migration <id>')
    if (argValue('--confirm-production-rollback') !== migration) {
      die('rollback rewrites what production believes about its own history; pass --confirm-production-rollback naming the same migration')
    }
    args.push(migration)
    environment.push({ name: 'MIGRATE_ROLLBACK_CONFIRM', value: migration })
  }
  if (command === 'verify') {
    const migration = argValue('--migration')
    if (!migration) die('verify needs --migration <id>')
    args.push(migration)
  }

  const named = command === 'baseline' || command === 'rollback' || command === 'verify' ? ` ${argValue('--migration')}` : ''
  console.log(`\nProduction migration job — ${command}${named}\n`)
  assertProductionAccount()

  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE])?.services?.[0]
  if (!svc) die(`service ${SERVICE} not found in ${CLUSTER}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('production service has no awsvpc configuration to mirror')
  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SERVICE])?.taskDefinition
  if (!srcDef) die('could not read the production task definition')
  const secrets = productionDbSecrets(srcDef)
  console.log(`  secrets carried: ${secrets.map(s => s.name).join(', ')}`)
  console.log(`  expected database: ${database}`)
  console.log(`  image ${image}`)

  const container = {
    name: CONTAINER,
    image,
    essential: true,
    command: args,
    environment,
    secrets,
    logConfiguration: {
      logDriver: 'awslogs',
      options: { 'awslogs-group': LOG_GROUP, 'awslogs-region': REGION, 'awslogs-stream-prefix': LOG_PREFIX },
    },
  }

  // Armed from the moment a durable AWS resource can exist, covering the window
  // between a successful registration and reading its ARN.
  let taskDefArn: string | null = null
  let exitCode = 1
  try {
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
    if (!registered?.taskDefinitionArn) throw new Error('register-task-definition returned no taskDefinitionArn')
    taskDefArn = String(registered.taskDefinitionArn)
    console.log(`  registered ${taskDefArn.split('/').pop()}`)

    const netCfg = JSON.stringify({
      awsvpcConfiguration: { subnets: net.subnets, securityGroups: net.securityGroups, assignPublicIp: net.assignPublicIp },
    })
    const started = aws([
      'ecs', 'run-task',
      '--cluster', CLUSTER,
      '--task-definition', taskDefArn,
      '--launch-type', 'FARGATE',
      '--network-configuration', netCfg,
      '--started-by', `production-migration-${command}`,
    ])
    if (started?.failures?.length) throw new Error(`run-task failed: ${JSON.stringify(started.failures)}`)

    const taskArn: string = started.tasks[0].taskArn
    const taskId = taskArn.split('/').pop()!
    console.log(`  task ${taskId} starting…`)
    execFileSync('aws', ['ecs', 'wait', 'tasks-stopped', '--cluster', CLUSTER, '--tasks', taskArn, '--region', REGION], {
      stdio: 'inherit',
    })
    const done = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn])?.tasks?.[0]
    const containerExit: number | null = done?.containers?.[0]?.exitCode ?? null
    console.log(`  task stopped: ${done?.stoppedReason ?? 'n/a'} (exit ${containerExit})`)

    let lines: string[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        lines = readLogStream(`${LOG_PREFIX}/${CONTAINER}/${taskId}`)
        if (lines.length > 0) break
        if (attempt < 6) console.log(`  logs incomplete, waiting for delivery (${attempt}/6)`)
      } catch (err) {
        console.error('  could not read task logs:', err instanceof Error ? err.message : err)
      }
      if (attempt < 6) sleep(Number(process.env.MIGRATE_LOG_POLL_MS ?? 5000))
    }
    for (const l of lines) console.log(`    | ${l}`)

    // Same reader as the staging launcher, so the two cannot disagree about
    // what counts as proved.
    const outcome = readMigrationJobOutcome(command, lines.join('\n'), containerExit)
    const flags = Object.entries(outcome.observed).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`\n  observed: ${flags}`)
    if (outcome.exitCode === 0) console.log(`  ${outcome.message}`)
    else console.error(`\n  ${outcome.message}`)
    exitCode = outcome.exitCode
  } catch (err) {
    console.error(`\n  ERROR: ${err instanceof Error ? err.message : String(err)}`)
    exitCode = 2
  } finally {
    if (taskDefArn) {
      try {
        aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
        console.log(`  deregistered ${taskDefArn.split('/').pop()}`)
      } catch (err) {
        console.error('  could not deregister the task definition:', err instanceof Error ? err.message : err)
      }
    }
  }

  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
