/**
 * RUN THE REGIONAL DATABASE PROCEDURE ON BACKENLY CLOUD
 * =====================================================
 * The operator's half of bootstrap.sh on AWS. It starts the procedure as the
 * region's one-off ECS task, reads the task's log back, and keeps the
 * credentials the procedure sets in the region's Secrets Manager secrets:
 *
 *   npx tsx tools/managed-db/regional/launch.ts check --config launch.json
 *   npx tsx tools/managed-db/regional/launch.ts apply --config launch.json [--rotate backenly_app,...]
 *
 * launch.json is the region stack's db_procedure_launch_config output
 * (backenly-infra, aws/REGIONS_RUNBOOK.md): identifiers, never a secret value.
 * AWS calls go through the AWS CLI on PATH with the credentials in the
 * environment (AWS_PROFILE), so this adds no dependency. Linux or macOS: secret
 * values reach the CLI on /dev/stdin.
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
 */

import { spawn } from 'node:child_process'
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
  secrets: { app: string; direct: string; backup: string; authenticator: string; postgrestJwt: string }
}

export type Mode = 'check' | 'apply'

/** The login roles the procedure sets passwords for, and where each password is kept. */
export const ROLES = {
  backenly_app: { verifier: 'BACKENLY_APP_VERIFIER', secrets: ['app', 'direct'] },
  backenly_backup: { verifier: 'BACKENLY_BACKUP_VERIFIER', secrets: ['backup'] },
  backenly_authenticator: { verifier: 'BACKENLY_AUTHENTICATOR_VERIFIER', secrets: ['authenticator'] },
} as const satisfies Record<string, { verifier: string; secrets: ReadonlyArray<keyof LaunchConfig['secrets']> }>

export type ManagedRole = keyof typeof ROLES
const MANAGED_ROLES = Object.keys(ROLES) as ManagedRole[]

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
}

export function parseArgs(argv: string[]): Args {
  const [mode, ...rest] = argv
  if (mode !== 'check' && mode !== 'apply') {
    throw new Refusal('usage: launch.ts check|apply --config <launch.json> [--rotate role,...]')
  }
  let configPath: string | undefined
  let rotate: ManagedRole[] = []
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
    } else {
      throw new Refusal(`unexpected argument: ${flag}`)
    }
  }
  if (!configPath) throw new Refusal('--config <launch.json> is required')
  if (mode === 'check' && rotate.length) throw new Refusal('--rotate is for apply; check writes nothing')
  return { mode, configPath, rotate }
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
  for (const key of ['app', 'direct', 'backup', 'authenticator', 'postgrestJwt'] as const) {
    const arn = secrets?.[key]
    if (!present(arn)) throw new Refusal(`the config has no ${key} secret`)
    // A credential for this region's database is kept in this region, never elsewhere.
    if (!arn!.startsWith(`arn:aws:secretsmanager:${c.region}:`)) throw new Refusal(`the ${key} secret is not in ${c.region}: ${arn}`)
  }
  return c as LaunchConfig
}

// ── What the procedure reports ───────────────────────────────────────────────

export type CredentialState = 'missing' | 'unrecorded' | 'recorded'

export interface Report {
  steps: Record<string, string>
  credentials: Partial<Record<ManagedRole, { state: CredentialState; at?: string }>>
  summary: string | null
}

/** The lines bootstrap.sh prints for a launcher (its "Output a launcher may read"). */
export function parseReport(lines: string[]): Report {
  const report: Report = { steps: {}, credentials: {}, summary: null }
  for (const line of lines) {
    const step = /^\s*step ([a-z][a-z-]*): (current|changed|pending|applied|re-applied)\b/.exec(line)
    if (step) report.steps[step[1]] = step[2]
    const credential = /^\s*credential (backenly_[a-z_]+): (missing|unrecorded|recorded)\b(?: (\d{4}-\d{2}-\d{2}T\S+))?/.exec(line)
    if (credential && MANAGED_ROLES.includes(credential[1] as ManagedRole)) {
      report.credentials[credential[1] as ManagedRole] = { state: credential[2] as CredentialState, at: credential[3] }
    }
    if (/^(Regional database initialised|Check only:)/.test(line.trim())) report.summary = line.trim()
  }
  return report
}

/**
 * The roles this apply sets a password for: every role the database does not
 * have yet, and every recorded one named in --rotate. A role that exists but
 * that this procedure never set is refused, as roles.sql refuses it: something
 * else made it, and that has to be understood before anything replaces its
 * password.
 */
export function planCredentials(report: Report, rotate: ManagedRole[]): ManagedRole[] {
  const plan: ManagedRole[] = []
  for (const role of MANAGED_ROLES) {
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
export function auditReport(report: Report): string[] {
  const problems: string[] = []
  const steps = Object.entries(report.steps)
  if (steps.length === 0) problems.push('the check reported no steps')
  for (const [id, state] of steps) if (state !== 'current') problems.push(`step ${id} is ${state}, not current`)
  for (const role of MANAGED_ROLES) {
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

/** The real AWS CLI, in one region, answering JSON. */
export function awsCli(region: string): Aws {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn('aws', [...args, '--region', region, '--output', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] })
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

  // On standard input, so the verifiers are not in this machine's process list.
  const request = {
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: 'FARGATE',
    count: 1,
    startedBy: 'backenly-db-procedure',
    networkConfiguration: {
      awsvpcConfiguration: { subnets: config.subnets, securityGroups: [config.securityGroup], assignPublicIp: 'DISABLED' },
    },
    overrides: {
      containerOverrides: [{ name: config.container, environment: Object.entries(env).map(([name, value]) => ({ name, value })) }],
    },
  }
  const started = JSON.parse(await aws(['ecs', 'run-task', '--cli-input-json', 'file:///dev/stdin'], JSON.stringify(request)))
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

/** check: report only. apply: converge, keep the credentials, check again. Resolves to the exit code. */
export async function launch(mode: Mode, config: LaunchConfig, rotate: ManagedRole[], deps: Deps): Promise<number> {
  const { aws, log } = deps
  log(`Regional database procedure, ${mode}: ${config.database.host}/${config.database.name} in ${config.region}`)

  const before = await runProcedure(config, { BOOTSTRAP_MODE: 'check' }, deps)
  printRun('check', before, log)
  if (before.exitCode !== 0) {
    log('The check failed. Nothing was written.')
    return 1
  }
  if (mode === 'check') return 0

  const found = parseReport(before.lines)
  const roles = planCredentials(found, rotate)

  const jwt = await ensureJwtSecret(aws, config.secrets.postgrestJwt)
  log(`PostgREST JWT secret: ${jwt === 'created' ? 'created' : 'kept (it already had a value)'}`)

  const env: Record<string, string> = { BOOTSTRAP_MODE: 'apply' }
  const pending: Array<{ key: string; arn: string; versionId: string }> = []
  for (const role of roles) {
    const password = generatePassword()
    env[ROLES[role].verifier] = scramSha256Verifier(password)
    const url = connectionString(role, password, config.database)
    for (const key of ROLES[role].secrets) {
      pending.push({ key, arn: config.secrets[key], versionId: await putPending(aws, config.secrets[key], url) })
    }
  }
  // The roles whose existing password is replaced; a missing one is simply set.
  const rotating = rotate.filter((role) => found.credentials[role]?.state === 'recorded')
  if (rotating.length) env.BOOTSTRAP_ROTATE = rotating.join(',')
  log(roles.length ? `Setting passwords for: ${roles.join(', ')} (stored as pending until the procedure has set them)` : 'No password to set.')

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
  const problems = after.exitCode === 0 ? auditReport(parseReport(after.lines)) : ['the closing check failed']
  for (const problem of problems) log(`NOT DONE: ${problem}`)
  if (problems.length === 0) log('The region database is initialised: every step current, every credential recorded and kept.')
  return problems.length ? 1 : 0
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2))
    const config = loadConfig(fs.readFileSync(args.configPath, 'utf8'))
    process.exitCode = await launch(args.mode, config, args.rotate, {
      aws: awsCli(config.region),
      log: (line) => console.log(line),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
  } catch (err) {
    console.error(`${err instanceof Refusal ? 'refusing' : 'failed'}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = err instanceof Refusal ? 2 : 1
  }
}

if (require.main === module) main()
