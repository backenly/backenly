/**
 * LAUNCHER FOR THE ONE-SHOT DATA-PLANE MEMBERSHIP REPAIR — STAGING
 * ================================================================
 *
 * Runs `scripts/data-plane-membership-repair.ts` inside the staging VPC as a
 * single Fargate task, using a dedicated execution role that exists only for
 * this repair (`backenly-staging-dbrepair-exec`, declared in backenly-infra and
 * removed after use).
 *
 * ── Why it does not reuse the acceptance launcher ───────────────────────────
 *
 * That launcher carries the qualification fixture. This one carries the RDS
 * master credential. Keeping them apart is what stops a privileged grant from
 * being one flag away from a test run — the same reason the production
 * launchers are separate files.
 *
 * ── How the credential travels ──────────────────────────────────────────────
 *
 * By reference, never by value. The master secret is injected by the ECS agent
 * from Secrets Manager into `ADMIN_SECRET_JSON`; it is never read by this
 * process, never passed as an argument, and never written into the task
 * definition. The task definition is deregistered when the run ends.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   REHEARSAL_AWS_ACCOUNT_ID=<account> \
 *     npx tsx scripts/run-data-plane-repair-fargate.ts --confirm-repair
 */

import { execFileSync } from 'node:child_process'
import { brotliCompressSync, constants } from 'node:zlib'

const REGION = 'ap-south-1'
const CLUSTER = 'backenly-staging'
const SERVICE = 'backenly-staging-runtime'
const LOG_GROUP = '/ecs/backenly-staging/runtime'
const LOG_PREFIX = 'dbrepair'
const FAMILY = 'backenly-staging-dbrepair'
const CONTAINER = 'dbrepair'
const EXEC_ROLE = 'backenly-staging-dbrepair-exec'

const ENTRY = 'scripts/data-plane-membership-repair.ts'
const RESULT_MARKER = 'REPAIR-RESULT '

const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/dbrepair.cjs',z.brotliDecompressSync(Buffer.from(process.env.REPAIR_B64,'base64')));" +
  "require('/tmp/dbrepair.cjs')"

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

const sleep = (ms: number) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readLogStream(stream: string): string[] {
  const lines: string[] = []
  let token: string | undefined
  for (let page = 0; page < 200; page++) {
    const args = ['logs', 'get-log-events', '--log-group-name', LOG_GROUP, '--log-stream-name', stream, '--start-from-head']
    if (token) args.push('--next-token', token)
    const res = aws(args)
    for (const e of res?.events ?? []) lines.push(String(e.message))
    const next: string | undefined = res?.nextForwardToken
    if (!next || next === token) return lines
    token = next
  }
  return lines
}

async function main(): Promise<number> {
  if (!process.argv.includes('--confirm-repair')) {
    die('this performs a privileged GRANT; pass --confirm-repair deliberately')
  }

  const expectedAccount = process.env.REHEARSAL_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!expectedAccount) die('REHEARSAL_AWS_ACCOUNT_ID is not set; it is deliberately not hardcoded')
  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== expectedAccount) die(`account is ${id?.Account}, expected ${expectedAccount}`)
  if (!CLUSTER.includes('staging')) die(`cluster "${CLUSTER}" is not staging`)
  console.log(`  account ${id.Account} · region ${REGION} · cluster ${CLUSTER}`)

  const { build } = await import('esbuild')
  const built = await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['@prisma/client', '.prisma/client', 'pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
    write: false,
    logLevel: 'silent',
  })
  const payload = brotliCompressSync(Buffer.from(built.outputFiles[0].text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64')
  console.log(`  repair bundled: ${(built.outputFiles[0].text.length / 1024).toFixed(1)} KB`)

  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE])?.services?.[0]
  if (!svc) die(`service ${SERVICE} not found`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('no awsvpc configuration to mirror')
  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SERVICE])?.taskDefinition
  if (!srcDef) die('could not read the staging task definition')

  const env: Array<{ name: string; value: string }> = srcDef.containerDefinitions?.[0]?.environment ?? []
  const backenlyEnv = env.find(e => e.name === 'BACKENLY_ENV')?.value
  if (backenlyEnv !== 'staging') die(`the deployed task definition says BACKENLY_ENV=${backenlyEnv}, not staging`)

  const appSecret = (srcDef.containerDefinitions?.[0]?.secrets ?? []).find((s: any) => s.name === 'DATABASE_URL')
  if (!appSecret) die('the staging task definition exposes no DATABASE_URL secret')
  if (!/staging/i.test(appSecret.valueFrom) || /production/i.test(appSecret.valueFrom)) {
    die(`DATABASE_URL does not resolve to a staging resource: ${appSecret.valueFrom}`)
  }

  // The RDS-managed master secret, read as an ARN from the instance itself.
  const inst = aws(['rds', 'describe-db-instances', '--db-instance-identifier', 'backenly-staging-pg'])
    ?.DBInstances?.[0]
  const masterArn: string | undefined = inst?.MasterUserSecret?.SecretArn
  if (!masterArn) die('the staging instance has no RDS-managed master secret')
  if (inst?.MasterUsername !== 'backenly_admin') {
    die(`master username is ${inst?.MasterUsername}, not the expected owner role`)
  }
  console.log(`  master secret: ${masterArn.split(':').pop()} (injected by reference, never read here)`)

  const role = aws(['iam', 'get-role', '--role-name', EXEC_ROLE])?.Role
  if (!role) die(`${EXEC_ROLE} does not exist; apply the backenly-infra change that declares it`)

  const container = {
    name: CONTAINER,
    image: srcDef.containerDefinitions[0].image,
    essential: true,
    command: ['sh', '-c', 'exec node -e "$REPAIR_BOOTSTRAP"'],
    environment: [
      { name: 'REPAIR_BOOTSTRAP', value: BOOTSTRAP },
      { name: 'REPAIR_B64', value: payload },
      { name: 'NODE_PATH', value: '/app/node_modules' },
      { name: 'BACKENLY_ENV', value: 'staging' },
      { name: 'EXPECT_ENVIRONMENT', value: 'staging' },
      { name: 'CONFIRM_REPAIR', value: 'grant-membership' },
    ],
    secrets: [
      { name: 'DATABASE_URL', valueFrom: appSecret.valueFrom },
      { name: 'ADMIN_SECRET_JSON', valueFrom: masterArn },
    ],
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
    '--execution-role-arn', role.Arn,
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
      '--started-by', 'data-plane-membership-repair',
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
      } catch { /* delivery lag */ }
      if (attempt < 6) sleep(5000)
    }

    const line = lines.find(l => l.includes(RESULT_MARKER))
    if (!line) {
      console.error('  no REPAIR-RESULT line in the task logs')
      console.error(lines.slice(-20).join('\n'))
      exit = 1
    } else {
      const parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length))
      console.log(`\n${JSON.stringify(parsed, null, 2)}\n`)
      exit = parsed.ok === true && containerExit === 0 ? 0 : 2
    }
  } finally {
    try {
      aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
      console.log(`  deregistered ${taskDefArn.split('/').pop()}`)
    } catch {
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
