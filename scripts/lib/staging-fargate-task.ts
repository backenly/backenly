/**
 * ONE-SHOT STAGING FARGATE TASKS — the shared, staging-only half of a launcher
 * ============================================================================
 *
 * Runs a bundled script inside the staging VPC as a single Fargate task, then
 * deregisters everything it registered. Extracted from
 * `scripts/run-rds-rehearsal-fargate.ts` so the migration-lineage probe can use
 * the same guards instead of a copy that drifts.
 *
 * Deliberately NOT a generic "run an AWS task" helper. The cluster, service,
 * region and log group are fixed to staging, the account must be supplied from
 * outside, and every guard is checked against what AWS reports. A launcher
 * supplies only its container command, payload and result parsing.
 *
 * ── Why a one-shot task rather than ECS Exec ────────────────────────────────
 *
 * The staging RDS instance is `PubliclyAccessible: false`, so nothing outside
 * the VPC can reach it — correct, and not worth weakening. The obvious
 * alternative was ECS Exec into the running runtime service, but
 * `backenly-staging-runtime-task` carries NO IAM policies at all, so enabling it
 * would mean an IAM expansion plus a forced redeployment of staging purely to
 * obtain a shell.
 *
 * A one-shot task is also the better artifact: reproducible, non-interactive,
 * CloudWatch-audited, and re-runnable. An exec session is none of those.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── The guards ───────────────────────────────────────────────────────────────
//
// A typo in an argument must not be capable of pointing a schema-mutating
// task at production. Every one of these is checked against what AWS actually
// reports, never against what was passed in.

export const EXPECTED_REGION = 'ap-south-1'
export const CLUSTER = 'backenly-staging'
export const SOURCE_SERVICE = 'backenly-staging-runtime'
// Reuses the RUNTIME log group rather than creating one.
//
// The staging execution role's policy is scoped to the log groups it already
// writes, so a fresh group fails at task start with
// "not authorized to perform: logs:CreateLogStream". Expanding that policy would
// be an IAM change made solely so a task could have its own folder, which is a
// poor trade — the stream prefix already separates it, and reusing the group
// keeps a launcher's AWS footprint to "one task definition, briefly".
export const LOG_GROUP = '/ecs/backenly-staging/runtime'

export function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', EXPECTED_REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : null
}

export function die(msg: string): never {
  console.error(`\n  REFUSED: ${msg}\n`)
  process.exit(2)
}

export function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

export function assertStagingOnly(): void {
  // Supplied by the operator, not written down here. This repository is public,
  // and an account id in public source is free reconnaissance: it is the missing
  // half of every role ARN someone would need to guess. Reading it from the
  // environment leaves the guard exactly as strong, because unset refuses and a
  // mismatch refuses, and the value is still compared against what STS actually
  // reports rather than against anything passed in.
  const EXPECTED_ACCOUNT = process.env.REHEARSAL_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!EXPECTED_ACCOUNT) {
    die(
      'REHEARSAL_AWS_ACCOUNT_ID is not set. Set it to the staging account id this ' +
        'rehearsal is allowed to run against. It is deliberately not hardcoded.',
    )
  }
  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== EXPECTED_ACCOUNT) {
    die(`account is ${id?.Account}, expected ${EXPECTED_ACCOUNT}`)
  }
  if (!CLUSTER.includes('staging')) die(`cluster "${CLUSTER}" is not a staging cluster`)
  if (!SOURCE_SERVICE.includes('staging')) die(`service "${SOURCE_SERVICE}" is not staging`)
  console.log(`  account ${id.Account} · region ${EXPECTED_REGION} · cluster ${CLUSTER}`)
}

/**
 * The staging secrets, with production structurally excluded.
 *
 * Only DATABASE_URL and DIRECT_URL are carried over: a one-shot task needs a
 * database and nothing else. JWT_SECRET and MASTER_ENCRYPTION_KEY are
 * deliberately dropped — a task that cannot decrypt anything cannot leak
 * anything.
 */
export function stagingDbSecrets(taskDef: any): Array<{ name: string; valueFrom: string }> {
  const all: Array<{ name: string; valueFrom: string }> =
    taskDef.containerDefinitions?.[0]?.secrets ?? []
  const wanted = all.filter(s => s.name === 'DATABASE_URL' || s.name === 'DIRECT_URL')

  if (wanted.length === 0) die('staging task definition exposes no DATABASE_URL secret')

  for (const s of wanted) {
    if (/production|prod-/i.test(s.valueFrom)) {
      die(`secret ${s.name} resolves to a production ARN: ${s.valueFrom}`)
    }
    if (!/staging/i.test(s.valueFrom)) {
      die(`secret ${s.name} does not identify a staging resource: ${s.valueFrom}`)
    }
  }
  return wanted
}

// ── The bundle ───────────────────────────────────────────────────────────────

export interface BundleSpec {
  /** Repository-relative entry point, forward slashes. */
  entry: string
  /** Word used in log lines and refusals: "rehearsal", "probe". */
  label: string
  /** Modules resolvable inside the runtime image, left out of the bundle. */
  external: string[]
}

/**
 * Bundle an entry point to a single base64 blob.
 *
 * Split from launching because esbuild ships a platform-native binary, and this
 * repository is routinely edited on Windows while the AWS CLI is authenticated
 * inside WSL. A `node_modules` installed on one cannot run esbuild on the other
 * — a trap this project has hit before — and reinstalling for Linux would break
 * the Windows toolchain in the same move.
 *
 * So the two halves can run on different platforms:
 *
 *   # Windows (has the repo and a Windows esbuild)
 *   npx tsx scripts/<launcher>.ts --emit-bundle .bundle.b64
 *
 *   # WSL / CI (has an authenticated AWS CLI)
 *   npx tsx scripts/<launcher>.ts --bundle .bundle.b64
 *
 * On a machine where both work, neither flag is needed.
 */
export async function bundleEntry(spec: BundleSpec): Promise<string> {
  // Imported lazily, not at module load. esbuild resolves its native binary on
  // import, so a static import crashes on a platform whose binary is absent
  // EVEN IN --bundle mode, where esbuild is never used. That is the whole point
  // of the split, and a top-level import quietly defeats it.
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [join(process.cwd(), ...spec.entry.split('/'))],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: spec.external,
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  console.log(`  ${spec.label} bundled: ${(code.length / 1024).toFixed(1)} KB`)
  return Buffer.from(code, 'utf8').toString('base64')
}

/**
 * The bundle, however this platform can obtain it.
 *
 * A supplied bundle is checked for freshness against its source, so a stale
 * blob cannot silently run last week's logic and report PASS.
 */
export async function resolveBundle(spec: BundleSpec): Promise<string> {
  const supplied = argValue('--bundle')
  if (!supplied) return bundleEntry(spec)

  const b64 = readFileSync(supplied, 'utf8').trim()
  const srcMtime = statSync(join(process.cwd(), ...spec.entry.split('/'))).mtimeMs
  const bundleMtime = statSync(supplied).mtimeMs
  if (bundleMtime < srcMtime) {
    die(
      `${supplied} is older than ${spec.entry} — ` +
      `re-emit it, or the ${spec.label} would run stale logic and report on the wrong code`,
    )
  }
  console.log(`  using supplied bundle: ${(b64.length / 1024).toFixed(1)} KB base64`)
  return b64
}

// ── The task ─────────────────────────────────────────────────────────────────

export interface StagingTaskContext {
  net: any
  srcDef: any
  secrets: Array<{ name: string; valueFrom: string }>
}

/** Network and secrets mirrored from the staging runtime service. */
export function resolveStagingTaskContext(): StagingTaskContext {
  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SOURCE_SERVICE])
    ?.services?.[0]
  if (!svc) die(`service ${SOURCE_SERVICE} not found in ${CLUSTER}`)

  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('staging service has no awsvpc configuration to mirror')

  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SOURCE_SERVICE])
    ?.taskDefinition
  if (!srcDef) die('could not read the staging task definition')

  const secrets = stagingDbSecrets(srcDef)
  console.log(`  secrets carried: ${secrets.map(s => s.name).join(', ')}`)

  return { net, srcDef, secrets }
}

/**
 * A refusal raised inside a task body.
 *
 * `die()` calls `process.exit`, which skips `finally`. Inside a registered task
 * that meant a refused `run-task` left its task definition behind, which is the
 * one thing this module promises never to do. Throwing lets cleanup run first.
 */
export class StagingTaskRefusal extends Error {}

export function refuse(msg: string): never {
  throw new StagingTaskRefusal(msg)
}

/** A run whose own verdict passed but whose task definition could not be removed. */
export const EXIT_CLEANUP_FAILED = 3

export interface OneShotTaskSpec {
  family: string
  containerName: string
  logPrefix: string
  startedBy: string
  /**
   * Image to run. Defaults to the staging runtime image, which is what the
   * probe-style tasks want. The migration runner supplies its own, because
   * deployment tooling deliberately does not live in the application image.
   */
  image?: string
  command: string[]
  /** Launcher-specific variables. NODE_PATH is appended by this module. */
  environment: Array<{ name: string; value: string }>
  cpu: string
  memory: string
}

/**
 * Register a task definition, hand it to `body`, and deregister it afterwards
 * whatever `body` did.
 */
export async function withEphemeralTaskDefinition(
  ctx: StagingTaskContext,
  spec: OneShotTaskSpec,
  body: (taskDefArn: string) => number | Promise<number>,
): Promise<number> {
  // The payload travels in the task definition, not a RunTask override:
  // overrides are capped near 8 KB, a task definition is not.
  const container = {
    name: spec.containerName,
    image: spec.image ?? ctx.srcDef.containerDefinitions[0].image,
    essential: true,
    command: spec.command,
    environment: [
      ...spec.environment,
      // The image has a read-only root and writes nothing outside /tmp, so the
      // decoded script lives there — and Node resolves modules from the
      // SCRIPT's directory, walking /tmp/node_modules then /node_modules and
      // never reaching /app/node_modules where @prisma/client actually is.
      // NODE_PATH bridges that without needing /app to be writable.
      { name: 'NODE_PATH', value: '/app/node_modules' },
    ],
    secrets: ctx.secrets,
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': LOG_GROUP,
        'awslogs-region': EXPECTED_REGION,
        'awslogs-stream-prefix': spec.logPrefix,
      },
    },
  }

  const registerArgs = [
    'ecs', 'register-task-definition',
    '--family', spec.family,
    '--requires-compatibilities', 'FARGATE',
    '--network-mode', 'awsvpc',
    '--cpu', spec.cpu,
    '--memory', spec.memory,
    '--execution-role-arn', ctx.srcDef.executionRoleArn,
    '--container-definitions', JSON.stringify([container]),
  ]
  // No task role: a one-shot task calls no AWS API. Least privilege by omission.
  const registered = aws(registerArgs)?.taskDefinition
  const taskDefArn: string = registered.taskDefinitionArn
  console.log(`  registered ${taskDefArn.split('/').pop()}`)

  let exitCode = 1
  let cleanupFailed = false
  try {
    exitCode = await body(taskDefArn)
  } catch (err) {
    if (!(err instanceof StagingTaskRefusal)) throw err
    console.error(`\n  REFUSED: ${err.message}\n`)
    exitCode = 2
  } finally {
    // Ephemeral by construction: nothing durable is left behind in staging.
    try {
      aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
      console.log(`  deregistered ${taskDefArn.split('/').pop()}`)
    } catch (err) {
      console.error(
        `  CLEANUP FAILED: ${taskDefArn.split('/').pop()} is still registered: ` +
          (err instanceof Error ? err.message : String(err)),
      )
      console.error('  deregister it by hand; this run does not count as clean')
      cleanupFailed = true
    }
  }
  // A passing verdict with a leaked task definition is not a clean run.
  return cleanupFailed && exitCode === 0 ? EXIT_CLEANUP_FAILED : exitCode
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Every event in one log stream, in order.
 *
 * `get-log-events` returns at most 1 MB or 10,000 events per call, and the CLI
 * does not paginate it. The first version of this launcher read one page, which
 * is invisible for a few dozen rehearsal lines and silently truncates anything
 * larger. A stream has ended when AWS hands back the same forward token it was
 * given.
 */
export function readLogStream(stream: string): string[] {
  const lines: string[] = []
  let token: string | undefined
  for (let page = 0; page < 1000; page++) {
    const args = [
      'logs', 'get-log-events',
      '--log-group-name', LOG_GROUP,
      '--log-stream-name', stream,
      '--start-from-head',
    ]
    if (token) args.push('--next-token', token)
    const res = aws(args)
    for (const e of res?.events ?? []) lines.push(String(e.message))
    const next: string | undefined = res?.nextForwardToken
    if (!next || next === token) return lines
    token = next
  }
  throw new Error(`log stream ${stream} did not end within 1000 pages`)
}

export interface LogReadOptions {
  /**
   * True once the lines contain everything the launcher needs. CloudWatch can
   * still be delivering events after the task has stopped, so an incomplete
   * read is retried rather than parsed.
   */
  complete?: (lines: string[]) => boolean
  attempts?: number
  /** Which lines to echo to the console. Every line is still returned. */
  echo?: (line: string) => boolean
}

export interface OneShotTaskResult {
  lines: string[]
  /** The container's own exit code, or null if ECS did not report one. */
  containerExit: number | null
}

/** Run one task, wait for it to stop, and return its log lines. */
export function runTaskAndReadLogs(
  ctx: StagingTaskContext,
  taskDefArn: string,
  spec: OneShotTaskSpec,
  opts: LogReadOptions = {},
): string[] {
  return runTaskAndReadResult(ctx, taskDefArn, spec, opts).lines
}

/**
 * The same run, with the container's exit code kept.
 *
 * The lineage probes parse their verdict out of the logs, so the exit code is
 * noise to them. For a migration job it is the authority: `migrate deploy`
 * failing halfway still writes plenty of reassuring output, and a launcher that
 * only read the logs would report success for it.
 */
export function runTaskAndReadResult(
  ctx: StagingTaskContext,
  taskDefArn: string,
  spec: OneShotTaskSpec,
  opts: LogReadOptions = {},
): OneShotTaskResult {
  const netCfg = JSON.stringify({
    awsvpcConfiguration: {
      subnets: ctx.net.subnets,
      securityGroups: ctx.net.securityGroups,
      // Mirrors staging. These subnets default-route to an Internet Gateway,
      // not a NAT, so a task needs a public IP to reach ECR and CloudWatch.
      // It exposes no listener, and the security group still governs inbound.
      assignPublicIp: ctx.net.assignPublicIp,
    },
  })

  const run = aws([
    'ecs', 'run-task',
    '--cluster', CLUSTER,
    '--task-definition', taskDefArn,
    '--launch-type', 'FARGATE',
    '--network-configuration', netCfg,
    '--started-by', spec.startedBy,
  ])
  if (run?.failures?.length) refuse(`run-task failed: ${JSON.stringify(run.failures)}`)

  const taskArn: string = run.tasks[0].taskArn
  const taskId = taskArn.split('/').pop()!
  console.log(`  task ${taskId} starting…`)

  execFileSync('aws', [
    'ecs', 'wait', 'tasks-stopped',
    '--cluster', CLUSTER, '--tasks', taskArn,
    '--region', EXPECTED_REGION,
  ], { stdio: 'inherit' })

  const done = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn])
    ?.tasks?.[0]
  const containerExit = done?.containers?.[0]?.exitCode ?? null
  console.log(`  task stopped: ${done?.stoppedReason ?? 'n/a'} (exit ${containerExit})`)

  const stream = `${spec.logPrefix}/${spec.containerName}/${taskId}`
  const attempts = opts.attempts ?? (opts.complete ? 6 : 1)
  // Overridable so the launcher tests do not sleep; there is no reason to set
  // it for a real run.
  const pollMs = Number(process.env.STAGING_TASK_LOG_POLL_MS ?? 5000)

  let lines: string[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      lines = readLogStream(stream)
      if (!opts.complete || opts.complete(lines)) break
      if (attempt < attempts) {
        console.log(`  logs incomplete, waiting for delivery (${attempt}/${attempts})`)
      }
    } catch (err) {
      // Reporting failure, not a verdict. The launcher's result parsing is the
      // authority; crashing here would skip the cleanup that makes it ephemeral.
      console.error('  could not read task logs:', err instanceof Error ? err.message : err)
    }
    if (attempt < attempts) sleepSync(pollMs)
  }

  for (const l of lines) if (!opts.echo || opts.echo(l)) console.log(`    | ${l}`)
  return { lines, containerExit }
}
