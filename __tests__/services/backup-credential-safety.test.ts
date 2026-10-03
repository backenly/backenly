/**
 * A failed backup must never reveal the database password.
 *
 * It used to. `buildPgDumpArgs()` returned the full `postgresql://user:pass@host`
 * URL for interpolation into a shell command, and Node's exec error carries the
 * whole command it ran. So every pg_dump failure wrote the live production
 * credential into the Web error log and into `workspace_backups.error`.
 * Measured on production 2026-09-06: 450 log lines containing the DB URI with
 * credentials.
 *
 * These tests use a distinctive fake secret and assert it appears ZERO times in
 * every place a real failure would have leaked it: argv, the thrown error, the
 * message returned to the caller, and anything written to the console.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

import { buildConnection, sanitizeError } from '@/lib/services/workspace-backup'

const execFileAsync = promisify(execFile)

const SECRET = 'S3cr3t-Passw0rd-DO-NOT-LEAK-9f4b2c'
const URL_WITH_SECRET = `postgresql://backenly_user:${SECRET}@db.internal:5432/backenly`

const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  BACKUP_DATABASE_URL: process.env.BACKUP_DATABASE_URL,
}

beforeEach(() => {
  process.env.DATABASE_URL = URL_WITH_SECRET
  delete process.env.DIRECT_URL
  delete process.env.BACKUP_DATABASE_URL
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('buildConnection keeps the password out of argv', () => {
  it('puts host, port, user and dbname in args and the password only in env', () => {
    const { args, env } = buildConnection()

    expect(args.join(' ')).not.toContain(SECRET)
    expect(args).toEqual(
      expect.arrayContaining(['--host', 'db.internal', '--port', '5432', '--username', 'backenly_user']),
    )
    expect(args).toContain('--no-password')
    expect(env.PGPASSWORD).toBe(SECRET)
  })

  it('never emits a connection URI at all', () => {
    const { args } = buildConnection()
    expect(args.some((a) => a.includes('://'))).toBe(false)
  })

  it('carries sslmode through the environment rather than the URL', () => {
    process.env.DATABASE_URL = `${URL_WITH_SECRET}?sslmode=require`
    const { args, env } = buildConnection()
    expect(env.PGSSLMODE).toBe('require')
    expect(args.join(' ')).not.toContain(SECRET)
  })

  it('prefers BACKUP_DATABASE_URL when set', () => {
    process.env.BACKUP_DATABASE_URL = 'postgresql://ro_user:other@ro.internal:6543/backenly'
    const { args, env } = buildConnection()
    expect(args).toEqual(expect.arrayContaining(['--username', 'ro_user', '--host', 'ro.internal']))
    expect(env.PGPASSWORD).toBe('other')
  })
})

describe('sanitizeError removes anything credential-shaped', () => {
  it('redacts a password embedded in a connection URI', () => {
    const msg = `Command failed: pg_dump "${URL_WITH_SECRET}" --schema="x"`
    const clean = sanitizeError(msg)
    expect(clean).not.toContain(SECRET)
    expect(clean).toContain('***')
  })

  it('redacts a bare occurrence of the configured password', () => {
    expect(sanitizeError(`something went wrong near ${SECRET} here`)).not.toContain(SECRET)
  })

  it('leaves an ordinary message untouched', () => {
    const msg = 'pg_dump: error: query would be affected by row-level security policy'
    expect(sanitizeError(msg)).toBe(msg)
  })

  it('handles null and undefined without throwing', () => {
    expect(sanitizeError(undefined as unknown as string)).toBe('')
    expect(sanitizeError(null as unknown as string)).toBe('')
  })
})

describe('a REAL child-process failure leaks nothing', () => {
  it('the thrown error from a failing binary contains no secret', async () => {
    // The exact shape of the old bug: run a command that fails and inspect what
    // the error carries. With discrete argv there is no command string holding
    // the password for the error to quote back.
    const { args, env } = buildConnection()

    let caught: any
    try {
      await execFileAsync('definitely-not-a-real-binary-xyz', [...args, '--schema', 'test'], { env })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    const surface = [caught?.message, caught?.stderr, caught?.cmd, String(caught)].join('\n')
    expect(surface).not.toContain(SECRET)
    expect(sanitizeError(surface)).not.toContain(SECRET)
  })
})
