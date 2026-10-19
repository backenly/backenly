/**
 * THE REGIONAL PROCEDURE'S LAUNCHER (tools/managed-db/regional/launch.ts)
 * ======================================================================
 * The launcher is the only place a regional database password exists, so these
 * tests pin what it does with one: generated here, written only into its secret
 * on standard input, handed to the procedure only as a verifier, and made
 * current only once the procedure has set it.
 *
 * AWS is the in-memory model below: ECS runs a scripted procedure that answers
 * as bootstrap.sh does (its refusals included) and keeps the verifiers it was
 * given, CloudWatch Logs pages its output, and Secrets Manager keeps versions
 * and staging labels with the rules the launcher depends on. The procedure
 * itself, against a real PostgreSQL, is tests/integration/regional-bootstrap.spec.ts.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ROLES,
  Refusal,
  auditReport,
  awsCli,
  connectionString,
  launch,
  loadConfig,
  parseArgs,
  parseReport,
  planCredentials,
  type Aws,
  type LaunchConfig,
  type ManagedRole,
} from '@/tools/managed-db/regional/launch'
import { generatePassword, scramSha256Verifier } from '@/tools/managed-db/regional/scram'

const REGION = 'us-east-1'
const secretArn = (name: string) => `arn:aws:secretsmanager:${REGION}:123456789012:secret:backenly-region/${name}-AbCdEf`

const CONFIG: LaunchConfig = {
  region: REGION,
  cluster: `arn:aws:ecs:${REGION}:123456789012:cluster/backenly-region`,
  taskDefinition: `arn:aws:ecs:${REGION}:123456789012:task-definition/backenly-region-db-procedure:3`,
  container: 'procedure',
  subnets: ['subnet-a', 'subnet-b'],
  securityGroup: 'sg-procedure',
  logGroup: '/ecs/backenly-region/db-procedure',
  logStreamPrefix: 'procedure',
  database: { host: 'backenly-region-pg.example.us-east-1.rds.amazonaws.com', port: 5432, name: 'backenly' },
  secrets: {
    app: secretArn('database-url'),
    direct: secretArn('direct-url'),
    backup: secretArn('backup-database-url'),
    authenticator: secretArn('pgrst-db-uri'),
    postgrestJwt: secretArn('postgrest-jwt'),
  },
}

const ALL_ROLES = Object.keys(ROLES) as ManagedRole[]
const STEPS = ['roles', 'postgrest', 'drift-events', 'direct-access', 'extensions']

// ── The model ────────────────────────────────────────────────────────────────

interface Database {
  /** role => the verifier it holds and whether this procedure recorded setting it. */
  roles: Partial<Record<ManagedRole, { verifier: string | null; recorded: boolean }>>
  applied: boolean
  failApply?: boolean
  /**
   * The direct-access step's files changed since it was applied, and the
   * database does not verify against them until an apply converges it.
   */
  changed?: boolean
}

type Call = { args: string[]; stdin?: string }

class FakeAws {
  calls: Call[] = []
  running: string[] = []
  private tasks = new Map<string, { env: Record<string, string>; exitCode: number; lines: string[]; polls: number }>()
  private secrets = new Map<string, Array<{ id: string; value: string; stages: string[] }>>()
  private n = 0

  constructor(readonly db: Database) {
    for (const arn of Object.values(CONFIG.secrets)) this.secrets.set(arn, [])
  }

  /** What a secret's current version holds, or undefined. */
  current(arn: string): string | undefined {
    return this.secrets.get(arn)!.find((v) => v.stages.includes('AWSCURRENT'))?.value
  }

  stagesOf(arn: string): string[][] {
    return this.secrets.get(arn)!.map((v) => v.stages)
  }

  seedCurrent(arn: string, value: string): void {
    this.secrets.get(arn)!.push({ id: `seed-${++this.n}`, value, stages: ['AWSCURRENT'] })
  }

  readonly aws: Aws = async (args, stdin) => {
    this.calls.push({ args, stdin })
    const flag = (name: string) => {
      const i = args.indexOf(name)
      return i < 0 ? undefined : args[i + 1]
    }
    const [service, command] = args
    if (service === 'ecs' && command === 'list-tasks') return JSON.stringify({ taskArns: this.running })
    if (service === 'ecs' && command === 'run-task') {
      // The identifiers as arguments and only the overrides on standard input:
      // the real CLI reads --cli-input-json twice, so from a pipe it is empty.
      expect(args).not.toContain('--cli-input-json')
      expect(flag('--cluster')).toBe(CONFIG.cluster)
      expect(flag('--task-definition')).toBe(CONFIG.taskDefinition)
      expect(flag('--overrides')).toBe('file:///dev/stdin')
      expect(JSON.parse(flag('--network-configuration')!).awsvpcConfiguration).toEqual({
        subnets: CONFIG.subnets, securityGroups: [CONFIG.securityGroup], assignPublicIp: 'DISABLED',
      })
      const overrides = JSON.parse(stdin!)
      const env: Record<string, string> = { BOOTSTRAP_MODE: 'check' }
      for (const e of overrides.containerOverrides[0].environment) env[e.name] = e.value
      const taskArn = `arn:aws:ecs:${REGION}:123456789012:task/backenly-region/task${++this.n}`
      this.tasks.set(taskArn, { env, polls: 0, ...this.procedure(env) })
      return JSON.stringify({ tasks: [{ taskArn }], failures: [] })
    }
    if (service === 'ecs' && command === 'describe-tasks') {
      const task = this.tasks.get(flag('--tasks')!)!
      // RUNNING on the first poll, so the launcher has to wait for it.
      const stopped = ++task.polls > 1
      return JSON.stringify({
        tasks: [{ lastStatus: stopped ? 'STOPPED' : 'RUNNING', containers: [{ name: 'procedure', exitCode: stopped ? task.exitCode : undefined }] }],
      })
    }
    if (service === 'logs' && command === 'get-log-events') {
      const id = flag('--log-stream-name')!.split('/').pop()!
      const task = [...this.tasks.entries()].find(([arn]) => arn.endsWith(`/${id}`))![1]
      // Two pages, then CloudWatch's end marker: the token handed back unchanged.
      const token = flag('--next-token')
      if (!token) return JSON.stringify({ events: task.lines.slice(0, 3).map((message) => ({ message })), nextForwardToken: 'f/1' })
      if (token === 'f/1') return JSON.stringify({ events: task.lines.slice(3).map((message) => ({ message })), nextForwardToken: 'f/2' })
      return JSON.stringify({ events: [], nextForwardToken: token })
    }
    if (service === 'secretsmanager' && command === 'describe-secret') {
      const versions = this.secrets.get(flag('--secret-id')!)!
      return JSON.stringify({ VersionIdsToStages: Object.fromEntries(versions.filter((v) => v.stages.length).map((v) => [v.id, v.stages])) })
    }
    if (service === 'secretsmanager' && command === 'put-secret-value') {
      expect(flag('--secret-string')).toBe('file:///dev/stdin')
      const versions = this.secrets.get(flag('--secret-id')!)!
      const stages = flag('--version-stages') ? [flag('--version-stages')!] : ['AWSCURRENT']
      // A label lives on one version: putting it on the new one moves it.
      for (const v of versions) v.stages = v.stages.filter((s) => !stages.includes(s))
      const id = `v${++this.n}`
      versions.push({ id, value: stdin!, stages })
      return JSON.stringify({ VersionId: id })
    }
    if (service === 'secretsmanager' && command === 'update-secret-version-stage') {
      const versions = this.secrets.get(flag('--secret-id')!)!
      const stage = flag('--version-stage')!
      const to = flag('--move-to-version-id')
      const from = flag('--remove-from-version-id')
      const holder = versions.find((v) => v.stages.includes(stage))
      // As Secrets Manager: moving a label off a version must name that version.
      if (to && holder && holder.id !== to && holder.id !== from) throw new Error(`${stage} is on ${holder.id}; name it in --remove-from-version-id`)
      if (from) {
        const v = versions.find((x) => x.id === from)!
        if (!v.stages.includes(stage)) throw new Error(`${from} does not have ${stage}`)
        v.stages = v.stages.filter((s) => s !== stage)
      }
      if (to) versions.find((x) => x.id === to)!.stages.push(stage)
      return '{}'
    }
    throw new Error(`the model has no ${service} ${command}`)
  }

  /** bootstrap.sh, as the launcher sees it: its report lines, its refusals, its exit code. */
  private procedure(env: Record<string, string>): { exitCode: number; lines: string[] } {
    const apply = env.BOOTSTRAP_MODE === 'apply'
    const preApply = env.BOOTSTRAP_PRE_APPLY === 'true'
    const lines = ['', `Regional database initialisation (${apply ? 'apply' : 'check'})`]
    const rotate = (env.BOOTSTRAP_ROTATE ?? '').split(',').filter(Boolean)
    if (apply && preApply) {
      return { exitCode: 2, lines: [...lines, 'refusing: BOOTSTRAP_PRE_APPLY marks the check a launcher runs before its own apply, never the apply'] }
    }
    if (apply) {
      if (this.db.failApply) return { exitCode: 3, lines: [...lines, 'ERROR:  could not connect'] }
      for (const role of ALL_ROLES) {
        const verifier = env[ROLES[role].verifier]
        const have = this.db.roles[role]
        if (!have && !verifier) return { exitCode: 3, lines: [...lines, `ERROR:  refusing: ${role} does not exist, and no verifier was supplied`] }
        if (have && verifier && !rotate.includes(role)) {
          return { exitCode: 3, lines: [...lines, `ERROR:  refusing: ${role} already has the password this procedure set`] }
        }
      }
      for (const role of ALL_ROLES) {
        const verifier = env[ROLES[role].verifier]
        if (verifier) this.db.roles[role] = { verifier, recorded: true }
      }
      this.db.applied = true
      this.db.changed = false
      for (const id of STEPS) lines.push(`  step ${id}: applied`)
    } else {
      for (const id of STEPS) {
        const state = !this.db.applied
          ? 'pending (not applied)'
          : this.db.changed && id === 'direct-access'
            ? 'changed (applied, but its files have changed since)'
            : 'current (applied, files unchanged)'
        lines.push(`  step ${id}: ${state}`)
      }
    }
    for (const role of ALL_ROLES) {
      const have = this.db.roles[role]
      lines.push(
        `  credential ${role}: ${
          !have ? `missing (the first apply must supply ${ROLES[role].verifier})` : have.recorded ? 'recorded 2026-10-16T12:00:00Z' : 'unrecorded (exists, but this procedure never set its password)'
        }`,
      )
    }
    if (!apply && this.db.applied && this.db.changed) {
      // As bootstrap.sh: only the check a launcher runs before its own apply passes.
      lines.push('ERROR:  regional database verification failed: backenly_backup cannot use workspace schema workspace_0, so its snapshots fail')
      if (!preApply) {
        lines.push('Check only: nothing was written. 1 step(s) changed since applied, and the database does not verify.')
        return { exitCode: 3, lines }
      }
      lines.push('Check only: nothing was written. 1 step(s) changed since applied: the apply that follows converges what does not verify.')
      return { exitCode: 0, lines }
    }
    lines.push(apply ? 'Regional database initialised and verified.' : 'Check only: nothing was written.')
    return { exitCode: 0, lines }
  }
}

const deps = (fake: FakeAws, log: string[] = []) => ({
  aws: fake.aws,
  log: (line: string) => log.push(line),
  sleep: async () => {},
  pollMs: 1,
  timeoutMs: 50,
})

/** The password inside a stored connection string, and whether the database's verifier is its verifier. */
function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password)
}
function verifies(password: string, verifier: string): boolean {
  const salt = Buffer.from(verifier.split('$')[1].split(':')[1], 'base64')
  return scramSha256Verifier(password, { salt }) === verifier
}

const runTasks = (fake: FakeAws) => fake.calls.filter((c) => c.args[0] === 'ecs' && c.args[1] === 'run-task')
const envOf = (call: Call): Record<string, string> =>
  Object.fromEntries(JSON.parse(call.stdin!).containerOverrides[0].environment.map((e: { name: string; value: string }) => [e.name, e.value]))

// ── The runs ─────────────────────────────────────────────────────────────────

describe('a first apply', () => {
  it('sets every password, keeps each only in its secret, and makes it current only after the procedure set it', async () => {
    const fake = new FakeAws({ roles: {}, applied: false })
    expect(await launch('apply', CONFIG, [], deps(fake))).toBe(0)

    const secretFor = { backenly_app: CONFIG.secrets.app, backenly_backup: CONFIG.secrets.backup, backenly_authenticator: CONFIG.secrets.authenticator }
    const passwords: string[] = []
    for (const role of ALL_ROLES) {
      const url = fake.current(secretFor[role])!
      expect(url).toMatch(new RegExp(`^postgresql://${role}:[0-9a-f]{64}@${CONFIG.database.host}:5432/backenly\\?sslmode=require$`))
      expect(verifies(passwordOf(url), fake.db.roles[role]!.verifier!)).toBe(true)
      passwords.push(passwordOf(url))
    }
    expect(fake.current(CONFIG.secrets.direct)).toBe(fake.current(CONFIG.secrets.app))
    expect(fake.current(CONFIG.secrets.postgrestJwt)).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(passwords).size).toBe(3)

    // Nothing is left pending.
    for (const arn of Object.values(CONFIG.secrets)) expect(fake.stagesOf(arn).flat()).not.toContain('AWSPENDING')

    // A password is only ever on the standard input of a put that stores it:
    // never an argument, never in the task's overrides.
    for (const password of passwords) {
      expect(fake.calls.filter((c) => c.args.join(' ').includes(password))).toEqual([])
      expect(fake.calls.filter((c) => c.args[1] !== 'put-secret-value' && (c.stdin ?? '').includes(password))).toEqual([])
    }

    // Stored pending before the procedure ran; made current only after it.
    const order = fake.calls.map((c) => `${c.args[1]}${c.args.includes('AWSPENDING') ? ':pending' : ''}${c.args[1] === 'run-task' ? `:${envOf(c).BOOTSTRAP_MODE}` : ''}`)
    const applyAt = order.indexOf('run-task:apply')
    const firstPromotion = order.findIndex((o) => o === 'update-secret-version-stage')
    expect(order.slice(0, applyAt).filter((o) => o === 'put-secret-value:pending')).toHaveLength(4)
    expect(firstPromotion).toBeGreaterThan(applyAt)
    expect(order.filter((o) => o.startsWith('run-task'))).toEqual(['run-task:check', 'run-task:apply', 'run-task:check'])

    // The procedure got verifiers, and nothing to rotate.
    const applyEnv = envOf(runTasks(fake)[1])
    for (const role of ALL_ROLES) expect(applyEnv[ROLES[role].verifier]).toMatch(/^SCRAM-SHA-256\$4096:/)
    expect(applyEnv.BOOTSTRAP_ROTATE).toBeUndefined()
    // ...on standard input only: no verifier is ever an argument (the process list).
    for (const call of fake.calls) expect(call.args.join(' ')).not.toContain('SCRAM-SHA-256')
  })

  it('leaves no current credential when the procedure fails', async () => {
    const fake = new FakeAws({ roles: {}, applied: false, failApply: true })
    const log: string[] = []
    expect(await launch('apply', CONFIG, [], deps(fake, log))).toBe(1)
    for (const key of ['app', 'direct', 'backup', 'authenticator'] as const) {
      expect(fake.current(CONFIG.secrets[key])).toBeUndefined()
      expect(fake.stagesOf(CONFIG.secrets[key])).toEqual([['AWSPENDING']])
    }
    expect(fake.calls.some((c) => c.args[1] === 'update-secret-version-stage')).toBe(false)
    expect(log.join('\n')).toContain('Every new credential stays pending')
  })
})

/** A database the procedure finished, with every credential in its secret. */
function finished(db: Partial<Database> = {}): { fake: FakeAws; passwords: Record<ManagedRole, string> } {
  const passwords = { backenly_app: generatePassword(), backenly_backup: generatePassword(), backenly_authenticator: generatePassword() }
  const fake = new FakeAws({
    roles: Object.fromEntries(ALL_ROLES.map((role) => [role, { verifier: scramSha256Verifier(passwords[role]), recorded: true }])),
    applied: true,
    ...db,
  })
  fake.seedCurrent(CONFIG.secrets.app, connectionString('backenly_app', passwords.backenly_app, CONFIG.database))
  fake.seedCurrent(CONFIG.secrets.direct, connectionString('backenly_app', passwords.backenly_app, CONFIG.database))
  fake.seedCurrent(CONFIG.secrets.backup, connectionString('backenly_backup', passwords.backenly_backup, CONFIG.database))
  fake.seedCurrent(CONFIG.secrets.authenticator, connectionString('backenly_authenticator', passwords.backenly_authenticator, CONFIG.database))
  fake.seedCurrent(CONFIG.secrets.postgrestJwt, 'kept-jwt-secret-of-at-least-thirty-two-characters')
  return { fake, passwords }
}

describe('an apply on a finished database', () => {
  it('sets no password and keeps every secret', async () => {
    const { fake } = finished()
    const before = Object.values(CONFIG.secrets).map((arn) => fake.current(arn))
    expect(await launch('apply', CONFIG, [], deps(fake))).toBe(0)
    expect(Object.values(CONFIG.secrets).map((arn) => fake.current(arn))).toEqual(before)
    expect(fake.calls.filter((c) => c.args[1] === 'put-secret-value')).toHaveLength(0)
    const applyEnv = envOf(runTasks(fake)[1])
    expect(Object.keys(applyEnv)).toEqual(['BOOTSTRAP_MODE'])
  })

  it('rotates exactly the role named, and the database and its secrets agree afterwards', async () => {
    const { fake, passwords } = finished()
    const log: string[] = []
    expect(await launch('apply', CONFIG, ['backenly_app'], deps(fake, log))).toBe(0)

    const url = fake.current(CONFIG.secrets.app)!
    expect(passwordOf(url)).not.toBe(passwords.backenly_app)
    expect(verifies(passwordOf(url), fake.db.roles.backenly_app!.verifier!)).toBe(true)
    expect(fake.current(CONFIG.secrets.direct)).toBe(url)
    // The old version lost AWSCURRENT; exactly one version holds it.
    expect(fake.stagesOf(CONFIG.secrets.app).filter((s) => s.includes('AWSCURRENT'))).toHaveLength(1)
    // The others are untouched.
    expect(passwordOf(fake.current(CONFIG.secrets.backup)!)).toBe(passwords.backenly_backup)
    expect(passwordOf(fake.current(CONFIG.secrets.authenticator)!)).toBe(passwords.backenly_authenticator)

    const applyEnv = envOf(runTasks(fake)[1])
    expect(applyEnv.BOOTSTRAP_ROTATE).toBe('backenly_app')
    expect(Object.keys(applyEnv).sort()).toEqual(['BACKENLY_APP_VERIFIER', 'BOOTSTRAP_MODE', 'BOOTSTRAP_ROTATE'])
    expect(log.join('\n')).toContain('restart the services that use it now')
  })

  it('keeps the old current version when a rotation fails', async () => {
    const { fake, passwords } = finished()
    fake.db.failApply = true
    expect(await launch('apply', CONFIG, ['backenly_app'], deps(fake))).toBe(1)
    expect(passwordOf(fake.current(CONFIG.secrets.app)!)).toBe(passwords.backenly_app)
    expect(passwordOf(fake.current(CONFIG.secrets.direct)!)).toBe(passwords.backenly_app)
  })
})

describe('a region whose step files changed and do not verify yet', () => {
  it('fails a check on its own, and writes nothing', async () => {
    const { fake } = finished({ changed: true })
    const log: string[] = []
    expect(await launch('check', CONFIG, [], deps(fake, log))).toBe(1)
    // A standalone check carries no pre-apply signal: a gate reading its exit code
    // never passes a region that does not verify.
    expect(runTasks(fake).map(envOf)).toEqual([{ BOOTSTRAP_MODE: 'check' }])
    expect(fake.calls.filter((c) => c.args[0] === 'secretsmanager')).toHaveLength(0)
    expect(log.join('\n')).toContain('The check failed. Nothing was written.')
  })

  it('is converged by an apply, whose first check alone is a pre-apply check', async () => {
    const { fake } = finished({ changed: true })
    const before = Object.values(CONFIG.secrets).map((arn) => fake.current(arn))
    const log: string[] = []
    expect(await launch('apply', CONFIG, [], deps(fake, log))).toBe(0)
    expect(runTasks(fake).map(envOf)).toEqual([
      { BOOTSTRAP_MODE: 'check', BOOTSTRAP_PRE_APPLY: 'true' },
      { BOOTSTRAP_MODE: 'apply' },
      // The closing check is strict again: it passes only because the apply converged.
      { BOOTSTRAP_MODE: 'check' },
    ])
    expect(fake.db.changed).toBe(false)
    expect(Object.values(CONFIG.secrets).map((arn) => fake.current(arn))).toEqual(before)
    expect(log.join('\n')).toContain('The region database is initialised: every step current, every credential recorded and kept.')
  })
})

describe('refusals, before anything is written', () => {
  it('refuses a role that exists but that the procedure never set', async () => {
    const fake = new FakeAws({ roles: { backenly_backup: { verifier: null, recorded: false } }, applied: false })
    await expect(launch('apply', CONFIG, [], deps(fake))).rejects.toThrow(/backenly_backup exists, but this procedure never set its password/)
    expect(fake.calls.filter((c) => c.args[0] === 'secretsmanager')).toHaveLength(0)
    expect(runTasks(fake)).toHaveLength(1)
  })

  it('refuses while another run of the procedure is going', async () => {
    const fake = new FakeAws({ roles: {}, applied: false })
    fake.running = ['arn:aws:ecs:us-east-1:123456789012:task/backenly-region/other']
    await expect(launch('apply', CONFIG, [], deps(fake))).rejects.toThrow(Refusal)
    expect(runTasks(fake)).toHaveLength(0)
  })

  it('check runs the procedure once and touches no secret', async () => {
    const fake = new FakeAws({ roles: {}, applied: false })
    const log: string[] = []
    expect(await launch('check', CONFIG, [], deps(fake, log))).toBe(0)
    expect(runTasks(fake)).toHaveLength(1)
    expect(envOf(runTasks(fake)[0])).toEqual({ BOOTSTRAP_MODE: 'check' })
    expect(fake.calls.filter((c) => c.args[0] === 'secretsmanager')).toHaveLength(0)
    // Its whole log, both pages, is shown.
    expect(log.filter((l) => l.startsWith('   | ')).length).toBeGreaterThan(8)
  })

  it('gives up on a task that never stops, and says it is still running', async () => {
    const fake = new FakeAws({ roles: {}, applied: false })
    const neverStops: Aws = async (args, stdin) =>
      args[1] === 'describe-tasks' ? JSON.stringify({ tasks: [{ lastStatus: 'RUNNING', containers: [] }] }) : fake.aws(args, stdin)
    await expect(launch('check', CONFIG, [], { ...deps(fake), aws: neverStops })).rejects.toThrow(/has not stopped .* still running/)
  })
})

describe('reading the procedure', () => {
  const sample = [
    '',
    'Regional database initialisation (check)',
    '  step roles: current (applied, files unchanged)',
    '  step postgrest: changed (applied, but its files have changed since)',
    '  step drift-events: pending (not applied)',
    '  credential backenly_app: recorded 2026-10-16T09:30:00Z',
    '  credential backenly_authenticator: missing (the first apply must supply BACKENLY_AUTHENTICATOR_VERIFIER)',
    '  credential backenly_backup: unrecorded (exists, but this procedure never set its password)',
    'Check only: nothing was written. 1 step(s) not applied yet.',
  ]

  it('parses steps, credentials and the summary bootstrap.sh prints', () => {
    const report = parseReport(sample)
    expect(report.steps).toEqual({ roles: 'current', postgrest: 'changed', 'drift-events': 'pending' })
    expect(report.credentials).toEqual({
      backenly_app: { state: 'recorded', at: '2026-10-16T09:30:00Z' },
      backenly_authenticator: { state: 'missing' },
      backenly_backup: { state: 'unrecorded' },
    })
    expect(report.summary).toBe('Check only: nothing was written. 1 step(s) not applied yet.')
  })

  it('plans the missing roles and the rotated ones, and audits what is not done', () => {
    const report = parseReport(sample.filter((l) => !l.includes('backenly_backup')).concat('  credential backenly_backup: recorded 2026-10-16T09:30:00Z'))
    expect(planCredentials(report, [])).toEqual(['backenly_authenticator'])
    expect(planCredentials(report, ['backenly_app'])).toEqual(['backenly_app', 'backenly_authenticator'])
    expect(auditReport(report)).toEqual([
      'step postgrest is changed, not current',
      'step drift-events is pending, not current',
      'credential backenly_authenticator is missing, not recorded',
    ])
    expect(() => planCredentials(parseReport(sample.slice(0, 5)), [])).toThrow(/did not report/)
  })

  it('percent-encodes the password and asks for TLS', () => {
    expect(connectionString('backenly_app', 'a@b:c/d', CONFIG.database)).toBe(
      `postgresql://backenly_app:a%40b%3Ac%2Fd@${CONFIG.database.host}:5432/backenly?sslmode=require`,
    )
  })
})

describe('arguments and configuration', () => {
  it('reads check and apply, and refuses what it does not understand', () => {
    expect(parseArgs(['check', '--config', 'l.json'])).toEqual({ mode: 'check', configPath: 'l.json', rotate: [] })
    expect(parseArgs(['apply', '--config', 'l.json', '--rotate', 'backenly_app,backenly_app'])).toEqual({ mode: 'apply', configPath: 'l.json', rotate: ['backenly_app'] })
    expect(() => parseArgs(['apply'])).toThrow(/--config/)
    expect(() => parseArgs(['drop', '--config', 'l.json'])).toThrow(/usage/)
    expect(() => parseArgs(['check', '--config', 'l.json', '--rotate', 'backenly_app'])).toThrow(/check writes nothing/)
    expect(() => parseArgs(['apply', '--config', 'l.json', '--rotate', 'postgres'])).toThrow(/does not manage: postgres/)
  })

  it('takes the stack output as it is, and refuses one that cannot run', () => {
    expect(loadConfig(JSON.stringify(CONFIG))).toEqual(CONFIG)
    expect(() => loadConfig(JSON.stringify({ ...CONFIG, taskDefinition: null }))).toThrow(/pin db_procedure_image_digest/)
    expect(() => loadConfig(JSON.stringify({ ...CONFIG, secrets: { ...CONFIG.secrets, backup: CONFIG.secrets.backup.replace(REGION, 'ap-south-1') } }))).toThrow(
      /backup secret is not in us-east-1/,
    )
    expect(() => loadConfig(JSON.stringify({ ...CONFIG, subnets: [] }))).toThrow(/subnets/)
    expect(() => loadConfig('not json')).toThrow(/terraform output -json/)
  })
})

describe('the AWS CLI it calls', () => {
  // The CLI reads file:///dev/stdin by opening that path. On Linux the standard
  // input Node gives a child is a socket, which /dev/stdin cannot open (ENXIO):
  // the first run against a real region failed that way before starting
  // anything. A stand-in `aws` on PATH that reads /dev/stdin as the CLI does.
  const unix = process.platform === 'win32' ? it.skip : it

  unix('hands the CLI a standard input it can open as /dev/stdin, without an argument or a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-aws-'))
    fs.writeFileSync(path.join(dir, 'aws'), '#!/bin/sh\ncat /dev/stdin\nprintf " args:%s" "$*"\n', { mode: 0o755 })
    // Passed as the CLI's environment: jest's sandboxed process.env does not
    // reach a child, which would then find a real `aws` on the runner instead.
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    try {
      const out = await awsCli(REGION, env)(['secretsmanager', 'put-secret-value', '--secret-string', 'file:///dev/stdin'], 'kept-off-the-process-list')
      expect(out).toBe(`kept-off-the-process-list args:secretsmanager put-secret-value --secret-string file:///dev/stdin --region ${REGION} --output json`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
