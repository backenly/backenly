/**
 * PRODUCTION MAINTENANCE JOB — the entry point, run in the production VPC
 * =======================================================================
 *
 * Runs `tools/maintenance-runner` as a one-shot Fargate task in the production
 * cluster. It passes IDENTIFIERS ONLY: the project, the finding, the plan, the
 * plan version, the mode. No plan contents are serialised into the task
 * definition — the container rebuilds the plan from the live database, which is
 * the whole reason `--plan` and `--plan-version` are assertions rather than
 * lookup keys. Anything serialised here would be a second copy of the plan that
 * could disagree with the database.
 *
 * ── Same shape as the production migration launcher, for the same reasons ──
 *
 * Its own file rather than a flag on a staging launcher. Its own constants. The
 * same three guards at the same three depths:
 *
 *   PRODUCTION_AWS_ACCOUNT_ID   which AWS account, never hardcoded
 *   the secret's ARN            must name a production resource, never staging
 *   EXPECT_DATABASE             checked INSIDE the container, against the URL
 *                               it actually connected with
 *
 * The first two are checks on pointers and pass whether or not the secret's
 * contents point where the ARN suggests. The third is the one that sees the
 * thing itself.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   # Windows (tsx cannot run from WSL: node_modules holds a win32 esbuild)
 *   npx esbuild scripts/run-production-maintenance-job.ts --bundle \
 *     --platform=node --format=cjs --outfile=<scratch>/prod-maintenance.cjs
 *
 *   # WSL (authenticated AWS CLI)
 *   PRODUCTION_AWS_ACCOUNT_ID=<account> PRODUCTION_DB_NAME=<database> \
 *     node <scratch>/prod-maintenance.cjs \
 *       --image <ecr uri> --project <id> --finding <id> \
 *       --plan <id> --plan-version <hash> --mode dry-run
 *
 * `dry-run` writes nothing and needs no confirmation. `execute` needs
 * `--confirm "<project>:<plan>:<planVersion>"` AND the deployment flag, which
 * this launcher passes through from its own environment and cannot invent.
 */

import { execFileSync } from 'node:child_process'

const REGION = 'ap-south-1'
const CLUSTER = 'backenly-production'
const SERVICE = 'backenly-production-runtime'
const LOG_GROUP = '/ecs/backenly-production/runtime'
const LOG_PREFIX = 'maintenance'
const FAMILY = 'backenly-production-maintenance-job'
const CONTAINER = 'maintenance'

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

function productionSecrets(taskDef: any): Array<{ name: string; valueFrom: string }> {
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
  const image = argValue('--image')
  // Which entry point in the image. Both target production and both carry the
  // same guards, so this selects a job rather than an environment — the thing a
  // flag must never select is which database it reaches.
  const job = argValue('--job') ?? 'maintenance'
  if (job !== 'maintenance' && job !== 'fixture') die('--job must be maintenance or fixture')
  const projectId = argValue('--project')
  const findingId = argValue('--finding')
  const planId = argValue('--plan')
  const planVersion = argValue('--plan-version')
  const mode = argValue('--mode')

  if (!image) die('--image is required')
  if (!/^\d+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\//.test(image)) die(`--image is not an ECR image: ${image}`)
  if (!/:maintenance-[0-9a-f]{7,40}$/.test(image)) {
    die(`--image must carry a maintenance-<git sha> tag, not a floating one: ${image}`)
  }
  const database = process.env.PRODUCTION_DB_NAME?.trim()
  if (!database) die('PRODUCTION_DB_NAME is not set; state the database this job is allowed to touch')

  const environment: Array<{ name: string; value: string }> = [
    { name: 'EXPECT_DATABASE', value: database },
  ]
  let command: string[]
  let entryPoint: string[] | undefined

  if (job === 'fixture') {
    // The acceptance fixture. A project id and a confirmation, and nothing else
    // reaches it: the schema, the tables, the columns and every statement are
    // fixed in scripts/maintenance-acceptance-fixture.ts.
    if (mode !== 'prepare' && mode !== 'cleanup' && mode !== 'inspect') {
      die('--mode must be prepare, cleanup or inspect for --job fixture')
    }
    entryPoint = ['node', '/app/fixture.cjs']

    if (mode === 'prepare') {
      // The product mints the project id, so there is none to pass or confirm
      // against. The confirmation is the marker name the fixture will create
      // with, which is also the only project it will ever touch.
      const marker = 'maintenance-prod-acceptance'
      if (argValue('--confirm') !== marker) die(`--confirm must be exactly "${marker}"`)
      command = ['--mode', 'prepare', '--confirm', marker]
    } else {
      if (!projectId) die('--project is required')
      command = ['--mode', mode, '--project', projectId]
      // `inspect` writes nothing, so it needs no confirmation. Cleanup takes a
      // different one from prepare, so a shell-history re-run cannot delete the
      // evidence prepare just created.
      if (mode === 'cleanup') {
        if (argValue('--confirm-destroy') !== projectId) {
          die(`--confirm-destroy must be exactly "${projectId}"`)
        }
        command.push('--confirm-destroy', projectId)
      }
    }

    console.log(`
Production acceptance fixture — ${mode}
`)
    await runTask({ image, entryPoint, command, environment, database, label: `fixture-${mode}` })
    return
  }

  if (!projectId || !findingId || !planId || !planVersion) {
    die('--project, --finding, --plan and --plan-version are all required')
  }
  if (mode !== 'dry-run' && mode !== 'execute') die('--mode must be dry-run or execute')

  // Identifiers only. Nothing about the plan's CONTENTS crosses this boundary.
  command = [
    '--project', projectId,
    '--finding', findingId,
    '--plan', planId,
    '--plan-version', planVersion,
    '--mode', mode,
  ]

  // Inline JSON, on the command rather than in the environment: the container
  // has no file to read, and this is the operator's mapping, not the plan. The
  // plan itself is still rebuilt inside the container.
  //
  // Carried for BOTH modes. A dry run without bindings cannot report whether
  // they are complete, and cannot name the column whose readers it inventories,
  // which is most of what the report is for.
  const bindings = argValue('--bindings-json')
  if (bindings) {
    try {
      JSON.parse(bindings)
    } catch {
      die('--bindings-json is not valid JSON')
    }
    command.push('--bindings-json', bindings)
  }

  // Passed through from this shell, never invented here. The container's own
  // flag check is what actually decides, and it reads this value.
  //
  // A dry run reads it too, and must: "would this rung execute" is a different
  // question from "would it execute in an environment that forbids writing",
  // and the first is the one an operator is asking. The dry run still writes
  // nothing — the flag changes what it REPORTS, not what it does.
  if (process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS) {
    environment.push({ name: 'ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS', value: 'true' })
  }

  if (mode === 'execute') {
    const expected = `${projectId}:${planId}:${planVersion}`
    if (argValue('--confirm') !== expected) die(`--confirm must be exactly "${expected}"`)
    command.push('--confirm', expected)
    if (!bindings) die('--bindings-json <json> is required to execute')
    if (!process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS) {
      die('ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS is not set in this shell; nothing here can turn mutations on')
    }
  }

  for (const name of ['AUTONOMY_LEVEL', 'MAINTENANCE_APPROVED_PLAN_VERSION', 'MAINTENANCE_APPROVAL_ID']) {
    const v = process.env[name]?.trim()
    if (v) environment.push({ name, value: v })
  }

  console.log(`\nProduction maintenance job — ${mode}\n`)
  await runTask({ image, entryPoint, command, environment, database, label: `maintenance-${mode}` })
}

interface TaskSpec {
  image: string
  /** Set only for the fixture, which lives behind the image's default. */
  entryPoint?: string[]
  command: string[]
  environment: Array<{ name: string; value: string }>
  database: string
  label: string
}

/** Register, run, read the logs, deregister. Identical for both jobs. */
async function runTask(spec: TaskSpec): Promise<void> {
  const { image, command, environment, database } = spec
  assertProductionAccount()

  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE])?.services?.[0]
  if (!svc) die(`service ${SERVICE} not found in ${CLUSTER}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('production service has no awsvpc configuration to mirror')
  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SERVICE])?.taskDefinition
  if (!srcDef) die('could not read the production task definition')
  const secrets = productionSecrets(srcDef)

  // The edition seam. `currentEdition()` defaults to single-tenant when this is
  // unset, and single-tenant refuses to create a second project — so a fixture
  // task without it cannot use the product's own provisioning path. Read from
  // the web service's own definition rather than asserted here, so this job
  // runs as the edition production actually is.
  const webDef = aws(['ecs', 'describe-task-definition', '--task-definition', 'backenly-production-web'])?.taskDefinition
  const edition = (webDef?.containerDefinitions?.[0]?.environment ?? [])
    .find((e: any) => e.name === 'BACKENLY_EDITION')?.value
  if (!edition) die('backenly-production-web does not declare BACKENLY_EDITION')
  environment.push({ name: 'BACKENLY_EDITION', value: String(edition) })
  console.log(`  edition: ${edition} (from backenly-production-web)`)

  console.log(`  secrets carried: ${secrets.map(s => s.name).join(', ')}`)
  console.log(`  expected database: ${database}`)
  console.log(`  image ${image}`)
  console.log(`  command ${command.join(' ')}`)

  const container = {
    name: CONTAINER,
    image,
    essential: true,
    ...(spec.entryPoint ? { entryPoint: spec.entryPoint } : {}),
    command,
    environment,
    secrets,
    logConfiguration: {
      logDriver: 'awslogs',
      options: { 'awslogs-group': LOG_GROUP, 'awslogs-region': REGION, 'awslogs-stream-prefix': LOG_PREFIX },
    },
  }

  let taskDefArn: string | null = null
  let exitCode = 1
  try {
    const registered = aws([
      'ecs', 'register-task-definition',
      '--family', FAMILY,
      '--requires-compatibilities', 'FARGATE',
      '--network-mode', 'awsvpc',
      '--cpu', '1024',
      '--memory', '2048',
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
      '--started-by', `production-${spec.label}`,
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
      if (attempt < 6) sleep(Number(process.env.MAINTENANCE_LOG_POLL_MS ?? 5000))
    }
    for (const l of lines) console.log(`    | ${l}`)

    exitCode = containerExit === 0 ? 0 : 1
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
