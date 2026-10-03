/**
 * LAYER 1 PRIVILEGE JOB — grant the app role CREATE, and verify it
 * ================================================================
 *
 * Runs `tools/managed-db/sql/grant-workspace-create.sql` inside the VPC as the
 * RDS master role. It is the only thing in this repository that connects as an
 * administrative role, and it runs exactly one file, audited before it ships.
 *
 * ── Why it borrows the bootstrap task definition ───────────────────────────
 *
 * The master credential already exists in one place: the db-bootstrap task
 * definition resolves `PGPASSWORD` from the RDS-managed secret, and carries
 * PGHOST/PGPORT/PGUSER/PGDATABASE beside it. This reads that task definition and
 * reuses its image, execution role and secrets rather than introducing a second
 * path to the same credential. Nothing new gains access to it.
 *
 * ── What it can run ────────────────────────────────────────────────────────
 *
 * One file, from the repository, checked by `auditGrantSql` before it is
 * encoded. There is no `--sql`, no statement argument and no way to substitute
 * a different file: the path is a constant. A privilege job that took SQL would
 * be a superuser shell with extra steps.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   # Windows
 *   npx esbuild scripts/run-role-privilege-job.ts --bundle --platform=node \
 *     --format=cjs --outfile=<scratch>/privilege-job.cjs
 *
 *   # WSL
 *   PRIVILEGE_AWS_ACCOUNT_ID=<account> node <scratch>/privilege-job.cjs \
 *     --environment staging --confirm staging
 *
 * `--mode check` reports the privilege without granting anything, so an
 * environment can be measured before it is changed.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditGrantSql, GRANT_SQL_PATH } from '../tools/managed-db/role-privilege-spec'

const REGION = 'ap-south-1'

interface EnvTarget {
  cluster: string
  service: string
  /**
   * The family whose task definition carries this environment's RDS master
   * credential. Its execution role may only write to its OWN log group, which
   * is why the group is taken from it rather than chosen here.
   */
  adminFamily: string
}

/** Constants per environment. Nothing is derived from an argument but the key. */
const TARGETS: Record<'staging' | 'production', EnvTarget> = {
  staging: {
    cluster: 'backenly-staging',
    service: 'backenly-staging-runtime',
    adminFamily: 'backenly-staging-db-bootstrap',
  },
  production: {
    cluster: 'backenly-production',
    service: 'backenly-production-runtime',
    adminFamily: 'backenly-production-priv',
  },
}

const FAMILY = 'backenly-role-privilege-job'
const CONTAINER = 'privilege'
const LOG_PREFIX = 'privilege'

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

function readLogStream(logGroup: string, stream: string): string[] {
  const lines: string[] = []
  let token: string | undefined
  for (let page = 0; page < 1000; page++) {
    const args = ['logs', 'get-log-events', '--log-group-name', logGroup, '--log-stream-name', stream, '--start-from-head']
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
  const environment = argValue('--environment') as 'staging' | 'production' | null
  const mode = argValue('--mode') ?? 'grant'
  if (environment !== 'staging' && environment !== 'production') {
    die('--environment must be staging or production')
  }
  if (mode !== 'grant' && mode !== 'check') die('--mode must be grant or check')
  if (argValue('--confirm') !== environment) {
    die(`--confirm must be exactly "${environment}"`)
  }

  const expectedAccount = process.env.PRIVILEGE_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!expectedAccount) die('PRIVILEGE_AWS_ACCOUNT_ID is not set; it is deliberately not hardcoded')

  const target = TARGETS[environment]
  const root = process.cwd()
  const sql = readFileSync(join(root, GRANT_SQL_PATH), 'utf8')

  // Audited on the bytes about to be shipped, not on a copy.
  const findings = auditGrantSql(sql)
  if (findings.length > 0) {
    for (const f of findings) console.error(`  ${f.why}: ${f.statement}`)
    die(`${GRANT_SQL_PATH} contains statements outside its permitted vocabulary`)
  }
  console.log(`\nLayer 1 privilege job — ${mode} on ${environment}\n`)
  console.log(`  audited ${GRANT_SQL_PATH}: only GRANT CREATE ON DATABASE ... TO backenly_user`)

  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== expectedAccount) die(`account is ${id?.Account}, expected ${expectedAccount}`)
  console.log(`  account ${id.Account} · region ${REGION} · cluster ${target.cluster}`)

  const svc = aws(['ecs', 'describe-services', '--cluster', target.cluster, '--services', target.service])?.services?.[0]
  if (!svc) die(`service ${target.service} not found in ${target.cluster}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('service has no awsvpc configuration to mirror')

  const bootstrap = aws(['ecs', 'describe-task-definition', '--task-definition', target.adminFamily])?.taskDefinition
  if (!bootstrap) die(`could not read ${target.adminFamily}`)
  const src = bootstrap.containerDefinitions[0]

  // Its own log group. The execution role is scoped to it, and a task pointed
  // at any other group fails at start with AccessDeniedException on
  // CreateLogStream — measured, not guessed.
  const logGroup: string = src.logConfiguration?.options?.['awslogs-group']
  if (!logGroup) die(`${target.adminFamily} has no awslogs group to borrow`)

  // The master password only. Nothing else from that task definition's secret
  // list is carried: this job needs one credential and no application secrets.
  const pgpassword = (src.secrets ?? []).find((s: any) => s.name === 'PGPASSWORD')
  if (!pgpassword) die(`${target.adminFamily} does not expose PGPASSWORD`)

  // Host and database come from THIS environment's runtime service, not from
  // the borrowed bootstrap definition, which is staging's.
  const runtimeDef = aws(['ecs', 'describe-task-definition', '--task-definition', target.service])?.taskDefinition
  const dbSecret = (runtimeDef?.containerDefinitions?.[0]?.secrets ?? []).find((s: any) => s.name === 'DATABASE_URL')
  if (!dbSecret) die(`${target.service} does not expose DATABASE_URL`)
  if (environment === 'production' && !/production/i.test(dbSecret.valueFrom)) {
    die(`DATABASE_URL does not identify a production resource: ${dbSecret.valueFrom}`)
  }
  if (environment === 'staging' && !/staging/i.test(dbSecret.valueFrom)) {
    die(`DATABASE_URL does not identify a staging resource: ${dbSecret.valueFrom}`)
  }

  // Read from the borrowed definition, never written here: this repository is
  // public and an RDS endpoint does not belong in it.
  const env = (name: string): string | null =>
    (src.environment ?? []).find((e: any) => e.name === name)?.value ?? null
  const host = env('PGHOST')
  if (!host) die(`${target.adminFamily} does not carry PGHOST`)
  if (!host.includes(environment)) die(`PGHOST does not identify ${environment}`)
  const masterUser = env('PGUSER') ?? 'backenly_admin'
  const database = env('PGDATABASE') ?? 'backenly'

  // `check` runs the same file with the GRANT removed, so measuring an
  // environment cannot change it.
  const shipped = mode === 'check' ? sql.replace(/^GRANT\s+CREATE[^;]*;$/gim, '\\echo (check mode: GRANT skipped)') : sql
  const encoded = Buffer.from(shipped, 'utf8').toString('base64')

  const container = {
    name: CONTAINER,
    image: src.image,
    essential: true,
    command: [
      'sh',
      '-c',
      `echo ${encoded} | base64 -d > /tmp/grant.sql && exec psql -v ON_ERROR_STOP=1 -v enforce=${mode === 'grant'} -f /tmp/grant.sql`,
    ],
    environment: [
      { name: 'PGHOST', value: host },
      { name: 'PGPORT', value: env('PGPORT') ?? '5432' },
      { name: 'PGDATABASE', value: database },
      { name: 'PGUSER', value: masterUser },
      { name: 'PGSSLMODE', value: 'require' },
      { name: 'HOME', value: '/tmp' },
    ],
    secrets: [pgpassword],
    logConfiguration: {
      logDriver: 'awslogs',
      options: { 'awslogs-group': logGroup, 'awslogs-region': REGION, 'awslogs-stream-prefix': LOG_PREFIX },
    },
  }

  console.log(`  database ${database} · as ${masterUser} · logs ${logGroup}`)
  console.log(`  secrets carried: PGPASSWORD (RDS master) only`)

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
      '--execution-role-arn', bootstrap.executionRoleArn,
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
      '--cluster', target.cluster,
      '--task-definition', taskDefArn,
      '--launch-type', 'FARGATE',
      '--network-configuration', netCfg,
      '--started-by', `role-privilege-${mode}`,
    ])
    if (started?.failures?.length) throw new Error(`run-task failed: ${JSON.stringify(started.failures)}`)

    const taskArn: string = started.tasks[0].taskArn
    const taskId = taskArn.split('/').pop()!
    console.log(`  task ${taskId} starting…`)
    execFileSync('aws', ['ecs', 'wait', 'tasks-stopped', '--cluster', target.cluster, '--tasks', taskArn, '--region', REGION], {
      stdio: 'inherit',
    })
    const done = aws(['ecs', 'describe-tasks', '--cluster', target.cluster, '--tasks', taskArn])?.tasks?.[0]
    const containerExit: number | null = done?.containers?.[0]?.exitCode ?? null
    console.log(`  task stopped: ${done?.stoppedReason ?? 'n/a'} (exit ${containerExit})`)

    let lines: string[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        lines = readLogStream(logGroup, `${LOG_PREFIX}/${CONTAINER}/${taskId}`)
        if (lines.length > 0) break
      } catch (err) {
        console.error('  could not read task logs:', err instanceof Error ? err.message : err)
      }
      if (attempt < 6) sleep(Number(process.env.PRIVILEGE_LOG_POLL_MS ?? 5000))
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
