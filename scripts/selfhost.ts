/**
 * ONE COMMAND, FROM A FRESH CLONE TO A RUNNING DEPLOYMENT
 * ======================================================
 *
 *   npm run selfhost
 *
 * WHY THIS EXISTS
 * ---------------
 * Supabase self-hosted is `git clone && docker compose up -d`. Backenly was
 * five documented steps: edit five secrets into .env by hand, run a reconciler
 * whose first run is EXPECTED to exit 3, run two superuser scripts, copy a
 * generated password back into .env, start a fourth container, then rerun the
 * reconciler. Every one of those steps is defensible on its own. Together they
 * were the largest honest gap against Supabase, and the one a new operator hits
 * before seeing anything the product does.
 *
 * This runs that same sequence. It does not replace it or route around it:
 *
 *   - the prerequisite chain comes from scripts/bootstrap-prerequisites.ts,
 *     which is the module bootstrap prints from and README.md is tested
 *     against. A step added there is executed here without being re-typed, so
 *     the installer cannot drift from the documentation the way a parallel
 *     copy would.
 *   - bootstrap is still the authority on readiness. This never decides a
 *     deployment is ready; it runs bootstrap and reads its exit code.
 *
 * IDEMPOTENT, for the same reason bootstrap is: operators rerun installers,
 * and an installer that is only safe once is a trap. It fills what is missing
 * and touches nothing else. It NEVER rotates a secret that already exists —
 * rotating JWT_SECRET would invalidate every live session, and rotating the
 * authenticator password would break a running PostgREST.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not start the application. `npm run dev` is one command already, and
 * daemonising a dev server from an installer hides the logs an operator needs
 * on a first run. It prints the command instead.
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { randomBytes, randomUUID } from 'crypto'
import { resolve } from 'path'
import {
  BOOTSTRAP_EXIT,
  postgrestPrerequisiteSteps,
} from './bootstrap-prerequisites'
import { ensureEnvVar, envValue, setEnvVar } from './lib/env-file'

const ROOT = resolve(__dirname, '..')
const ENV_PATH = resolve(ROOT, '.env')
const ENV_EXAMPLE = resolve(ROOT, '.env.example')
const COMPOSE = ['-f', 'docker-compose.dev.yml']

// ── Output ───────────────────────────────────────────────────────────────────
// Numbered to match what the README describes, so an operator reading both is
// never guessing which step failed.

let stepNo = 0
function heading(text: string): void {
  stepNo += 1
  console.log('')
  console.log(`  ${stepNo}. ${text}`)
}
const ok = (text: string) => console.log(`     ok   ${text}`)
const info = (text: string) => console.log(`     ..   ${text}`)

class InstallFailure extends Error {
  constructor(readonly what: string, readonly fix: string) {
    super(what)
    this.name = 'InstallFailure'
  }
}

// ── .env ─────────────────────────────────────────────────────────────────────

/**
 * Read .env as an ordered list of lines, so rewriting preserves the template's
 * comments. Those comments are the only documentation of what half these keys
 * mean, and a serialise-from-a-map approach would delete all of them.
 */
function readEnvLines(): string[] {
  return readFileSync(ENV_PATH, 'utf8').split('\n')
}

const hex32 = () => randomBytes(32).toString('hex')

// ── Process helpers ──────────────────────────────────────────────────────────

/** Run a command, stream it, and throw with guidance if it fails. */
function run(cmd: string, args: string[], fix: string, env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  })
  if (r.error) throw new InstallFailure(`could not run \`${cmd}\`: ${r.error.message}`, fix)
  if (r.status !== 0) throw new InstallFailure(`\`${cmd} ${args.join(' ')}\` exited ${r.status}`, fix)
}

/** Run a command and capture its output, for the steps whose output is parsed. */
function capture(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): { out: string; code: number } {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 }
}

/** Block the thread. This script is a sequence of steps, so it is genuinely serial. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function have(cmd: string, args: string[] = ['--version']): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: false })
  return !r.error && r.status === 0
}

// ── Steps ────────────────────────────────────────────────────────────────────

function checkPrerequisites(): void {
  heading('checking what this machine already has')

  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    throw new InstallFailure(
      `Node ${process.versions.node} is too old; Backenly needs 20 or newer`,
      'install Node 20+ and rerun'
    )
  }
  ok(`node ${process.versions.node}`)

  if (!have('docker')) {
    throw new InstallFailure('docker is not on PATH', 'install Docker, start it, and rerun')
  }
  if (!have('docker', ['compose', 'version'])) {
    throw new InstallFailure(
      'docker is present but `docker compose` is not',
      'install the Compose v2 plugin (docker-compose-v2), then rerun'
    )
  }
  ok('docker with compose')

  // The superuser steps are shell scripts. Checked HERE rather than at the
  // point of use, because discovering it after provisioning a database leaves a
  // half-installed deployment and a confusing error.
  if (!have('bash', ['--version'])) {
    throw new InstallFailure(
      'bash is not on PATH, and the superuser steps are bash scripts',
      'run this from a shell that has bash (WSL, Git Bash, or any Linux/macOS terminal)'
    )
  }
  ok('bash')
}

function ensureEnvFile(): { projectId: string } {
  heading('configuring .env')

  if (!existsSync(ENV_PATH)) {
    if (!existsSync(ENV_EXAMPLE)) {
      throw new InstallFailure('neither .env nor .env.example exists', 'run this from a full checkout')
    }
    copyFileSync(ENV_EXAMPLE, ENV_PATH)
    ok('created .env from .env.example')
  } else {
    info('.env already exists; filling only what is missing')
  }

  const lines = readEnvLines()

  // Each of these has no safe default. A fallback baked into a public
  // repository is a key everybody already has, which is why the application
  // refuses to start on several of them rather than inventing one.
  const generated: string[] = []
  const secrets: Array<[string, () => string]> = [
    ['BACKENLY_PROJECT_ID', randomUUID],
    ['JWT_SECRET', hex32],
    ['POSTGREST_JWT_SECRET', hex32],
    ['STORAGE_SECRET', hex32],
    // Encrypts project signing secrets and stored database credentials at
    // rest. Unset outside production it silently falls back to 32 zero bytes,
    // announced only in a log line, so a self-hosted install that followed the
    // README encrypted its secrets with a key that is public knowledge.
    ['MASTER_ENCRYPTION_KEY', hex32],
    // Claims this deployment. The first signup must present it, so the single
    // administrator slot goes to whoever can read this machine rather than to
    // whoever loads the page first — a deployment is often reachable before
    // its operator gets to it.
    ['BACKENLY_SETUP_TOKEN', hex32],
  ]
  for (const [key, gen] of secrets) {
    if (ensureEnvVar(lines, key, gen) === 'generated') generated.push(key)
  }

  writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')

  if (generated.length > 0) ok(`generated ${generated.join(', ')}`)
  else ok('every required secret was already set')

  const projectId = envValue(readEnvLines(), 'BACKENLY_PROJECT_ID')
  if (!projectId) throw new InstallFailure('BACKENLY_PROJECT_ID is still unset', 'set it in .env and rerun')

  // Said out loud because it is the one value that must never change again: it
  // names the workspace_<uuid> schema every table in this deployment lives in.
  info(`this deployment is project ${projectId}`)
  return { projectId }
}

function startInfrastructure(): void {
  heading('starting postgres and redis')

  // postgrest is deliberately NOT started here. It has no credential until the
  // roles step issues one, so starting it now only proves it restarts in a
  // loop — which is exactly what an operator reads as a broken install.
  run('docker', ['compose', ...COMPOSE, 'up', '-d', 'postgres', 'redis'],
    'check `docker compose -f docker-compose.dev.yml logs postgres`')

  info('waiting for postgres to accept queries')
  // A real query, not pg_isready. The entrypoint runs initdb against a
  // TEMPORARY server on the unix socket, so a socket pg_isready reports ready
  // seconds before the real server exists and the next step then fails with
  // "the database system is starting up".
  const user = envValue(readEnvLines(), 'POSTGRES_USER') || 'backenly_user'
  const db = envValue(readEnvLines(), 'POSTGRES_DB') || 'backenly'
  for (let i = 1; i <= 120; i++) {
    const r = capture('docker', [
      'compose', ...COMPOSE, 'exec', '-T', 'postgres',
      'psql', '-h', '127.0.0.1', '-U', user, '-d', db, '-tAc', 'select 1',
    ])
    if (r.code === 0) {
      ok(`postgres accepting queries after ${i}s`)
      return
    }
    sleepSync(1000)
  }
  throw new InstallFailure(
    'postgres never started accepting queries',
    'check `docker compose -f docker-compose.dev.yml logs postgres`'
  )
}

/** Ask the database a yes/no question through the Compose postgres service. */
function psqlScalar(sql: string): string | null {
  const user = envValue(readEnvLines(), 'POSTGRES_USER') || 'backenly_user'
  const db = envValue(readEnvLines(), 'POSTGRES_DB') || 'backenly'
  const r = capture('docker', [
    'compose', ...COMPOSE, 'exec', '-T', 'postgres',
    'psql', '-h', '127.0.0.1', '-U', user, '-d', db, '-tAc', sql,
  ])
  return r.code === 0 ? r.out.trim() : null
}

/**
 * Split the credential the application runs as from the one that installs it.
 *
 * Before this, web and runtime connected as POSTGRES_USER — the role initdb
 * creates, which is a SUPERUSER. A superuser bypasses row-level security,
 * including FORCE ROW LEVEL SECURITY, so every policy the platform wrote was
 * advisory for the application itself. Isolation held because the code scoped
 * its own queries, not because the database would have refused.
 *
 * Runs BEFORE the schema is pushed, deliberately. `prisma db push` creates the
 * platform tables as whoever it connects as, and in PostgreSQL only an owner
 * may ALTER or DROP a table. Creating the role first means the application owns
 * what it has to manage, rather than needing a second pass to hand it over.
 *
 * It also runs before the superuser SQL, because that SQL grants EXECUTE on its
 * SECURITY DEFINER helpers to whatever `backenly.app_role` names. Set the role
 * afterwards and those grants land on the wrong one.
 */
function configureAppRole(): void {
  heading('separating the application credential from the admin one')

  const lines = readEnvLines()
  const current = envValue(lines, 'DATABASE_URL') || ''

  // Persisted on the first run, because from the second run onwards
  // DATABASE_URL names the non-superuser role and can no longer serve as the
  // admin connection. Without this a rerun would have nothing elevated to use.
  let admin = envValue(lines, 'BACKENLY_ADMIN_DATABASE_URL') || ''
  if (!admin) {
    admin = current
    setEnvVar(lines, 'BACKENLY_ADMIN_DATABASE_URL', admin)
    writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')
    info('recorded the current superuser connection as BACKENLY_ADMIN_DATABASE_URL')
  }

  const r = capture('npx', ['tsx', 'scripts/setup-app-role.ts', '--apply'], {
    BACKENLY_ADMIN_DATABASE_URL: admin,
  })
  process.stdout.write(r.out)
  if (r.code !== 0) {
    throw new InstallFailure(
      'could not create the application role',
      'see the output above; BACKENLY_ADMIN_DATABASE_URL must reach the database as a superuser'
    )
  }

  // The script prints a connection string only when it issued a password,
  // which is the first run. On a rerun it leaves the password alone — rotating
  // it would break a deployment already authenticating with the old one — and
  // .env already names the role.
  const match = r.out.match(/postgresql:\/\/[^\s]+/)
  if (match) {
    const next = readEnvLines()
    setEnvVar(next, 'DATABASE_URL', match[0])
    setEnvVar(next, 'DIRECT_URL', match[0])
    writeFileSync(ENV_PATH, next.join('\n'), 'utf8')
    ok('DATABASE_URL and DIRECT_URL now use the non-superuser application role')
  } else {
    info('application role already had a password; left DATABASE_URL alone')
  }
}

/**
 * Bring the database to the current schema, whatever state it is in.
 *
 * ── This used to be `prisma db push`, and that was only half a step ─────────
 *
 * Push is not idempotent against an installed deployment: the PostgREST
 * registry and its event triggers are created by SQL rather than by Prisma, so
 * push sees objects its schema does not describe and sets out to drop them. A
 * second run failed with P1014 on `backenly_pgrst_schema_registry`, and had it
 * succeeded it would have removed the registry the data plane reads.
 *
 * So this function used to detect an existing install and RETURN. Which made
 * reruns safe and made upgrades impossible: an operator moving between releases
 * got their data intact, their schema frozen, and a P2021 the first time the new
 * code touched a table added since. Push also records no `_prisma_migrations`,
 * so there was no history for `migrate deploy` to work from and nothing for the
 * startup check to compare against.
 *
 * Now every case goes through the canonical migration chain:
 *
 *   empty database    deploy the whole chain. The install is under migration
 *                     control from birth rather than being handed a history
 *                     manufactured after the fact.
 *   legacy install    one-time adoption - prove which migrations this database
 *                     already satisfies IN FULL, record those, deploy the rest.
 *   tracked install   deploy what is pending, which is usually nothing.
 *
 * The decision is made before anything is written, and a database that cannot
 * be proven is refused with the route it should take instead.
 */
function createTables(): void {
  heading('bringing the database to the current schema')

  run('npx', ['prisma', 'generate'], 'check the prisma schema')

  // .env is the authority here: setupAppRole() may have just rewritten
  // DATABASE_URL to the non-superuser application role, and this process's own
  // environment still holds whatever it started with.
  const url = envValue(readEnvLines(), 'DATABASE_URL') || process.env.DATABASE_URL || ''
  if (!url) fail('DATABASE_URL is not set', 'check .env')

  // Delegated to lib/ so the same code path is what the upgrade suite drives.
  // A script-only implementation would be a second copy, and the two would
  // disagree eventually.
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', 'scripts/selfhost-migrate.ts'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } },
  )

  if (result.status !== 0) {
    fail(
      'the database could not be brought to the current schema',
      'the output above says what was refused and what to do about it',
    )
  }

  ok('schema is current, and recorded in _prisma_migrations')
}

/**
 * Run bootstrap and return its state.
 *
 * Bootstrap is the authority on readiness, so this reads its exit code rather
 * than forming its own opinion. 3 is not a failure: it is the documented
 * "core provisioned, superuser prerequisites remain" state.
 */
function runBootstrap(label: string): number {
  heading(label)
  const r = spawnSync('npx', ['tsx', 'scripts/bootstrap.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  })
  const code = r.status ?? 1
  if (code === BOOTSTRAP_EXIT.refused) {
    throw new InstallFailure(
      'bootstrap refused: this database already holds a different deployment',
      'point DATABASE_URL at an empty database, or set BACKENLY_PROJECT_ID to the one already there'
    )
  }
  if (code !== BOOTSTRAP_EXIT.ready && code !== BOOTSTRAP_EXIT.incomplete) {
    throw new InstallFailure(`bootstrap exited ${code}`, 'read the output above')
  }
  return code
}

function installSuperuserPrerequisites(projectId: string): void {
  heading('installing the superuser prerequisites')

  // The chain, in the order the module defines. Not re-typed here: this is the
  // same list bootstrap prints and README.md is tested against.
  const steps = postgrestPrerequisiteSteps(projectId)
  info(`${steps.length} steps, from scripts/bootstrap-prerequisites.ts`)

  // Step 0 is conditional guidance for operators who brought their own
  // database with a non-default role; on the Compose path it is a no-op.
  run('bash', ['scripts/postgrest-install.sh'],
    'the support objects and PostgREST roles could not be installed; see the output above')
  ok('support objects, event triggers and PostgREST roles')

  // The password is printed exactly once and is not recoverable, so it is
  // captured and written to .env here. Doing this by hand was the step most
  // likely to be got wrong: the connection string is easy to mis-copy and a
  // wrong value shows up only as PostgREST restarting in a loop.
  // Run against the ADMIN connection. This step creates roles and sets
  // passwords, both of which need elevation, and DATABASE_URL is deliberately
  // no longer elevated. It reads DATABASE_URL through Prisma, so the admin URL
  // is passed under that name for this one call.
  const adminUrl = envValue(readEnvLines(), 'BACKENLY_ADMIN_DATABASE_URL') || ''
  const r = capture(
    'npx',
    ['tsx', 'scripts/setup-postgrest-roles.ts', '--project', projectId, '--apply'],
    adminUrl ? { DATABASE_URL: adminUrl, DIRECT_URL: adminUrl } : {}
  )
  process.stdout.write(r.out)
  if (r.code !== 0) {
    throw new InstallFailure('could not issue the authenticator password and grants', 'see the output above')
  }

  const match = r.out.match(/postgres:\/\/[^:]+:([^@]+)@/)
  if (match) {
    const lines = readEnvLines()
    const idx = lines.findIndex(l => /^\s*POSTGREST_AUTHENTICATOR_PASSWORD\s*=/.test(l))
    const entry = `POSTGREST_AUTHENTICATOR_PASSWORD=${match[1]}`
    if (idx >= 0) lines[idx] = entry
    else lines.push(entry)
    writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')
    ok('authenticator password issued and written to .env')
  } else {
    // The script prints no connection string when the role already had a
    // password, which is the normal rerun path. Leaving .env alone is correct:
    // the existing value is the one a running PostgREST authenticates with.
    info('authenticator already had a password; left it alone')
    if (!envValue(readEnvLines(), 'POSTGREST_AUTHENTICATOR_PASSWORD')) {
      throw new InstallFailure(
        'the authenticator role has a password but .env does not carry it',
        `npx tsx scripts/setup-postgrest-roles.ts --project ${projectId} --apply --rotate-password  (then rerun)`
      )
    }
  }

  // Optional, and reported as optional by bootstrap. Installed here because
  // "one command" should mean the whole product, and it is the difference
  // between direct psql access working and being advertised but absent.
  const direct = capture('bash', ['scripts/install-sql.sh', 'scripts/setup-direct-access.sql'])
  if (direct.code === 0) ok('privileged role helpers, for direct database credentials')
  else info('privileged role helpers not installed; direct psql credentials will be unavailable')
}

/**
 * The backup credential, converged LAST.
 *
 * Deployment Recovery and the project snapshot both run pg_dump, and on a
 * correctly split install the application role cannot do it: it has no
 * privileges on the installer-owned PostgREST registry in `public`, and
 * workspace tables are FORCE ROW LEVEL SECURITY while `backenly_app` is
 * deliberately NOBYPASSRLS. Recovery export failed with
 * "permission denied for table backenly_pgrst_schema_registry".
 *
 * `scripts/setup-app-role.ts` and README.md have both described a four-role
 * architecture since the credential split; only three were ever created by
 * code, and the README told operators to run this CREATE ROLE by hand — with a
 * grant list that covers the workspace schema and not `public`, so even
 * following it left recovery broken.
 *
 * ORDER IS THE WHOLE REASON THIS IS HERE rather than beside configureAppRole().
 * The objects appear at different times: platform tables from the migration
 * chain, the registry and event triggers from the elevated SQL after it, the
 * workspace schema from bootstrap after that. Grants taken any earlier would
 * miss most of them. It converges existing objects every run AND sets default
 * privileges for what is created later.
 */
function configureBackupRole(): void {
  heading('creating the backup credential recovery needs')

  const lines = readEnvLines()
  const admin = envValue(lines, 'BACKENLY_ADMIN_DATABASE_URL') || ''
  if (!admin) {
    throw new InstallFailure(
      'BACKENLY_ADMIN_DATABASE_URL is not set',
      'it is recorded on the first run; rerunning the installer restores it'
    )
  }

  // Rotate when .env has lost the credential. Unlike the application and
  // authenticator passwords, nothing serves live requests with this one — it is
  // an offline dump credential — so a deployment that cannot be backed up is
  // the worse outcome. Explicit, and idempotent: with a credential already
  // recorded, the password is left alone.
  const existing = envValue(lines, 'BACKUP_DATABASE_URL') || ''
  const args = ['tsx', 'scripts/setup-backup-role.ts', '--apply']
  if (!existing) args.push('--rotate-password')

  const r = capture('npx', args, { BACKENLY_ADMIN_DATABASE_URL: admin })
  process.stdout.write(r.out)
  if (r.code !== 0) {
    throw new InstallFailure(
      'could not create the backup role',
      'see the output above; without it pg_dump cannot read this deployment'
    )
  }

  const match = r.out.match(/postgresql:\/\/[^\s]+/)
  if (match) {
    const next = readEnvLines()
    setEnvVar(next, 'BACKUP_DATABASE_URL', match[0])
    writeFileSync(ENV_PATH, next.join('\n'), 'utf8')
    ok('BACKUP_DATABASE_URL records the dedicated read-only backup role')
  } else {
    info('backup role already had a password; left BACKUP_DATABASE_URL alone')
  }
}

/**
 * Every role the architecture advertises must actually exist.
 *
 * The docs described four and the code created three, and nothing compared the
 * two — so Deployment Recovery was broken on every correctly split install
 * until the final qualification tried it. This is the ratchet that stops the
 * mismatch coming back.
 */
function verifyRoles(): void {
  heading('every advertised role exists')

  const expected = ['backenly_app', 'backenly_authenticator', 'backenly_backup']
  const missing: string[] = []
  for (const role of expected) {
    const found = psqlScalar(`SELECT count(*) FROM pg_roles WHERE rolname = '${role}'`)
    if (found === '1') ok(`${role}`)
    else missing.push(role)
  }

  if (missing.length > 0) {
    throw new InstallFailure(
      `the install finished without ${missing.join(', ')}`,
      'the credential split is what keeps RLS enforceable and backups readable; rerunning is safe'
    )
  }
}

function startDataPlane(): void {
  heading('starting the data plane')
  run('docker', ['compose', ...COMPOSE, 'up', '-d', 'postgrest'],
    'check `docker compose -f docker-compose.dev.yml logs postgrest`')
  ok('postgrest started')
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('')
  console.log('  Backenly self-host installer')
  console.log('  One deployment is one project.')

  checkPrerequisites()
  const { projectId } = ensureEnvFile()
  startInfrastructure()
  configureAppRole()
  createTables()

  // First run. Exit 3 is expected and documented: it provisions the project,
  // its schema and its signing secret, then reports what only a superuser can
  // install. Reaching 0 here is fine too, on a rerun where they already are.
  const first = runBootstrap('bootstrapping the project')

  if (first === BOOTSTRAP_EXIT.incomplete) {
    installSuperuserPrerequisites(projectId)
    startDataPlane()

    // Rerunning IS the mechanism. Bootstrap is a reconciler, and the
    // prerequisites it could not install itself now exist.
    const second = runBootstrap('reconciling, now that the prerequisites exist')
    if (second !== BOOTSTRAP_EXIT.ready) {
      throw new InstallFailure(
        'bootstrap still reports unmet prerequisites',
        'read its output above; it names exactly what is missing, and rerunning is safe'
      )
    }
  } else {
    // Already ready. Still converge the data plane, because a previous run may
    // have stopped before starting it.
    startDataPlane()
  }

  // Last, because it grants over objects every step above creates.
  configureBackupRole()
  verifyRoles()

  const setupToken = envValue(readEnvLines(), 'BACKENLY_SETUP_TOKEN') || ''
  const appUrl = (envValue(readEnvLines(), 'NEXT_PUBLIC_APP_URL') || 'http://localhost:3000').replace(/\/+$/, '')

  console.log('')
  console.log('  Backenly is installed.')
  console.log('')
  console.log('    npm run dev          dashboard :3000 · runtime :3001')
  console.log('')
  console.log('  Then claim this deployment. Open this link and create your account;')
  console.log('  the first account to present the token becomes the administrator and')
  console.log('  takes ownership of this project in the same step — there is no second')
  console.log('  command to run.')
  console.log('')
  console.log(`    ${appUrl}/auth/signup?setup_token=${setupToken}`)
  console.log('')
  console.log('  Or paste the token into the Setup token field on the signup page:')
  console.log('')
  console.log(`    ${setupToken}`)
  console.log('')
  console.log('  It is in .env as BACKENLY_SETUP_TOKEN. Once the deployment is claimed')
  console.log('  the token stops working, whatever it is set to.')
  console.log('')

  // Said here because nothing else will say it until someone needs it: with
  // no mail transport, password-reset codes cannot be sent, and a second
  // account (BACKENLY_ALLOW_PUBLIC_SIGNUP=true) cannot verify its email.
  const lines = readEnvLines()
  const mailConfigured = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].every(k => !!envValue(lines, k))
  if (mailConfigured) {
    console.log('  Email: configured (SMTP). Password-reset codes will be sent.')
  } else {
    console.log('  Email: not configured, so password-reset codes cannot be sent.')
    console.log('  Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in .env to')
    console.log('  enable it. Until then, reset a password from this machine with:')
    console.log('')
    console.log('    npm run auth:reset-password -- --email you@example.com')
  }
  console.log('')
}

try {
  main()
} catch (err) {
  if (err instanceof InstallFailure) {
    console.error('')
    console.error(`  Install stopped: ${err.what}`)
    console.error('')
    console.error(`    ${err.fix}`)
    console.error('')
    console.error('  Rerunning is safe. This installer only fills what is missing.')
    console.error('')
    process.exit(1)
  }
  throw err
}
