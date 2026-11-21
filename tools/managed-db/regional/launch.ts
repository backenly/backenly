/**
 * RUN THE REGIONAL DATABASE PROCEDURE ON BACKENLY CLOUD
 * =====================================================
 * The operator's half of bootstrap.sh on AWS. It starts the procedure as the
 * region's one-off ECS task, reads the task's log back, and keeps the
 * credentials the procedure sets in the region's Secrets Manager secrets:
 *
 *   npx tsx tools/managed-db/regional/launch.ts check --config launch.json
 *   npx tsx tools/managed-db/regional/launch.ts apply --config launch.json [--rotate backenly_app,...]
 *   npx tsx tools/managed-db/regional/launch.ts template --config launch.json
 *   npx tsx tools/managed-db/regional/launch.ts project-dbs --config launch.json --databases <file>|none
 *
 * launch.json is the region stack's db_procedure_launch_config output
 * (backenly-infra, aws/REGIONS_RUNBOOK.md): identifiers, never a secret value.
 * Its `secrets.dbcreator`, where present, is where the password of the role
 * that creates project databases is kept; without it that role is not made.
 *
 * A project can have a database of its own on the region's instance, cloned
 * from a template. `template` builds or converges that template, and
 * `project-dbs` converges every project database, after an apply of the
 * region's database. `--databases` names the project databases the platform
 * knows in the region, one per line in a file (or `none`); the procedure
 * refuses, touching nothing, unless they are exactly the ones it finds, and
 * reports one line per database, which this launcher counts.
 * AWS calls go through the AWS CLI on PATH with the credentials in the
 * environment (AWS_PROFILE), so this adds no dependency. Linux or macOS: secret
 * values reach the CLI on /dev/stdin, through a real pipe (awsCli).
 *
 * A PASSWORD GOES NOWHERE BUT ITS SECRET. Each is generated here (scram.ts),
 * written to its secret through the CLI's standard input, never an argument,
 * and given to the procedure only as its SCRAM verifier. The task definition,
 * the task's overrides, its log and this script's output hold no password.
 *
 * NO HALF-SET CREDENTIAL. A new connection string is stored as an AWSPENDING
 * version of its secret and becomes AWSCURRENT only after the procedure has set
 * that password, so a run that fails or is refused leaves every service's
 * current secret as it was, and the next run starts over.
 *
 * ONE RUN AT A TIME. A run of the procedure's task family that is still going
 * refuses another.
 *
 * A CHECK THAT DOES NOT VERIFY FAILS, with one exception. Once every step has
 * been applied, `check` on its own, and the check that closes an apply, fail on
 * anything the database does not verify. The check an apply runs first is told
 * it is one (BOOTSTRAP_PRE_APPLY=true, bootstrap.sh): it reports what steps
 * changed since they were applied have not converged yet without failing on it,
 * because that is exactly what this apply converges, and the apply then fails
 * the run if the database still does not verify.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { generatePassword, scramSha256Verifier } from './scram'

export interface LaunchConfig {
  region: string
  cluster: string
  taskDefinition: string
  container: string
  subnets: string[]
  securityGroup: string
  logGroup: string
  logStreamPrefix: string
  database: { host: string; port: number; name: string }
  secrets: { app: string; direct: string; backup: string; authenticator: string; postgrestJwt: string; dbcreator?: string }
}

export type Mode = 'check' | 'apply' | 'template' | 'project-dbs'
const MODES: Mode[] = ['check', 'apply', 'template', 'project-dbs']

/** The login roles the procedure sets passwords for, and where each password is kept. */
export const ROLES = {
  backenly_app: { verifier: 'BACKENLY_APP_VERIFIER', secrets: ['app', 'direct'] },
  backenly_backup: { verifier: 'BACKENLY_BACKUP_VERIFIER', secrets: ['backup'] },
  backenly_authenticator: { verifier: 'BACKENLY_AUTHENTICATOR_VERIFIER', secrets: ['authenticator'] },
  // Made only where the region's config names its secret (sql/roles.sql makes
  // it only when given its verifier).
  backenly_dbcreator: { verifier: 'BACKENLY_DBCREATOR_VERIFIER', secrets: ['dbcreator'] },
} as const satisfies Record<string, { verifier: string; secrets: ReadonlyArray<keyof LaunchConfig['secrets']> }>

export type ManagedRole = keyof typeof ROLES
const MANAGED_ROLES = Object.keys(ROLES) as ManagedRole[]
/** The roles every region has. */
export const REQUIRED_ROLES: ManagedRole[] = ['backenly_app', 'backenly_backup', 'backenly_authenticator']

/** The roles this region's procedure manages: every region's, and the database creator where its secret is configured. */
export function managedRoles(config: LaunchConfig): ManagedRole[] {
  return config.secrets.dbcreator ? [...REQUIRED_ROLES, 'backenly_dbcreator'] : [...REQUIRED_ROLES]
}

/** A refusal: the inputs or the database's state rule the run out before anything is written. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

// ── Arguments and configuration ──────────────────────────────────────────────

export interface Args {
  mode: Mode
  configPath: string
  rotate: ManagedRole[]
  /** project-dbs only: a file listing the project databases, or 'none'. */
  databases?: string
}

export function parseArgs(argv: string[]): Args {
  const [mode, ...rest] = argv
  if (!MODES.includes(mode as Mode)) {
    throw new Refusal(
      'usage: launch.ts check|apply|template|project-dbs --config <launch.json> [--rotate role,...] [--databases <file>|none]',
    )
  }
  let configPath: string | undefined
  let rotate: ManagedRole[] = []
  let databases: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (flag === '--config' && value) {
      configPath = value
      i++
    } else if (flag === '--rotate' && value) {
      const roles = value.split(',').map((r) => r.trim()).filter(Boolean)
      const unknown = roles.filter((r) => !MANAGED_ROLES.includes(r as ManagedRole))
      if (unknown.length) throw new Refusal(`--rotate names roles this procedure does not manage: ${unknown.join(', ')}`)
      rotate = [...new Set(roles as ManagedRole[])]
      i++
    } else if (flag === '--databases' && value) {
      databases = value
      i++
    } else {
      throw new Refusal(`unexpected argument: ${flag}`)
    }
  }
  if (!configPath) throw new Refusal('--config <launch.json> is required')
  if (mode === 'check' && rotate.length) throw new Refusal('--rotate is for apply; check writes nothing')
  if (mode !== 'apply' && mode !== 'check' && rotate.length) throw new Refusal(`--rotate is for apply, not ${mode}`)
  if (mode === 'project-dbs' && !databases) {
    throw new Refusal('project-dbs needs --databases: a file naming the project databases the platform knows in the region, one per line, or none')
  }
  if (mode !== 'project-dbs' && databases) throw new Refusal('--databases is for project-dbs')
  return { mode: mode as Mode, configPath, rotate, ...(databases ? { databases } : {}) }
}

const PROJECT_DATABASE = /^p_[0-9a-f]{32}$/

/** The project databases a --databases file names: one per line (commas and spaces also separate), or none. */
export function readDatabaseList(text: string): string[] {
  const names = [...new Set(text.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean))].sort()
  const wrong = names.filter((n) => !PROJECT_DATABASE.test(n))
  if (wrong.length) throw new Refusal(`not project database names (p_<32 lowercase hex>): ${wrong.slice(0, 5).join(', ')}`)
  return names
}

/**
 * What the procedure is given as BOOTSTRAP_PROJECT_DATABASES: `none`, the
 * names, or, for a list too long for a task's environment (ECS caps a task's
 * overrides at 8 KiB), the sha256 of the names sorted, each followed by a
 * newline, exactly as bootstrap.sh hashes the ones it finds.
 */
export function projectDatabasesInput(names: string[]): string {
  if (names.length === 0) return 'none'
  const sorted = [...names].sort()
  if (sorted.length <= 100) return sorted.join(',')
  return `sha256:${createHash('sha256').update(sorted.map((n) => `${n}\n`).join('')).digest('hex')}`
}

/** The region stack's db_procedure_launch_config output, checked before anything runs. */
export function loadConfig(json: string): LaunchConfig {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Refusal('the config is not JSON: write it with `terraform output -json db_procedure_launch_config`')
  }
  const c = raw as Partial<LaunchConfig>
  const present = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  if (!c || typeof c !== 'object') throw new Refusal('the config is not an object')
  if (!present(c.region)) throw new Refusal('the config names no region')
  if (c.taskDefinition === null) {
    throw new Refusal('the region has no procedure task definition yet: pin db_procedure_image_digest in its stack and apply it first')
  }
  for (const key of ['cluster', 'taskDefinition', 'container', 'securityGroup', 'logGroup', 'logStreamPrefix'] as const) {
    if (!present(c[key])) throw new Refusal(`the config has no ${key}`)
  }
  if (!Array.isArray(c.subnets) || c.subnets.length === 0 || !c.subnets.every(present)) throw new Refusal('the config has no subnets')
  const db = c.database
  if (!db || !present(db.host) || !present(db.name) || !Number.isInteger(db.port)) throw new Refusal('the config has no database host, port and name')
  const secrets = c.secrets
  for (const key of ['app', 'direct', 'backup', 'authenticator', 'postgrestJwt', 'dbcreator'] as const) {
    const arn = secrets?.[key]
    // The database creator's is optional: a region without it makes no such role.
    if (key === 'dbcreator' && (arn === undefined || arn === null)) continue
    if (!present(arn)) throw new Refusal(`the config has no ${key} secret`)
    // A credential for this region's database is kept in this region, never elsewhere.
    if (!arn!.startsWith(`arn:aws:secretsmanager:${c.region}:`)) throw new Refusal(`the ${key} secret is not in ${c.region}: ${arn}`)
  }
  if (secrets && secrets.dbcreator === null) delete secrets.dbcreator
  return c as LaunchConfig
}

// ── What the procedure reports ───────────────────────────────────────────────

export type CredentialState = 'missing' | 'unrecorded' | 'recorded'

export type ProjectDatabaseState = 'current' | 'applied' | 'failed'

export interface Report {
  steps: Record<string, string>
  credentials: Partial<Record<ManagedRole, { state: CredentialState; at?: string }>>
  /** project-dbs: each database's line, and what it applied or where it failed. */
  databases: Record<string, { state: ProjectDatabaseState; detail?: string }>
  summary: string | null
}

/** The lines bootstrap.sh prints for a launcher (its "Output a launcher may read"). */
export function parseReport(lines: string[]): Report {
  const report: Report = { steps: {}, credentials: {}, databases: {}, summary: null }
  for (const line of lines) {
    const step = /^\s*step ([a-z][a-z-]*): (current|changed|pending|applied|re-applied)\b/.exec(line)
    if (step) report.steps[step[1]] = step[2]
    const credential = /^\s*credential (backenly_[a-z_]+): (missing|unrecorded|recorded)\b(?: (\d{4}-\d{2}-\d{2}T\S+))?/.exec(line)
    if (credential && MANAGED_ROLES.includes(credential[1] as ManagedRole)) {
      report.credentials[credential[1] as ManagedRole] = { state: credential[2] as CredentialState, at: credential[3] }
    }
    const database = /^\s*db (p_[0-9a-f]{32}): (current|applied|failed)(?: (\S+))?\s*$/.exec(line)
    if (database) {
      report.databases[database[1]] = { state: database[2] as ProjectDatabaseState, ...(database[3] ? { detail: database[3] } : {}) }
    }
    if (/^(Regional database initialised|Check only:|Project database template (converged|NOT converged)|Project databases(:| converged))/.test(line.trim())) {
      report.summary = line.trim()
    }
  }
  return report
}

/**
 * The roles this apply sets a password for: every role the database does not
 * have yet, and every recorded one named in --rotate. A role that exists but
 * that this procedure never set is refused, as roles.sql refuses it: something
 * else made it, and that has to be understood before anything replaces its
 * password. `roles` is what the region manages (managedRoles).
 */
export function planCredentials(report: Report, rotate: ManagedRole[], roles: ManagedRole[] = REQUIRED_ROLES): ManagedRole[] {
  const plan: ManagedRole[] = []
  for (const role of roles) {
    const credential = report.credentials[role]
    if (!credential) throw new Refusal(`the check did not report ${role}; its output is not one this launcher reads`)
    if (credential.state === 'unrecorded') {
      throw new Refusal(`${role} exists, but this procedure never set its password. Find out what created it before anything here touches it.`)
    }
    if (credential.state === 'missing' || rotate.includes(role)) plan.push(role)
  }
  return plan
}

/** Every step current and every credential recorded: a database the procedure has finished. */
export function auditReport(report: Report, roles: ManagedRole[] = REQUIRED_ROLES): string[] {
  const problems: string[] = []
  const steps = Object.entries(report.steps)
  if (steps.length === 0) problems.push('the check reported no steps')
  for (const [id, state] of steps) if (state !== 'current') problems.push(`step ${id} is ${state}, not current`)
  for (const role of roles) {
    const state = report.credentials[role]?.state
    if (state !== 'recorded') problems.push(`credential ${role} is ${state ?? 'not reported'}, not recorded`)
  }
  return problems
}

export function connectionString(role: ManagedRole, password: string, db: LaunchConfig['database']): string {
  return `postgresql://${role}:${encodeURIComponent(password)}@${db.host}:${db.port}/${encodeURIComponent(db.name)}?sslmode=require`
}

// ── AWS ──────────────────────────────────────────────────────────────────────

/** One AWS CLI call: its arguments, and what it reads on standard input. Resolves to stdout. */
export type Aws = (args: string[], stdin?: string) => Promise<string>

/** The real AWS CLI, in one region, answering JSON. `env` is the CLI's environment (PATH, AWS_PROFILE). */
export function awsCli(region: string, env: NodeJS.ProcessEnv = process.env): Aws {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const full = [...args, '--region', region, '--output', 'json']
      // The CLI reads `file:///dev/stdin` by opening that path, and on Linux the
      // standard input Node gives a child is a socket, which /dev/stdin cannot
      // open (ENXIO). Through `cat` the CLI gets a real pipe; the input still
      // passes only through memory and the kernel, never a file or an argument.
      const child =
        process.platform === 'win32'
          ? spawn('aws', full, { stdio: ['pipe', 'pipe', 'pipe'], env })
          : spawn('/bin/sh', ['-c', 'cat | exec aws "$@"', 'aws', ...full], { stdio: ['pipe', 'pipe', 'pipe'], env })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${err.trim()}`))))
      child.stdin.end(stdin ?? '')
    })
}

export interface Deps {
  aws: Aws
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  pollMs?: number
  timeoutMs?: number
}

export interface ProcedureRun {
  taskArn: string
  exitCode: number | null
  stoppedReason: string | null
  lines: string[]
}

const familyOf = (taskDefinition: string) => taskDefinition.replace(/^arn:aws:ecs:[^:]+:\d+:task-definition\//, '').replace(/:\d+$/, '')
const taskIdOf = (taskArn: string) => taskArn.split('/').pop()!

/** Start the procedure with `env` over its task definition's, wait for it, and read its log. */
export async function runProcedure(config: LaunchConfig, env: Record<string, string>, deps: Deps): Promise<ProcedureRun> {
  const { aws, sleep } = deps
  const family = familyOf(config.taskDefinition)
  const running = JSON.parse(await aws(['ecs', 'list-tasks', '--cluster', config.cluster, '--family', family, '--desired-status', 'RUNNING']))
  if ((running.taskArns ?? []).length > 0) {
    throw new Refusal(`a run of ${family} is still going (${running.taskArns.join(', ')}): one run at a time`)
  }

  // The identifiers as arguments; the task's environment, which carries the
  // verifiers on apply, on standard input, so they are not in this machine's
  // process list. Not --cli-input-json: the CLI reads that value twice (once to
  // load the file, once more to parse it), so from a pipe it arrives empty.
  const networkConfiguration = {
    awsvpcConfiguration: { subnets: config.subnets, securityGroups: [config.securityGroup], assignPublicIp: 'DISABLED' },
  }
  const overrides = {
    containerOverrides: [{ name: config.container, environment: Object.entries(env).map(([name, value]) => ({ name, value })) }],
  }
  const started = JSON.parse(
    await aws(
      [
        'ecs', 'run-task',
        '--cluster', config.cluster,
        '--task-definition', config.taskDefinition,
        '--launch-type', 'FARGATE',
        '--count', '1',
        '--started-by', 'backenly-db-procedure',
        '--network-configuration', JSON.stringify(networkConfiguration),
        '--overrides', 'file:///dev/stdin',
      ],
      JSON.stringify(overrides),
    ),
  )
  if ((started.failures ?? []).length > 0 || !started.tasks?.[0]?.taskArn) {
    throw new Error(`the task did not start: ${JSON.stringify(started.failures ?? [])}`)
  }
  const taskArn: string = started.tasks[0].taskArn

  const pollMs = deps.pollMs ?? 5_000
  const timeoutMs = deps.timeoutMs ?? 20 * 60_000
  let waited = 0
  let task: { lastStatus?: string; stoppedReason?: string; containers?: Array<{ name: string; exitCode?: number }> } | undefined
  for (;;) {
    task = JSON.parse(await aws(['ecs', 'describe-tasks', '--cluster', config.cluster, '--tasks', taskArn])).tasks?.[0]
    if (task?.lastStatus === 'STOPPED') break
    if (waited >= timeoutMs) {
      throw new Error(`${taskArn} has not stopped after ${Math.round(timeoutMs / 60_000)} minutes. It is still running; the next run refuses until it stops.`)
    }
    await sleep(pollMs)
    waited += pollMs
  }
  const container = task.containers?.find((c) => c.name === config.container)
  return {
    taskArn,
    exitCode: typeof container?.exitCode === 'number' ? container.exitCode : null,
    stoppedReason: task.stoppedReason ?? null,
    lines: await readLog(config, taskIdOf(taskArn), deps),
  }
}

/** The task's log, from its first line. CloudWatch can lag the task's stop by seconds. */
async function readLog(config: LaunchConfig, taskId: string, deps: Deps): Promise<string[]> {
  const stream = `${config.logStreamPrefix}/${config.container}/${taskId}`
  for (let attempt = 0; ; attempt++) {
    try {
      const lines: string[] = []
      let token: string | undefined
      for (;;) {
        const args = ['logs', 'get-log-events', '--log-group-name', config.logGroup, '--log-stream-name', stream, '--start-from-head']
        if (token) args.push('--next-token', token)
        const page = JSON.parse(await deps.aws(args))
        for (const event of page.events ?? []) lines.push(String(event.message))
        if (!page.nextForwardToken || page.nextForwardToken === token) break
        token = page.nextForwardToken
      }
      if (lines.length > 0 || attempt >= 5) return lines
    } catch (err) {
      if (attempt >= 5) throw err
    }
    await deps.sleep(deps.pollMs ?? 5_000)
  }
}

async function versionStages(aws: Aws, arn: string): Promise<Record<string, string[]>> {
  return JSON.parse(await aws(['secretsmanager', 'describe-secret', '--secret-id', arn])).VersionIdsToStages ?? {}
}

const currentVersion = (stages: Record<string, string[]>) => Object.entries(stages).find(([, s]) => s.includes('AWSCURRENT'))?.[0]

/** Store a value as AWSPENDING: no service reads it until it is promoted. */
async function putPending(aws: Aws, arn: string, value: string): Promise<string> {
  const put = JSON.parse(await aws(['secretsmanager', 'put-secret-value', '--secret-id', arn, '--secret-string', 'file:///dev/stdin', '--version-stages', 'AWSPENDING'], value))
  return put.VersionId
}

/** Make a pending version the current one, and drop the pending label. */
async function promote(aws: Aws, arn: string, versionId: string): Promise<void> {
  const current = currentVersion(await versionStages(aws, arn))
  if (current !== versionId) {
    const args = ['secretsmanager', 'update-secret-version-stage', '--secret-id', arn, '--version-stage', 'AWSCURRENT', '--move-to-version-id', versionId]
    if (current) args.push('--remove-from-version-id', current)
    await aws(args)
  }
  await aws(['secretsmanager', 'update-secret-version-stage', '--secret-id', arn, '--version-stage', 'AWSPENDING', '--remove-from-version-id', versionId])
}

/** The region's PostgREST JWT secret, created once. Replacing it is a coordinated restart, not this. */
async function ensureJwtSecret(aws: Aws, arn: string): Promise<'created' | 'kept'> {
  if (currentVersion(await versionStages(aws, arn))) return 'kept'
  await aws(['secretsmanager', 'put-secret-value', '--secret-id', arn, '--secret-string', 'file:///dev/stdin'], generatePassword())
  return 'created'
}

// ── The run ──────────────────────────────────────────────────────────────────

function printRun(label: string, run: ProcedureRun, log: Deps['log']): void {
  log(`── ${label}: ${run.taskArn}`)
  for (const line of run.lines) log(`   | ${line}`)
  log(`── ${label}: exit ${run.exitCode ?? 'unknown'}${run.stoppedReason ? ` (${run.stoppedReason})` : ''}`)
}

/**
 * check: report only. apply: converge, keep the credentials, check again.
 * template: build or converge the template project databases are cloned from.
 * project-dbs: converge every project database, given the ones the platform
 * knows. Resolves to the exit code.
 */
export async function launch(
  mode: Mode,
  config: LaunchConfig,
  rotate: ManagedRole[],
  deps: Deps,
  options: { databases?: string[] } = {},
): Promise<number> {
  const { aws, log } = deps
  log(`Regional database procedure, ${mode}: ${config.database.host}/${config.database.name} in ${config.region}`)

  if (mode === 'template') {
    const run = await runProcedure(config, { BOOTSTRAP_MODE: 'template' }, deps)
    printRun('template', run, log)
    if (run.exitCode !== 0) {
      log('The template did not converge. Nothing can be cloned from it until a template run succeeds.')
      return 1
    }
    log('The project database template is converged and verified.')
    return 0
  }

  if (mode === 'project-dbs') {
    if (!options.databases) throw new Refusal('project-dbs needs the project databases the platform knows in the region')
    const listed = options.databases
    const run = await runProcedure(
      config,
      { BOOTSTRAP_MODE: 'project-dbs', BOOTSTRAP_PROJECT_DATABASES: projectDatabasesInput(listed) },
      deps,
    )
    printRun('project-dbs', run, log)
    const found = parseReport(run.lines).databases
    const counts: Record<ProjectDatabaseState, number> = { current: 0, applied: 0, failed: 0 }
    for (const { state } of Object.values(found)) counts[state]++
    const failed = Object.entries(found).filter(([, d]) => d.state === 'failed')
    const unreported = listed.filter((name) => !found[name])
    log(`Project databases: ${listed.length} listed, ${counts.current} current, ${counts.applied} applied, ${counts.failed} failed.`)
    for (const [name, d] of failed) log(`NOT DONE: ${name} failed at ${d.detail ?? 'an unknown step'}`)
    if (run.exitCode === 0 && unreported.length) {
      for (const name of unreported) log(`NOT DONE: ${name} was not reported`)
    }
    if (run.exitCode !== 0 && Object.keys(found).length === 0) log('The procedure converged no project database; its log above says why.')
    return run.exitCode === 0 && failed.length === 0 && unreported.length === 0 ? 0 : 1
  }

  const roles = managedRoles(config)
  const unmanaged = rotate.filter((role) => !roles.includes(role))
  if (unmanaged.length) {
    throw new Refusal(`--rotate names ${unmanaged.join(', ')}, which this region does not manage: its config names no secret for it`)
  }

  // Only the check this apply runs first is a pre-apply check (see the header).
  const before = await runProcedure(
    config,
    mode === 'apply' ? { BOOTSTRAP_MODE: 'check', BOOTSTRAP_PRE_APPLY: 'true' } : { BOOTSTRAP_MODE: 'check' },
    deps,
  )
  printRun('check', before, log)
  if (before.exitCode !== 0) {
    log('The check failed. Nothing was written.')
    return 1
  }
  if (mode === 'check') return 0

  const found = parseReport(before.lines)
  const planned = planCredentials(found, rotate, roles)

  const jwt = await ensureJwtSecret(aws, config.secrets.postgrestJwt)
  log(`PostgREST JWT secret: ${jwt === 'created' ? 'created' : 'kept (it already had a value)'}`)

  const env: Record<string, string> = { BOOTSTRAP_MODE: 'apply' }
  const pending: Array<{ key: string; arn: string; versionId: string }> = []
  for (const role of planned) {
    const password = generatePassword()
    env[ROLES[role].verifier] = scramSha256Verifier(password)
    const url = connectionString(role, password, config.database)
    for (const key of ROLES[role].secrets) {
      const arn = config.secrets[key]
      if (!arn) throw new Refusal(`the config has no ${key} secret for ${role}`)
      pending.push({ key, arn, versionId: await putPending(aws, arn, url) })
    }
  }
  // The roles whose existing password is replaced; a missing one is simply set.
  const rotating = rotate.filter((role) => found.credentials[role]?.state === 'recorded')
  if (rotating.length) env.BOOTSTRAP_ROTATE = rotating.join(',')
  log(planned.length ? `Setting passwords for: ${planned.join(', ')} (stored as pending until the procedure has set them)` : 'No password to set.')

  const applied = await runProcedure(config, env, deps)
  printRun('apply', applied, log)
  if (applied.exitCode !== 0) {
    log('The apply failed. Every new credential stays pending, unseen by any service; the current secrets are as they were.')
    return 1
  }

  const unpromoted: string[] = []
  for (const p of pending) {
    try {
      await promote(aws, p.arn, p.versionId)
    } catch (err) {
      unpromoted.push(
        `${p.key}: aws secretsmanager update-secret-version-stage --region ${config.region} --secret-id ${p.arn} --version-stage AWSCURRENT --move-to-version-id ${p.versionId} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  if (unpromoted.length) {
    log('The database holds the new passwords, but these secrets are still pending. Promote them before anything restarts:')
    for (const line of unpromoted) log(`  ${line}`)
    return 1
  }
  if (pending.length) log(`Promoted to current: ${pending.map((p) => p.key).join(', ')}`)
  if (rotating.length) log(`Rotated ${rotating.join(', ')}: restart the services that use it now; running tasks hold the old password.`)

  const after = await runProcedure(config, { BOOTSTRAP_MODE: 'check' }, deps)
  printRun('check', after, log)
  const problems = after.exitCode === 0 ? auditReport(parseReport(after.lines), roles) : ['the closing check failed']
  for (const problem of problems) log(`NOT DONE: ${problem}`)
  if (problems.length === 0) log('The region database is initialised: every step current, every credential recorded and kept.')
  return problems.length ? 1 : 0
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2))
    const config = loadConfig(fs.readFileSync(args.configPath, 'utf8'))
    const databases =
      args.databases === undefined ? undefined : args.databases === 'none' ? [] : readDatabaseList(fs.readFileSync(args.databases, 'utf8'))
    process.exitCode = await launch(
      args.mode,
      config,
      args.rotate,
      {
        aws: awsCli(config.region),
        log: (line) => console.log(line),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      databases === undefined ? {} : { databases },
    )
  } catch (err) {
    console.error(`${err instanceof Refusal ? 'refusing' : 'failed'}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = err instanceof Refusal ? 2 : 1
  }
}

if (require.main === module) main()
