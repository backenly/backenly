/**
 * PG_DUMP AND PSQL GET A HOME THEY CAN LOOK IN
 * =============================================
 *
 * libpq looks for a client certificate under $HOME/.postgresql on every TLS
 * connection, and a path it cannot even look at ends the connection:
 * `could not open certificate file "/root/.postgresql/postgresql.crt":
 * Permission denied` (PostgreSQL, src/interfaces/libpq/fe-secure-openssl.c).
 *
 * The web image starts as root and runs the app as node, and the app kept
 * root's HOME, which node cannot enter. Every pg_dump and psql the app started
 * inherited it, so exports, daily snapshots and restores all failed to connect
 * (production QA re-test, 2026-11-16, new finding N5). The entrypoint now hands
 * the app node's own home (tests/unit/function-isolation-images.spec.ts). These
 * pin the second half: whatever the app inherited, the two builders every
 * pg_dump and psql goes through give the child the home of the user the
 * process runs as when the inherited one cannot be entered.
 *
 * A real TLS connection through pg_dump and psql is proven in
 * tests/integration/database-tools-connect-over-tls.spec.ts.
 */

import { chmodSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { buildConnection } from '@/lib/services/workspace-backup'
import { connectionArgs } from '@/lib/recovery/restore'

// As root every directory can be entered, so there is no unreadable HOME to make.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const withAnUnreadableHome = isRoot ? it.skip : it

const URL = 'postgresql://backup:s3cret@db.example.test:6543/backenly?sslmode=require'
const ownHome = userInfo().homedir
const saved = { HOME: process.env.HOME, BACKUP_DATABASE_URL: process.env.BACKUP_DATABASE_URL }
let closed = ''
let open = ''

beforeAll(() => {
  closed = mkdtempSync(join(tmpdir(), 'libpq-home-closed-'))
  chmodSync(closed, 0o000)
  open = mkdtempSync(join(tmpdir(), 'libpq-home-open-'))
})

beforeEach(() => {
  process.env.BACKUP_DATABASE_URL = URL
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(() => {
  chmodSync(closed, 0o700)
  rmSync(closed, { recursive: true, force: true })
  rmSync(open, { recursive: true, force: true })
})

describe.each([
  ['buildConnection (snapshots, exports and the snapshot restore)', () => buildConnection('read')],
  ['connectionArgs (the deployment restore)', () => connectionArgs(URL)],
])('%s', (_name, connect) => {
  withAnUnreadableHome('gives the child the home of the user the process runs as when the inherited one cannot be entered', () => {
    process.env.HOME = closed
    const conn = connect()
    expect(conn.env.HOME).toBe(ownHome)
    // Nothing else about the connection changes, and this process keeps its own.
    expect(conn.env.PGPASSWORD).toBe('s3cret')
    expect(conn.env.PGSSLMODE).toBe('require')
    expect(conn.env.PATH).toBe(process.env.PATH)
    expect(conn.args).toEqual(['--host', 'db.example.test', '--port', '6543', '--username', 'backup', '--dbname', 'backenly', '--no-password'])
    expect(process.env.HOME).toBe(closed)
  })

  it('keeps a HOME the process can enter', () => {
    process.env.HOME = open
    expect(connect().env.HOME).toBe(open)
  })

  it('gives a child started with no HOME the home of the user the process runs as', () => {
    delete process.env.HOME
    expect(connect().env.HOME).toBe(ownHome)
  })
})
