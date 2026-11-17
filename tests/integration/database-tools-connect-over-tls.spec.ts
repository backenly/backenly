/**
 * PG_DUMP AND PSQL CONNECT OVER TLS, WHATEVER HOME THE APP INHERITED
 * ==================================================================
 *
 * Production QA re-test, 2026-11-16, new finding N5: "Export your backend"
 * answered 503 for a full, schema-only and data-only export alike. The web image
 * starts as root and runs the app as node, and the app kept root's HOME. libpq
 * looks for a client certificate under $HOME/.postgresql on every TLS
 * connection and gives up on a path it cannot look at, so every pg_dump and
 * psql the app started failed before sending a query:
 *
 *   could not open certificate file "/root/.postgresql/postgresql.crt": Permission denied
 *
 * Exports, the daily snapshots and every restore go through the two
 * connection builders proven here (lib/services/workspace-backup.ts
 * buildConnection, lib/recovery/restore.ts connectionArgs).
 *
 * A throwaway PostgreSQL 16 that accepts only TLS, as RDS does with
 * rds.force_ssl, a HOME this process cannot enter, and the real pg_dump and
 * psql. Needs initdb (PG_BINDIR, else pg_config), pg_dump, psql and openssl;
 * skipped and named as skipped where one is missing, and required in CI.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { Client } from 'pg'
import { buildConnection } from '@/lib/services/workspace-backup'
import { connectionArgs } from '@/lib/recovery/restore'

jest.setTimeout(120_000)

/** The directory holding initdb, pg_ctl, pg_dump and psql, or why there is none. */
function binaries(): { dir: string } | { missing: string } {
  let dir = process.env.PG_BINDIR ?? ''
  if (!dir) {
    try {
      dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
    } catch {
      return { missing: 'PG_BINDIR (or pg_config on PATH)' }
    }
  }
  const absent = ['initdb', 'pg_ctl', 'pg_dump', 'psql'].filter((tool) => !fs.existsSync(path.join(dir, tool)))
  if (absent.length > 0) return { missing: `${absent.join(', ')} in ${dir}` }
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' })
  if (openssl.status !== 0) return { missing: 'openssl' }
  return { dir }
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const found = binaries()
const skipReason =
  process.platform === 'win32'
    ? 'needs a POSIX system'
    : isRoot
      ? 'as root every directory can be entered, so there is no unreadable HOME to make'
      : 'missing' in found
        ? `needs ${found.missing}`
        : null
if (skipReason && process.env.CI && !isRoot && process.platform !== 'win32') {
  throw new Error(`CI runs this suite against a real PostgreSQL 16 and its clients: ${skipReason}`)
}
const describeTls = skipReason ? describe.skip : describe

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

describeTls(`pg_dump and psql over TLS from the app${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  const bin = 'dir' in found ? found.dir : ''
  const schema = `workspace_${randomUUID()}`
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, BACKUP_DATABASE_URL: process.env.BACKUP_DATABASE_URL }
  let work = ''
  let data = ''
  let closedHome = ''
  let url = ''
  let started = false

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-pg-'))
    data = path.join(work, 'data')
    execFileSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-sync', '-E', 'UTF8'], { stdio: 'ignore' })
    execFileSync('openssl', [
      'req', '-new', '-x509', '-days', '2', '-nodes', '-subj', '/CN=localhost',
      '-keyout', path.join(data, 'server.key'), '-out', path.join(data, 'server.crt'),
    ], { stdio: 'ignore' })
    fs.chmodSync(path.join(data, 'server.key'), 0o600)

    const port = await freePort()
    fs.appendFileSync(path.join(data, 'postgresql.conf'), [
      '',
      `port = ${port}`,
      "listen_addresses = '127.0.0.1'",
      // A socket path under the temp directory can pass the 103-byte limit.
      "unix_socket_directories = ''",
      'ssl = on',
      'fsync = off',
      '',
    ].join('\n'))
    // TLS or nothing, as an RDS database with rds.force_ssl answers.
    fs.writeFileSync(path.join(data, 'pg_hba.conf'), 'hostssl all all 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 reject\n')
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(work, 'server.log'), '-w', '-t', '60', 'start'], { stdio: 'ignore' })
    started = true

    const client = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`CREATE TABLE "${schema}".items (id int PRIMARY KEY, label text NOT NULL)`)
      await client.query(`INSERT INTO "${schema}".items VALUES (1, 'kept-over-tls')`)
    } finally {
      await client.end()
    }

    url = `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=require`
    closedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-pg-home-'))
    fs.chmodSync(closedHome, 0o000)
    // What the app process held in the image: a HOME it cannot enter.
    process.env.HOME = closedHome
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
    process.env.BACKUP_DATABASE_URL = url
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (started) spawnSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' })
    if (closedHome) {
      fs.chmodSync(closedHome, 0o700)
      fs.rmSync(closedHome, { recursive: true, force: true })
    }
    if (work) fs.rmSync(work, { recursive: true, force: true })
  })

  it('is the failure the app hit: libpq refuses TLS when it cannot look in the inherited HOME', () => {
    const run = spawnSync('psql', ['--no-psqlrc', '--tuples-only', '--command', 'SELECT 1', url], {
      env: { ...process.env },
      encoding: 'utf8',
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/could not open certificate file ".*postgresql\.crt": Permission denied/)
  })

  it('dumps the schema with the connection snapshots and exports use', () => {
    const conn = buildConnection('read')
    const run = spawnSync('pg_dump', [...conn.args, `--schema=${schema}`, '--no-owner', '--no-privileges'], {
      env: conn.env,
      encoding: 'utf8',
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(`CREATE TABLE "${schema}".items`)
    expect(run.stdout).toContain('kept-over-tls')
  })

  it('runs psql with the connection a deployment restore uses', () => {
    const conn = connectionArgs(url)
    const run = spawnSync('psql', [...conn.args, '--no-psqlrc', '--tuples-only', '--no-align', '--command', `SELECT label FROM "${schema}".items`], {
      env: conn.env,
      encoding: 'utf8',
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('kept-over-tls')
  })
})
