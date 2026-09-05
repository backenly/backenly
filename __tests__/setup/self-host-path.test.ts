/**
 * THE DOCUMENTED SELF-HOST PATH MUST BE EXECUTABLE
 * ===============================================
 * Four defects found by running the README on a clean Ubuntu 24.04 machine.
 * Every one of them was invisible to a reader and obvious to an installer, so
 * each gets an assertion here rather than a promise to remember.
 *
 *   1. "Docker covers the first two" claimed Docker supplied Node. It does not:
 *      npm install and npm run dev run on the host.
 *   2. The setup scripts hardcoded `sudo -u postgres psql`, which assumes
 *      PostgreSQL is on this host, an OS user named postgres exists, and psql is
 *      installed here. The documented Docker quickstart satisfies none of them,
 *      so the primary path could not run its own prerequisite step.
 *   3. "Requires PostgREST" was the entire instruction. Nothing installed the
 *      binary and there was no config to copy, so the install stopped at step 4.
 *   4. `psql -f <file>` makes the DATABASE's user open the file, and Ubuntu home
 *      directories are 0750, so a normal clone was unreadable by postgres.
 *
 * Finding 4's runtime proof needs two OS users and POSIX permissions, so it
 * lives in scripts/test/sql-file-access.sh and runs in CI. What is asserted here
 * is that the mechanism it proves is still the one in the file.
 *
 * No database: this reads committed text.
 */

import * as fs from 'fs'
import * as path from 'path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/**
 * Shell source with whole-line `#` comments removed.
 *
 * These files explain the defects they fixed, quoting the old commands, so a
 * plain substring search finds `sudo -u postgres` and `-f "$file"` in prose
 * that exists precisely to stop anyone reintroducing them. Assert on what runs.
 */
const code = (p: string) =>
  read(p)
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n')

const README = read('README.md')
const COMPOSE = read('docker-compose.dev.yml')
const DB_ADMIN = read('scripts/lib/db-admin.sh')

describe('finding 1 — the prerequisites say what actually runs where', () => {
  it('never claims Docker supplies Node', () => {
    expect(README).not.toContain('Docker covers the first two')
    // The claim could come back in another shape, so assert the correction is
    // present rather than only that one sentence is gone.
    expect(README).toContain('Docker does not provide Node')
  })

  it('names Node as a host install and the stack as the container side', () => {
    expect(README).toMatch(/\*\*You install on the host:\*\*/)
    expect(README).toMatch(/\*\*Node\.js 20\+\*\*/)
    expect(README).toMatch(/\*\*The Compose stack provides:\*\*/)
    for (const provided of ['PostgreSQL 15', 'Redis', 'PostgREST']) {
      expect(README).toContain(provided)
    }
  })
})

describe('finding 2 — no setup script assumes a local postgres account', () => {
  it('keeps sudo -u postgres out of the scripts an operator is told to run', () => {
    // db-admin.sh still contains it, in `local` mode, which is correct: that
    // mode exists FOR a cluster on this host. What must not happen is a script
    // reaching for it unconditionally.
    expect(code('scripts/postgrest-install.sh')).not.toContain('sudo -u postgres')
    expect(code('scripts/install-sql.sh')).not.toContain('sudo -u postgres')
  })

  it('offers three explicit modes and defaults to the documented one', () => {
    expect(DB_ADMIN).toContain('BACKENLY_DB_ADMIN="${BACKENLY_DB_ADMIN:-docker}"')
    for (const mode of ['docker', 'url', 'local']) {
      expect(DB_ADMIN).toContain(`BACKENLY_DB_ADMIN=${mode}`)
    }
    // Explicit, not sniffed: choosing wrong runs privileged DDL somewhere else.
    expect(DB_ADMIN).toContain('BACKENLY_ADMIN_DATABASE_URL')
    expect(README).toContain('BACKENLY_DB_ADMIN')
  })

  it('routes the direct-access prerequisite through the same mechanism', () => {
    // It used to be documented as `sudo -u postgres psql -d backenly -f ...`,
    // which is the exact form that failed.
    expect(read('scripts/setup-direct-access.sh')).toContain(
      'bash scripts/install-sql.sh scripts/setup-direct-access.sql',
    )
  })
})

describe('finding 3 — the documented path produces a running PostgREST', () => {
  it('ships PostgREST in the Compose stack, pinned', () => {
    const pinned = COMPOSE.match(/image:\s*postgrest\/postgrest:(\S+)/)
    expect(pinned).not.toBeNull()
    // A floating tag would let the data plane change version underneath a
    // deployment whose schema cache and role settings live in the database.
    expect(pinned![1]).not.toBe('latest')
    expect(pinned![1]).toMatch(/^v\d+\.\d+/)
  })

  it('wires it to the authenticator and the shared gateway secret', () => {
    expect(COMPOSE).toContain('PGRST_DB_URI')
    expect(COMPOSE).toContain('backenly_authenticator')
    // The gateway mints internal tokens with POSTGREST_JWT_SECRET; PostgREST
    // holds exactly one secret, so the two must be the same value.
    expect(COMPOSE).toContain('PGRST_JWT_SECRET: ${POSTGREST_JWT_SECRET:-}')
    expect(COMPOSE).toContain('PGRST_DB_ANON_ROLE: anon')
    // db-schemas comes from the role setting the registry writes. Pinning it
    // here would stop a newly provisioned project from ever appearing.
    expect(COMPOSE).not.toMatch(/^\s*PGRST_DB_SCHEMAS:/m)
  })

  it('gives the operator a command to start it, not just a requirement', () => {
    expect(README).toContain('docker compose -f docker-compose.dev.yml up -d postgrest')
    expect(README).toContain('POSTGREST_AUTHENTICATOR_PASSWORD')
  })
})

describe('finding 4 — SQL is opened by the operator, never by the database user', () => {
  it('redirects the file on stdin instead of passing a path to psql', () => {
    expect(DB_ADMIN).toContain('db_admin_psql -v ON_ERROR_STOP=1 -q -f - < "$file"')
    // The regression is specifically `-f "$file"`, which hands the path to
    // whoever psql runs as.
    expect(code('scripts/lib/db-admin.sh')).not.toContain('-f "$file"')
  })

  it('has a runtime proof that reverting the line fails', () => {
    // Static assertions cannot show that the old form breaks. That is what the
    // shell test does, with two users and a real 0750 directory.
    const probe = read('scripts/test/sql-file-access.sh')
    expect(probe).toContain('0750')
    expect(probe).toContain('db_admin_psql -v ON_ERROR_STOP=1 -q -f "$file"')
    expect(probe).toContain('proves nothing')
  })
})

/**
 * ACCEPTANCE FINDING D — autonomy was documented nowhere
 * =====================================================
 * The acceptance run could not satisfy "autonomy ticks THE_PROJECT" from the
 * documentation, and my first reading of that was wrong in an instructive way.
 * I probed `/api/cron/autonomy`, got 401, and concluded there was no scheduler.
 *
 * There is one. instrumentation.ts starts an in-process node-cron tick on every
 * non-Vercel boot, and it had been running on the acceptance machine the whole
 * time, once a minute, reporting `0 projects`. Zero was CORRECT: the activity
 * gate requires a project to have tables (or an open finding) before there is
 * anything to reconcile, and the install had none yet.
 *
 * So the gap was documentation, not mechanism. These assertions tie the README
 * to the code it describes, because every claim in that section is one a reader
 * would otherwise have to take on faith — and the cadence, the flag names and
 * the log line are all things a refactor can silently change.
 */
describe('finding D — the README describes the autonomy that actually runs', () => {
  const INSTRUMENTATION = read('instrumentation.ts')

  it('documents the scheduler that exists, not the endpoint that nothing calls', () => {
    expect(README).toContain('instrumentation.ts')
    // The endpoint is real but ad-hoc. Presenting it as the mechanism is what
    // sent the acceptance run down the wrong path.
    expect(README).toContain('Nothing calls that URL on its own')
    expect(README).toContain('CRON_SECRET')
  })

  it('states the cadence the code actually schedules', () => {
    // The reconciler tick. If this expression changes, the README is wrong.
    const reconciler = INSTRUMENTATION.slice(INSTRUMENTATION.indexOf('runReconciler'))
    expect(INSTRUMENTATION).toContain("cron.schedule('* * * * *'")
    expect(reconciler).toContain('runReconciler')
    expect(README).toContain('every minute')
  })

  it('names the flags that gate it, and matches the shipped template', () => {
    for (const flag of ['ENABLE_AUTONOMY_RECONCILER', 'ENABLE_AUTONOMY_LIVE_EXECUTION']) {
      expect(README).toContain(flag)
      // The code default is false; the template turns them on. A reader
      // following the README copies that template, so the two must agree.
      expect(read('.env.example')).toMatch(new RegExp(`^${flag}=true$`, 'm'))
      expect(read('lib/config/flags.ts')).toContain(flag)
    }
  })

  it('quotes the log line the process really prints', () => {
    // Verbatim from instrumentation.ts, so a reworded log breaks this rather
    // than leaving an operator watching for a string that never appears.
    expect(INSTRUMENTATION).toContain('[AutonomyReconciler] Cron run complete')
    expect(README).toContain('[AutonomyReconciler] Cron run complete')
  })

  it('explains why a fresh install reports zero projects', () => {
    // The single most confusing observation on a new box, and the reason the
    // acceptance run could not prove item 9.
    expect(README).toContain('`0 projects` is normal on a new install')
    expect(read('lib/autonomy/activity-gate.ts')).toContain('tables: { some: {} }')
  })
})
