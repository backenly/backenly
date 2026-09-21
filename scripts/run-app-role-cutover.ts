/**
 * LAYER 1 — move the application off the rotating RDS master credential
 * =====================================================================
 *
 *   # Windows
 *   npx esbuild scripts/run-app-role-cutover.ts --bundle --platform=node \
 *     --format=cjs --outfile=<scratch>/cutover.cjs
 *
 *   # WSL
 *   CUTOVER_AWS_ACCOUNT_ID=<account> node <scratch>/cutover.cjs \
 *     --environment staging --mode check   --confirm staging
 *   CUTOVER_AWS_ACCOUNT_ID=<account> node <scratch>/cutover.cjs \
 *     --environment staging --mode apply   --confirm staging
 *
 * A SIBLING of run-role-privilege-job.ts, not an extension of it. That job's
 * audit forbids ALTER ROLE, OWNER TO, CREATEROLE and DROP on purpose — it
 * exists to grant exactly one privilege, and widening its vocabulary to fit
 * this would turn it into the general "apply whatever the manifest says" loop
 * its own header warns against. So this carries its OWN narrow vocabulary for
 * its own one file, and borrows only the mechanism: the db-bootstrap task
 * definition's image, execution role and RDS master secret, run inside the VPC.
 *
 * ── How the new password reaches the database without being exposed ────────
 *
 * The execution role's secret list is an explicit set of ARNs, not a wildcard,
 * so a brand-new secret would need an IAM change before a task could read it.
 * `backenly-<env>/database-url` is already in that list.
 *
 * So the new connection string is written to that secret as a PENDING version
 * and the cutover task reads it by stage. ECS injects AWSCURRENT unless a stage
 * is named, which means:
 *
 *   - running web/runtime tasks keep reading the OLD, still-working AWSCURRENT
 *     and are undisturbed;
 *   - the cutover task reads AWSPENDING, and is the only thing that does;
 *   - AWSCURRENT is moved onto the new version only AFTER the database has
 *     actually been cut over.
 *
 * There is therefore no window in which the current credential is wrong, which
 * matters because production is live while this runs. The password is never a
 * task-definition environment value: `describe-task-definition` shows those to
 * anyone who can read ECS.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const REGION = 'ap-south-1'
const SQL_PATH = join('tools', 'managed-db', 'sql', 'app-role-cutover.sql')
const FAMILY = 'backenly-app-role-cutover'
const CONTAINER = 'cutover'
const LOG_PREFIX = 'cutover'
const APP_ROLE = 'backenly_app'

interface EnvTarget {
  cluster: string
  service: string
  adminFamily: string
}

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

/**
 * This file's permitted vocabulary. Narrow for a different reason than the
 * privilege job's: that one may grant one privilege, this one may create ONE
 * named role and move ownership to it, and must never widen a role.
 */
const FORBIDDEN = [
  { pattern: /(?<!NO)\bSUPERUSER\b/i, why: 'the whole point is that the app role is not one' },
  { pattern: /(?<!NO)\bBYPASSRLS\b/i, why: 'RLS is the tenant boundary' },
  { pattern: /(?<!NO)\bCREATEROLE\b/i, why: 'one role is created, by this file, not by the role' },
  { pattern: /(?<!NO)\bCREATEDB\b/i, why: 'the role creates schemas, not databases' },
  { pattern: /\bREASSIGN\s+OWNED\b/i, why: 'sweeps up the SECURITY DEFINER support objects' },
  { pattern: /\bDROP\b/i, why: 'this script creates and re-owns, never drops' },
  { pattern: /\bGRANT\s+ALL\b/i, why: 'privileges are named' },
  { pattern: /\bTO\s+PUBLIC\b/i, why: 'granted to one named role' },
  { pattern: /\bCOPY\b/i, why: 'no data movement' },
]

const ALLOWED_STATEMENT = [/^SELECT\b/i, /^DO\s+\$\$/i]

interface AuditFinding {
  statement: string
  why: string
}

export function auditCutoverSql(sql: string): AuditFinding[] {
  const findings: AuditFinding[] = []

  // Comments name the very things the file refuses to do, and the DO block's
  // RAISE messages quote them back. Neither is executable, so both come out
  // before the forbidden sweep, exactly as the privilege job does it.
  const withoutComments = sql
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
  const executable = withoutComments.replace(/'(?:[^']|'')*'/g, "''")

  for (const { pattern, why } of FORBIDDEN) {
    const m = executable.match(pattern)
    if (m) findings.push({ statement: m[0], why })
  }

  const withoutBlocks = withoutComments.replace(/DO\s+\$\$[\s\S]*?\$\$/gi, '__DO_BLOCK__')
  const statements = withoutBlocks
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('\\'))
    .join('\n')
    .split(/;\s*(?=\n|$)/)
    .map(s => s.trim())
    .filter(Boolean)

  for (const statement of statements) {
    if (statement === '__DO_BLOCK__') continue
    if (!ALLOWED_STATEMENT.some(p => p.test(statement))) {
      findings.push({ statement: statement.slice(0, 120), why: 'not in the allowed statement vocabulary' })
    }
  }

  return findings
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
    const args = [
      'logs', 'get-log-events',
      '--log-group-name', logGroup,
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

const sleep = (ms: number) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Hex, so it never needs escaping inside a URL. A `@` or `/` in a password
 *  breaks DATABASE_URL in ways that surface as an unrelated connection error. */
const generatePassword = () => randomBytes(32).toString('hex')

async function main(): Promise<void> {
  const environment = argValue('--environment') as 'staging' | 'production' | null
  const mode = argValue('--mode') ?? 'check'
  if (environment !== 'staging' && environment !== 'production') {
    die('--environment must be staging or production')
  }
  if (mode !== 'check' && mode !== 'apply') die('--mode must be check or apply')
  if (argValue('--confirm') !== environment) die(`--confirm must be exactly "${environment}"`)

  const expectedAccount = process.env.CUTOVER_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!expectedAccount) die('CUTOVER_AWS_ACCOUNT_ID is not set; it is deliberately not hardcoded')

  const target = TARGETS[environment]
  const sql = readFileSync(join(process.cwd(), SQL_PATH), 'utf8')

  const findings = auditCutoverSql(sql)
  if (findings.length > 0) {
    for (const f of findings) console.error(`  ${f.why}: ${f.statement}`)
    die(`${SQL_PATH} contains statements outside its permitted vocabulary`)
  }

  console.log(`\nApp-role cutover — ${mode} on ${environment}\n`)
  console.log(`  audited ${SQL_PATH}: no SUPERUSER, no BYPASSRLS, no REASSIGN OWNED, no DROP`)

  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== expectedAccount) die(`account is ${id?.Account}, expected ${expectedAccount}`)

  const svc = aws(['ecs', 'describe-services', '--cluster', target.cluster, '--services', target.service])?.services?.[0]
  if (!svc) die(`service ${target.service} not found in ${target.cluster}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('service has no awsvpc configuration to mirror')

  const bootstrap = aws(['ecs', 'describe-task-definition', '--task-definition', target.adminFamily])?.taskDefinition
  if (!bootstrap) die(`could not read ${target.adminFamily}`)
  const src = bootstrap.containerDefinitions[0]

  const logGroup: string = src.logConfiguration?.options?.['awslogs-group']
  if (!logGroup) die(`${target.adminFamily} has no awslogs group to borrow`)

  const pgpassword = (src.secrets ?? []).find((s: any) => s.name === 'PGPASSWORD')
  if (!pgpassword) die(`${target.adminFamily} does not expose PGPASSWORD`)

  // ── The carrier ──────────────────────────────────────────────────────────
  //
  // The task has to READ the new password, and it can only read secrets its
  // execution role is scoped to — an explicit ARN list, not a wildcard.
  //
  // staging's db-bootstrap happens to carry DATABASE_URL, so the app secret is
  // its own carrier. production-priv is deliberately minimal and carries only
  // PGPASSWORD, so a carrier must be named: --carrier-secret. It is written as
  // AWSPENDING only, which nothing reads, and removed afterwards. Granting the
  // priv role a new secret would be an IAM change to the most privileged role
  // in the account, which is a worse trade than borrowing one it already has.
  const carrierOverride = argValue('--carrier-secret')
  const dbUrlSecret = (src.secrets ?? []).find((s: any) => s.name === 'DATABASE_URL')
  // Only an apply needs one: a measurement sets no password.
  if (mode === 'apply' && !carrierOverride && !dbUrlSecret) {
    die(
      `${target.adminFamily} exposes no DATABASE_URL to carry the new password. ` +
        `Pass --carrier-secret <arn> naming a secret its execution role can already read.`,
    )
  }
  if (dbUrlSecret && !new RegExp(environment, 'i').test(dbUrlSecret.valueFrom)) {
    die(`DATABASE_URL does not identify a ${environment} resource: ${dbUrlSecret.valueFrom}`)
  }

  const env = (name: string): string | null =>
    (src.environment ?? []).find((e: any) => e.name === name)?.value ?? null
  const host = env('PGHOST')
  if (!host) die(`${target.adminFamily} does not carry PGHOST`)
  if (!host.includes(environment)) die(`PGHOST does not identify ${environment}`)
  const masterUser = env('PGUSER') ?? 'backenly_admin'
  const database = env('PGDATABASE') ?? 'backenly'
  const port = env('PGPORT') ?? '5432'

  console.log(`  account ${id.Account} · ${database} on ${environment} · as ${masterUser}`)

  // ── Stage the new credential, when applying ───────────────────────────────
  //
  // Written as AWSPENDING. ECS injects AWSCURRENT unless a stage is named, so
  // every running task keeps the credential it already has and nothing is
  // disturbed until the cutover has actually happened.
  let pendingVersionId: string | null = null

  const arnOf = (idOrArn: string): string => {
    const d = aws(['secretsmanager', 'describe-secret', '--secret-id', idOrArn])
    if (!d?.ARN) die(`cannot resolve secret ${idOrArn}`)
    return String(d.ARN)
  }

  // Where the TASK reads the password from.
  const carrierArn: string = carrierOverride
    ? arnOf(carrierOverride)
    : dbUrlSecret
      ? String(dbUrlSecret.valueFrom).split(':').slice(0, 7).join(':')
      : ''

  // The secrets the APPLICATION reads, which this process rewrites with its own
  // credentials rather than the task's. DIRECT_URL is the unpooled connection
  // Prisma uses for migrations: left on the master while DATABASE_URL moves,
  // the next rotation breaks migrations instead of the app, which is the same
  // bug wearing a different hat.
  const appSecretArn: string = arnOf(`backenly-${environment}/database-url`)
  const directArn: string | null = (() => {
    try {
      return arnOf(`backenly-${environment}/direct-url`)
    } catch {
      return null
    }
  })()

  if (mode === 'apply') {
    const password = generatePassword()
    const newUrl = `postgresql://${APP_ROLE}:${password}@${host}:${port}/${database}?sslmode=require`
    const stage = (arn: string, label: string) => {
      const res = aws([
        'secretsmanager', 'put-secret-value',
        '--secret-id', arn,
        '--secret-string', newUrl,
        '--version-stages', 'AWSPENDING',
      ])
      const v = String(res?.VersionId ?? '')
      if (!v) die(`put-secret-value returned no VersionId for ${label}`)
      console.log(`  staged AWSPENDING on ${label} (${v.slice(0, 8)}…)`)
      return v
    }

    // The carrier first: this is the one the task will read.
    pendingVersionId = stage(carrierArn, 'carrier')
    if (carrierArn !== appSecretArn) stage(appSecretArn, 'DATABASE_URL')
    if (directArn && directArn !== carrierArn) stage(directArn, 'DIRECT_URL')
    console.log(`  AWSCURRENT is untouched everywhere, so running tasks keep working`)
  }

  const encoded = Buffer.from(sql, 'utf8').toString('base64')

  // The password is lifted out of the staged URL INSIDE the container and put
  // into an environment variable that psql reads with \getenv. It never appears
  // in a task definition, an argument list or this repository.
  const command =
    mode === 'apply'
      ? `BACKENLY_APP_PASSWORD=$(printf '%s' "$APP_DATABASE_URL" | sed -E 's#^[^:]+://[^:]+:([^@]*)@.*#\\1#') ` +
        `sh -c 'echo ${encoded} | base64 -d > /tmp/cutover.sql && exec psql -v ON_ERROR_STOP=1 -v apply=true -f /tmp/cutover.sql'`
      : `echo ${encoded} | base64 -d > /tmp/cutover.sql && exec psql -v ON_ERROR_STOP=1 -v apply=false -f /tmp/cutover.sql`

  const secrets: any[] = [pgpassword]
  if (mode === 'apply') {
    // Named by STAGE, which is what keeps this the only reader of the new value.
    secrets.push({ name: 'APP_DATABASE_URL', valueFrom: `${carrierArn}::AWSPENDING:` })
  }

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
    secrets,
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
      '--cpu', '512',
      '--memory', '1024',
      '--execution-role-arn', bootstrap.executionRoleArn,
      '--container-definitions', JSON.stringify([container]),
    ])?.taskDefinition
    if (!registered?.taskDefinitionArn) throw new Error('register-task-definition returned no taskDefinitionArn')
    taskDefArn = String(registered.taskDefinitionArn)

    const netCfg = JSON.stringify({
      awsvpcConfiguration: {
        subnets: net.subnets,
        securityGroups: net.securityGroups,
        assignPublicIp: net.assignPublicIp,
      },
    })
    const started = aws([
      'ecs', 'run-task',
      '--cluster', target.cluster,
      '--task-definition', taskDefArn,
      '--launch-type', 'FARGATE',
      '--network-configuration', netCfg,
      '--started-by', `app-role-cutover-${mode}`,
    ])
    if (started?.failures?.length) throw new Error(`run-task failed: ${JSON.stringify(started.failures)}`)

    const taskArn: string = started.tasks[0].taskArn
    const taskId = taskArn.split('/').pop()!
    console.log(`  task ${taskId} starting…`)
    execFileSync(
      'aws',
      ['ecs', 'wait', 'tasks-stopped', '--cluster', target.cluster, '--tasks', taskArn, '--region', REGION],
      { stdio: 'inherit' },
    )
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
      if (attempt < 6) sleep(5000)
    }
    for (const l of lines) console.log(`    | ${l}`)

    exitCode = containerExit === 0 ? 0 : 1

    // ── Promote, only on success ────────────────────────────────────────────
    //
    // The database now accepts the new credential, so AWSCURRENT may point at
    // it. Until this moment a rollback was a no-op: nothing read AWSPENDING.
    if (mode === 'apply' && exitCode === 0 && pendingVersionId) {
      // The version losing the label has to be named. Secrets Manager refuses a
      // move that does not say what it is replacing:
      //   "The parameter RemoveFromVersionId can't be empty. Staging label
      //    AWSCURRENT is currently attached to version ..."
      const promote = (arn: string, label: string) => {
        const stages = aws(['secretsmanager', 'list-secret-version-ids', '--secret-id', arn])
        const versions = stages?.Versions ?? []
        const outgoing: string | undefined = versions.find((v: any) =>
          (v.VersionStages ?? []).includes('AWSCURRENT'),
        )?.VersionId
        const incoming: string | undefined = versions.find((v: any) =>
          (v.VersionStages ?? []).includes('AWSPENDING'),
        )?.VersionId
        if (!outgoing) throw new Error(`${label}: no version currently holds AWSCURRENT`)
        if (!incoming) throw new Error(`${label}: nothing staged as AWSPENDING`)
        aws([
          'secretsmanager', 'update-secret-version-stage',
          '--secret-id', arn,
          '--version-stage', 'AWSCURRENT',
          '--move-to-version-id', incoming,
          '--remove-from-version-id', outgoing,
        ])
        console.log(`  ${label}: AWSCURRENT -> ${incoming.slice(0, 8)}…`)
      }

      promote(appSecretArn, 'DATABASE_URL')
      if (directArn) promote(directArn, 'DIRECT_URL')

      // A borrowed carrier is not one of the application's secrets, so the
      // staged value is removed rather than left sitting in someone else's
      // secret. Dropping the AWSPENDING label deletes that version.
      if (carrierArn !== appSecretArn && pendingVersionId) {
        try {
          aws([
            'secretsmanager', 'update-secret-version-stage',
            '--secret-id', carrierArn,
            '--version-stage', 'AWSPENDING',
            '--remove-from-version-id', pendingVersionId,
          ])
          console.log(`  carrier: staged value removed`)
        } catch (err) {
          console.error(`  WARNING: could not clear the carrier's AWSPENDING version:`,
            err instanceof Error ? err.message : err)
        }
      }
      console.log(`\n  AWSCURRENT now points at the ${APP_ROLE} connection.`)
      console.log(`  Redeploy ${target.cluster} web and runtime so the tasks read it.`)
    } else if (mode === 'apply' && exitCode !== 0) {
      console.error(`\n  The cutover FAILED, so AWSCURRENT was left alone and still holds the`)
      console.error(`  working ${masterUser} connection. Nothing is broken by this attempt.`)
    }
  } catch (err) {
    console.error(`\n  ERROR: ${err instanceof Error ? err.message : String(err)}`)
    exitCode = 2
  } finally {
    if (taskDefArn) {
      try {
        aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
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
