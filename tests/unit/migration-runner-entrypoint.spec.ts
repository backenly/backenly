/**
 * THE MIGRATION RUNNER'S ENTRYPOINT — the guard closest to the write
 * ==================================================================
 *
 * `scripts/run-production-migration-job.ts` checks the AWS account and checks
 * that the secret's ARN names a production resource. Both are checks on
 * POINTERS: they pass whether or not the secret's contents point where the ARN
 * suggests. This script runs inside the container and parses the URL it is
 * actually about to connect with, which is the only check that sees the thing
 * itself.
 *
 * It matters most for `baseline`. `migrate resolve --applied` writes migration
 * history into whatever database it reaches, and re-running it against the right
 * one does not undo what it wrote into the wrong one.
 *
 * Executed as real `sh`, not read as text. The parsing is POSIX parameter
 * expansion and the failure modes are shell failure modes — an assertion about
 * what the file CONTAINS would pass just as happily against a script with a
 * syntax error in it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRYPOINT = join(__dirname, '..', '..', 'tools', 'managed-db', 'runner', 'entrypoint.sh')

interface Run {
  status: number
  output: string
}

/**
 * Run the entrypoint with a fake prisma on PATH, so the guard is exercised
 * without the real CLI and without a database anywhere.
 */
function run(args: string[], env: Record<string, string>): Run {
  try {
    const output = execFileSync('sh', [ENTRYPOINT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        // The entrypoint execs an absolute path that does not exist here, so a
        // run that gets PAST the guard fails at the exec. That is the signal:
        // "refusing" means the guard stopped it, anything else means it did not.
        ...env,
      },
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const url = (db: string, opts: { password?: string; query?: string } = {}) =>
  `postgresql://backenly_user:${opts.password ?? 'pw'}@db.example.internal:5432/${db}${opts.query ?? ''}`

describe('the entrypoint refuses the wrong database', () => {
  it('exists and is a shell script', () => {
    expect(existsSync(ENTRYPOINT)).toBe(true)
  })

  it('refuses when the connected database is not the expected one', () => {
    const r = run(['status'], { EXPECT_DATABASE: 'backenly', DATABASE_URL: url('backenly_staging') })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/refusing: connected database is "backenly_staging", expected "backenly"/)
  })

  it('refuses when DATABASE_URL is empty but a database was named', () => {
    const r = run(['status'], { EXPECT_DATABASE: 'backenly', DATABASE_URL: '' })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/DATABASE_URL is empty/)
  })

  it('refuses a URL with no database path at all, rather than guessing', () => {
    // Extraction yields "db.example.internal:5432", which matches nothing. The
    // failure direction is the point: an unparseable URL must not pass.
    const r = run(['status'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: 'postgresql://backenly_user:pw@db.example.internal:5432',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/refusing: connected database is/)
  })

  it('accepts the expected database, and says which one it matched', () => {
    const r = run(['status'], { EXPECT_DATABASE: 'backenly', DATABASE_URL: url('backenly') })
    // Past the guard, so it fails at the missing prisma binary rather than at a
    // refusal. Non-vacuity: proves the guard is what stops the cases above.
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
    expect(r.output).not.toMatch(/refusing/)
  })

  it('is not confused by a password containing a slash or an at-sign', () => {
    // Parsed after the LAST '@', so neither can shift the fields. A naive parse
    // splits on the first '/' after the scheme and reads the password as the
    // database, which would refuse a correct URL — or, with the wrong password,
    // accept an incorrect one.
    const r = run(['status'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly', { password: 'a/b@c' }),
    })
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
  })

  it('ignores query parameters after the database name', () => {
    const r = run(['status'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly', { query: '?sslmode=require&connection_limit=1' }),
    })
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
  })

  it('skips the check entirely when no database was named', () => {
    // Staging runs without it. The guard is opt-in so that adding it to the
    // image did not change what the staging launcher already does.
    const r = run(['status'], { DATABASE_URL: url('anything') })
    expect(r.output).not.toMatch(/refusing/)
    expect(r.output).not.toMatch(/matches EXPECT_DATABASE/)
  })
})

describe('the entrypoint still refuses an unconfirmed baseline', () => {
  it('will not resolve a migration as applied without the naming confirmation', () => {
    const r = run(['baseline', '00000000000000_baseline'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly'),
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/MIGRATE_BASELINE_CONFIRM to name the same migration/)
  })

  it('will not accept a confirmation naming a DIFFERENT migration', () => {
    const r = run(['baseline', '00000000000000_baseline'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly'),
      MIGRATE_BASELINE_CONFIRM: '20260916120000_maintenance_ledger',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/MIGRATE_BASELINE_CONFIRM to name the same migration/)
  })

  it('rejects an unknown command rather than doing nothing quietly', () => {
    const r = run(['migrate-everything'], { DATABASE_URL: url('backenly') })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/usage: status \| deploy \| preflight \| baseline <migration-id> \| rollback <migration-id>/)
  })
})

// ── Ordering, with a recording stand-in for prisma ─────────────────────────
//
// The runner's promises are about ORDER: the preflight runs before `migrate
// deploy`, and the absence proof runs before `migrate resolve --rolled-back`.
// A stand-in that records every invocation, and fails when told to, is how the
// order becomes observable without a database. The database-backed half, with
// the real CLI against a real PostgreSQL, is
// tests/integration/migration-ownership-recovery.spec.ts.

describe('the entrypoint runs its checks before it touches migration history', () => {
  let dir: string
  let stub: string
  let log: string

  beforeAll(() => {
    // Forward slashes: the paths are handed to `sh`, which on a Windows checkout
    // is Git Bash and reads a backslash as an escape.
    dir = mkdtempSync(join(tmpdir(), 'runner-stub-')).replace(/\\/g, '/')
    stub = `${dir}/prisma`
    log = `${dir}/calls.log`
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'echo "$*" >> "$STUB_LOG"',
        'if [ -n "${STUB_FAIL_ON:-}" ]; then',
        '  case "$*" in *"$STUB_FAIL_ON"*) echo "stub: failing on $STUB_FAIL_ON"; exit 1 ;; esac',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const calls = (): string[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []

  function withStub(args: string[], env: Record<string, string> = {}): Run {
    rmSync(log, { force: true })
    return run(args, {
      DATABASE_URL: url('backenly'),
      MIGRATE_PRISMA: stub,
      MIGRATE_SCHEMA: '/schema.prisma',
      MIGRATE_CHECKS: '/checks',
      STUB_LOG: log,
      ...env,
    })
  }

  it('deploy runs the ownership preflight first, and never deploys when it fails', () => {
    const r = withStub(['deploy'], { STUB_FAIL_ON: 'ownership-preflight.sql' })
    expect(r.status).toBe(3)
    expect(r.output).toMatch(/refusing: ownership preflight failed; nothing was applied and no migration history was written/)
    expect(calls()).toEqual(['db execute --schema /schema.prisma --file /checks/ownership-preflight.sql'])
  })

  it('deploy proceeds to migrate deploy only after the preflight passes', () => {
    const r = withStub(['deploy'])
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/PREFLIGHT PASSED/)
    expect(calls()).toEqual([
      'db execute --schema /schema.prisma --file /checks/ownership-preflight.sql',
      'migrate deploy --schema /schema.prisma',
    ])
  })

  it('preflight alone runs the check and nothing else', () => {
    const r = withStub(['preflight'])
    expect(r.status).toBe(0)
    expect(calls()).toEqual(['db execute --schema /schema.prisma --file /checks/ownership-preflight.sql'])
  })

  it('rollback refuses without a confirmation, and calls nothing', () => {
    const r = withStub(['rollback', '20260924120000_project_pause'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/MIGRATE_ROLLBACK_CONFIRM to name the same migration/)
    expect(calls()).toEqual([])
  })

  it('rollback refuses a confirmation that names a DIFFERENT migration', () => {
    const r = withStub(['rollback', '20260924120000_project_pause'], {
      MIGRATE_ROLLBACK_CONFIRM: '20260922120000_auth_email_codes',
    })
    expect(r.status).toBe(2)
    expect(calls()).toEqual([])
  })

  it('rollback refuses a migration that has no absence proof, even when confirmed', () => {
    const r = withStub(['rollback', '20260922120000_auth_email_codes'], {
      MIGRATE_ROLLBACK_CONFIRM: '20260922120000_auth_email_codes',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/no absence proof is defined/)
    expect(calls()).toEqual([])
  })

  it('rollback refuses when the absence proof fails, and never resolves', () => {
    const r = withStub(['rollback', '20260924120000_project_pause'], {
      MIGRATE_ROLLBACK_CONFIRM: '20260924120000_project_pause',
      STUB_FAIL_ON: 'project_pause.absent.sql',
    })
    expect(r.status).toBe(3)
    expect(r.output).toMatch(/left effects of 20260924120000_project_pause behind/)
    expect(calls()).toEqual([
      'db execute --schema /schema.prisma --file /checks/20260924120000_project_pause.absent.sql',
    ])
  })

  it('rollback resolves only after the absence proof passes', () => {
    const r = withStub(['rollback', '20260924120000_project_pause'], {
      MIGRATE_ROLLBACK_CONFIRM: '20260924120000_project_pause',
    })
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/ABSENT: 20260924120000_project_pause left none of its declared effects behind/)
    expect(calls()).toEqual([
      'db execute --schema /schema.prisma --file /checks/20260924120000_project_pause.absent.sql',
      'migrate resolve --rolled-back 20260924120000_project_pause --schema /schema.prisma',
    ])
  })

  it('verify for the pause migration runs its presence proof', () => {
    const r = withStub(['verify', '20260924120000_project_pause'])
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/VERIFIED: 20260924120000_project_pause/)
    expect(calls()).toEqual([
      'db execute --schema /schema.prisma --file /checks/20260924120000_project_pause.present.sql',
    ])
  })

  it('verify does not claim success when the presence proof fails', () => {
    const r = withStub(['verify', '20260924120000_project_pause'], { STUB_FAIL_ON: 'present.sql' })
    expect(r.status).not.toBe(0)
    expect(r.output).not.toMatch(/VERIFIED/)
  })
})
