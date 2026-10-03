/**
 * ENUM OWNERSHIP REPAIR — for databases that already completed the app-role cutover
 * ===============================================================================
 *
 *   # Windows (tsx cannot run from WSL: node_modules holds a win32 esbuild)
 *   npx esbuild scripts/run-enum-ownership-repair.ts --bundle --platform=node \
 *     --format=cjs --outfile=<scratch>/enum-repair.cjs
 *
 *   # WSL (authenticated AWS CLI), report first, always
 *   ENUM_REPAIR_AWS_ACCOUNT_ID=<account> ENUM_REPAIR_DB_NAME=<database> \
 *     node <scratch>/enum-repair.cjs --environment staging --mode check --confirm staging
 *   ENUM_REPAIR_AWS_ACCOUNT_ID=<account> ENUM_REPAIR_DB_NAME=<database> \
 *     node <scratch>/enum-repair.cjs --environment staging --mode apply --confirm staging --confirm-apply
 *
 * Runs tools/managed-db/sql/enum-ownership-repair.sql as the admin role, in a
 * one-shot Fargate task inside the VPC, using the admin family's image,
 * execution role and master password. It carries NO application secret and
 * writes nothing to Secrets Manager. Unlike run-app-role-cutover.ts, it cannot
 * rotate a password: the SQL is audited for that before it leaves this machine.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * The cutover moved public relations and functions to backenly_app and left
 * every enum with the admin role. The first migration to ALTER an enum
 * (20260924120000_project_pause) then failed on staging with 42501. The cutover
 * now moves enums too, but re-running it on a database that already completed
 * it would rotate the application credential for no reason. This does only the
 * part that was missing.
 *
 * ── Guards, at the same depths as run-production-migration-job.ts ───────────
 *
 *   ENUM_REPAIR_AWS_ACCOUNT_ID  which AWS account; never hardcoded, the
 *                               repository is public.
 *   names                       cluster, service and admin family must all
 *                               name the environment and not the other one.
 *   the RDS instance            the admin family's PGHOST must BE the endpoint
 *                               of backenly-<env>-pg, and its password must come
 *                               from that instance's own master secret.
 *   ENUM_REPAIR_DB_NAME         must equal the admin family's PGDATABASE, and
 *                               is checked AGAIN inside the SQL against the
 *                               database the connection actually reached.
 *
 * `check` changes nothing and prints current owner -> desired owner. `apply`
 * needs --confirm-apply as well as --confirm <env>, and prints the same table
 * before and after.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ENUM_REPAIR_SQL_PATH,
  auditEnumRepairSql,
  buildEnumRepairScript,
  parseRepairResult,
} from '../tools/managed-db/enum-ownership-repair'

const REGION = 'ap-south-1'
const FAMILY = 'backenly-enum-ownership-repair'
const CONTAINER = 'repair'
const LOG_PREFIX = 'enum-repair'
const APP_ROLE = 'backenly_app'

type Environment = 'staging' | 'production'

interface EnvTarget {
  cluster: string
  service: string
  adminFamily: string
  dbInstance: string
}

// The same admin families run-app-role-cutover.ts uses.
const TARGETS: Record<Environment, EnvTarget> = {
  staging: {
    cluster: 'backenly-staging',
    service: 'backenly-staging-runtime',
    adminFamily: 'backenly-staging-db-bootstrap',
    dbInstance: 'backenly-staging-pg',
  },
  production: {
    cluster: 'backenly-production',
    service: 'backenly-production-runtime',
    adminFamily: 'backenly-production-priv',
    dbInstance: 'backenly-production-pg',
  },
}

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
  const environment = argValue('--environment') as Environment | null
  const mode = argValue('--mode') ?? 'check'
  if (environment !== 'staging' && environment !== 'production') die('--environment must be staging or production')
  if (mode !== 'check' && mode !== 'apply') die('--mode must be check or apply')
  if (argValue('--confirm') !== environment) die(`--confirm must be exactly "${environment}"`)
  if (mode === 'apply' && !process.argv.includes('--confirm-apply')) {
    die('apply changes the owner of enum types in a real database; run --mode check first, then pass --confirm-apply')
  }

  const expectedAccount = process.env.ENUM_REPAIR_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!expectedAccount) die('ENUM_REPAIR_AWS_ACCOUNT_ID is not set; it is deliberately not hardcoded')
  const database = process.env.ENUM_REPAIR_DB_NAME?.trim() ?? ''
  if (!database) die('ENUM_REPAIR_DB_NAME is not set; state the database this job is allowed to touch')

  const other: Environment = environment === 'staging' ? 'production' : 'staging'
  const target = TARGETS[environment]
  for (const [what, name] of Object.entries({ cluster: target.cluster, service: target.service, family: target.adminFamily })) {
    if (!name.includes(environment) || name.includes(other)) die(`${what} "${name}" does not name ${environment} alone`)
  }

  const sql = readFileSync(join(process.cwd(), ENUM_REPAIR_SQL_PATH), 'utf8')
  const findings = auditEnumRepairSql(sql)
  if (findings.length > 0) {
    for (const f of findings) console.error(`  ${f.why}: ${f.statement}`)
    die(`${ENUM_REPAIR_SQL_PATH} contains statements outside its permitted vocabulary`)
  }

  console.log(`\nEnum ownership repair — ${mode} on ${environment}\n`)
  console.log(`  audited ${ENUM_REPAIR_SQL_PATH}: DO blocks only, one dynamic statement (ALTER TYPE ... OWNER TO)`)

  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== expectedAccount) die(`account is ${id?.Account}, expected ${expectedAccount}`)

  const svc = aws(['ecs', 'describe-services', '--cluster', target.cluster, '--services', target.service])?.services?.[0]
  if (!svc) die(`service ${target.service} not found in ${target.cluster}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('service has no awsvpc configuration to mirror')

  const admin = aws(['ecs', 'describe-task-definition', '--task-definition', target.adminFamily])?.taskDefinition
  if (!admin) die(`could not read ${target.adminFamily}`)
  const src = admin.containerDefinitions[0]
  const env = (name: string): string | null =>
    (src.environment ?? []).find((e: any) => e.name === name)?.value ?? null

  const logGroup: string = src.logConfiguration?.options?.['awslogs-group']
  if (!logGroup) die(`${target.adminFamily} has no awslogs group to borrow`)
  if (!logGroup.includes(environment) || logGroup.includes(other)) die(`log group ${logGroup} does not name ${environment} alone`)

  const pgpassword = (src.secrets ?? []).find((s: any) => s.name === 'PGPASSWORD')
  if (!pgpassword) die(`${target.adminFamily} does not expose PGPASSWORD`)

  const host = env('PGHOST')
  if (!host) die(`${target.adminFamily} does not carry PGHOST`)
  const masterUser = env('PGUSER') ?? 'backenly_admin'
  const port = env('PGPORT') ?? '5432'
  if ((env('PGDATABASE') ?? 'backenly') !== database) {
    die(`${target.adminFamily} connects to "${env('PGDATABASE') ?? 'backenly'}", but ENUM_REPAIR_DB_NAME is "${database}"`)
  }

  // The pointers, checked against the thing they point at. A PGHOST that merely
  // CONTAINS the environment's name passes for a typo'd or copied value; the
  // instance's own endpoint and master secret do not.
  const instance = aws(['rds', 'describe-db-instances', '--db-instance-identifier', target.dbInstance])?.DBInstances?.[0]
  if (!instance) die(`RDS instance ${target.dbInstance} not found`)
  if (instance.Endpoint?.Address !== host) {
    die(`PGHOST ${host} is not the endpoint of ${target.dbInstance} (${instance.Endpoint?.Address})`)
  }
  const masterSecret: string | undefined = instance.MasterUserSecret?.SecretArn
  if (masterSecret && !String(pgpassword.valueFrom).startsWith(masterSecret)) {
    die(`PGPASSWORD does not come from ${target.dbInstance}'s own master secret`)
  }
  if (instance.MasterUsername && instance.MasterUsername !== masterUser) {
    console.log(`  note: connecting as ${masterUser}; the instance's master is ${instance.MasterUsername}`)
  }

  console.log(`  account ${id.Account} · ${database} on ${target.dbInstance} · as ${masterUser}`)

  const script = buildEnumRepairScript(sql, { apply: mode === 'apply', database, appRole: APP_ROLE })
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  const command = `echo ${encoded} | base64 -d > /tmp/repair.sql && exec psql -X -v ON_ERROR_STOP=1 -f /tmp/repair.sql`

  const container = {
    name: CONTAINER,
    image: src.image,
    essential: true,
    command: ['sh', '-c', command],
    environment: [
      { name: 'PGHOST', value: host },
      { name: 'PGPORT', value: port },
      { name: 'PGDATABASE', value: database },
      { name: 'PGUSER', value: masterUser },
      { name: 'PGSSLMODE', value: 'require' },
      { name: 'HOME', value: '/tmp' },
    ],
    // The admin password and nothing else. No application secret is carried.
    secrets: [pgpassword],
    logConfiguration: {
      logDriver: 'awslogs',
      options: { 'awslogs-group': logGroup, 'awslogs-region': REGION, 'awslogs-stream-prefix': LOG_PREFIX },
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
      '--cpu', '256',
      '--memory', '512',
      '--execution-role-arn', admin.executionRoleArn,
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
      '--started-by', `enum-ownership-repair-${mode}`,
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
        if (parseRepairResult(lines.join('\n')) || (lines.length > 0 && containerExit !== 0)) break
        if (attempt < 6) console.log(`  logs incomplete, waiting for delivery (${attempt}/6)`)
      } catch (err) {
        console.error('  could not read task logs:', err instanceof Error ? err.message : err)
      }
      if (attempt < 6) sleep(5000)
    }
    for (const l of lines) console.log(`    | ${l}`)

    const result = parseRepairResult(lines.join('\n'))
    if (containerExit !== 0) {
      console.error(`\n  FAILED: the repair exited ${containerExit}. It runs in one transaction, so nothing changed.`)
      exitCode = 1
    } else if (!result) {
      console.error('\n  FAILED: exited 0 but no REPAIR_RESULT line was observed; not a success')
      exitCode = 1
    } else if (result.mode !== (mode === 'apply' ? 'apply' : 'report')) {
      console.error(`\n  FAILED: asked for ${mode} but the database reports mode=${result.mode}`)
      exitCode = 1
    } else {
      console.log(
        `\n  ${result.mode}: would_move=${result.wouldMove} moved=${result.moved} ` +
          `not_owned_by_${APP_ROLE}=${result.notOwnedByAppRole}`,
      )
      exitCode = 0
    }
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
