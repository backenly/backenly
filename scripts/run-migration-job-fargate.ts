/**
 * LAYER 3 MIGRATION JOB — run the dedicated migration runner in staging
 * =====================================================================
 *
 * One-shot Fargate task using the migration runner image, not the application
 * image and not the long-lived app process.
 *
 *   node .../launcher --command status  --image <ecr uri>
 *   node .../launcher --command deploy  --image <ecr uri>
 *   node .../launcher --command preflight --image <ecr uri>
 *   node .../launcher --command verify  --migration <id> --image <ecr uri>
 *   node .../launcher --command baseline --migration 00000000000000_baseline \
 *        --image <ecr uri> --confirm-baseline
 *   node .../launcher --command rollback --migration <id> \
 *        --confirm-rollback <the same id> --image <ecr uri>
 *
 * `baseline` is a one-time action for an existing database, not part of a
 * normal release: it needs its own flag here AND the runner's own
 * MIGRATE_BASELINE_CONFIRM check, which must name the same migration. Steady
 * state is `deploy` alone, and the runner runs its ownership preflight before
 * every deploy.
 *
 * `rollback` resolves a FAILED migration as rolled back so the next deploy
 * retries it. The confirmation must name the same migration here, the runner
 * checks it again, and the runner resolves only after that migration's absence
 * proof shows the failed attempt left nothing behind.
 */

import {
  argValue,
  assertStagingOnly,
  die,
  resolveStagingTaskContext,
  runTaskAndReadResult,
  withEphemeralTaskDefinition,
  type OneShotTaskSpec,
} from './lib/staging-fargate-task'
import { readMigrationJobOutcome, type RunnerCommand } from '../tools/managed-db/migration-job-outcome'

const FAMILY = 'backenly-staging-migration-job'
const CONTAINER = 'migrate'
const LOG_PREFIX = 'migrate'

type Command = RunnerCommand
const COMMANDS: readonly Command[] = ['status', 'deploy', 'preflight', 'verify', 'baseline', 'rollback']

async function main(): Promise<void> {
  const command = (argValue('--command') ?? '') as Command
  if (!COMMANDS.includes(command)) {
    die(
      'usage: --command status|deploy|preflight|verify|baseline|rollback --image <ecr uri> ' +
        '[--migration <id>] [--confirm-baseline | --confirm-rollback <id>]',
    )
  }
  const image = argValue('--image')
  if (!image) die('--image is required: the migration runner image to run')
  if (!/^\d+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\//.test(image)) die(`--image is not an ECR image: ${image}`)

  const environment: Array<{ name: string; value: string }> = []
  const args: string[] = [command]

  if (command === 'baseline') {
    const migration = argValue('--migration')
    if (!migration) die('baselining needs --migration <id>')
    if (!process.argv.includes('--confirm-baseline')) {
      die('baselining writes migration history to a real database; pass --confirm-baseline to say so explicitly')
    }
    args.push(migration)
    environment.push({ name: 'MIGRATE_BASELINE_CONFIRM', value: migration })
    console.log(`\nLayer 3 migration job — BASELINE ${migration}\n`)
  } else if (command === 'rollback') {
    const migration = argValue('--migration')
    if (!migration) die('rollback needs --migration <id>')
    if (argValue('--confirm-rollback') !== migration) {
      die('rollback rewrites migration history; pass --confirm-rollback naming the same migration')
    }
    args.push(migration)
    environment.push({ name: 'MIGRATE_ROLLBACK_CONFIRM', value: migration })
    console.log(`\nLayer 3 migration job — ROLLBACK ${migration}\n`)
  } else if (command === 'verify') {
    const migration = argValue('--migration')
    if (!migration) die('verify needs --migration <id>')
    args.push(migration)
    console.log(`\nLayer 3 migration job — verify ${migration}\n`)
  } else {
    console.log(`\nLayer 3 migration job — ${command}\n`)
  }

  assertStagingOnly()
  const ctx = resolveStagingTaskContext()
  console.log(`  image ${image}`)

  const spec: OneShotTaskSpec = {
    family: FAMILY,
    containerName: CONTAINER,
    logPrefix: LOG_PREFIX,
    startedBy: `migration-job-${command}`,
    image,
    command: args,
    environment,
    cpu: '512',
    memory: '1024',
  }

  const exitCode = await withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
    const { lines, containerExit } = runTaskAndReadResult(ctx, taskDefArn, spec)
    // Prisma and the runner say what they did; the task's exit code is the
    // authority for failure, and the shared reader reports both rather than
    // interpreting one as the other.
    const outcome = readMigrationJobOutcome(command, lines.join('\n'), containerExit)
    const flags = Object.entries(outcome.observed).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`\n  observed: ${flags}`)
    if (outcome.exitCode === 0) console.log(`  ${outcome.message}`)
    else console.error(`\n  ${outcome.message}`)
    return outcome.exitCode
  })

  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
