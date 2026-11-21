/**
 * A PROJECT DATABASE'S LOGINS, AS THE POOLER SERVES THEM
 * ======================================================
 * Customers reach a project's own database (p_<32 hex>) only through the
 * connection pooler, which signs a login in to the server with the keys from
 * the client's own proof, and that works only while the pooler is served
 * exactly the verifier the server holds (lib/data-plane/pooler.ts,
 * tools/managed-db/regional/sql/pooler.sql). Through the application
 * (lib/services/direct-access.ts) on a real PostgreSQL 16, this pins:
 *
 *   made      a login is created inside the project's database with a verifier
 *             Backenly computed; backenly_pooler.lookup(login, database), as
 *             the pooler's own login calls it, returns exactly the server's
 *             verifier; the strings name the pooler's host on 5432 and 6543;
 *             the read-write password is shown once and never again, and the
 *             credential row keeps no password; the read-only login is the one
 *             run_query signs in with
 *   rotated   a new verifier on the server and in the pooler's row, equal; the
 *             old password no longer signs in
 *   paused    the role NOLOGIN, its sessions ended, and the lookup empty: from
 *             the role alone, and with the pooler's row turned off too
 *   resumed   the same verifier back on the server (the row keeps the
 *             verifier, not the password), so the lookup and the server agree
 *             again and the password signs in
 *   revoked   the pooler's row removed, the role gone, the lookup empty
 *   the pass  a missing row written back, a row whose role is gone removed
 *   schema    schema changes over the read-write login allowed only while the
 *             region offers the pooler
 *
 * A throwaway cluster of its own (initdb) is the data instance, because roles
 * are cluster-wide and this creates backenly_app and backenly_pooler_auth by
 * their real names. The platform database is the CI one. Password
 * authentication is scram-sha-256 for every connection.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { Client } from 'pg'

import { prisma } from '@/lib/db/prisma'
import { disconnectRegionalClients, forgetProjectDatabase } from '@/lib/data-plane/regional'
import { isScramVerifier, scramSha256Verifier } from '@/lib/data-plane/scram'
import { decryptValue } from '@/lib/security/projectEnvCrypto'
import {
  directAccessRoleNames,
  getDirectAccessStatus,
  provisionDirectAccess,
  readOnlyLogin,
  reconcilePoolerLogins,
  restorePoolerLogins,
  revokeDirectAccess,
  rotateDirectAccess,
  setSchemaChanges,
  stopPoolerLogins,
} from '@/lib/services/direct-access'
import { restoreDirectLogins, stopDirectLogins } from '@/lib/projects/paused-logins'
import { runReadQuery } from '@/lib/mcp/read-query'

jest.setTimeout(240_000)

function binDir(): string {
  if (process.env.PG_BINDIR) return process.env.PG_BINDIR
  try {
    return execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const suffix = process.platform === 'win32' ? '.exe' : ''
const haveTools = () => ['initdb', 'pg_ctl', 'psql'].every((tool) => fs.existsSync(path.join(binDir(), `${tool}${suffix}`)))
// CI installs PostgreSQL 16 and runs every case; a machine without the binaries skips the suite.
const suite = process.env.CI || haveTools() ? describe : describe.skip

const ROOT = process.cwd()
const POOLER_DB = 'backenly_pooler'
const PROJECT_DB = `p_${randomBytes(16).toString('hex')}`
const POOLER_HOST = 'ap-south-1.db.example.test'
const pw = () => randomBytes(24).toString('hex')
const SUPER_PW = pw()
const AUTH_PW = pw()

let bin = ''
let work = ''
let data = ''
let port = 0
let ownerId = ''
let projectId = ''
let schema = ''
const sessions: Client[] = []

const ENV_NAMES = ['DATA_DATABASE_URL', 'DATA_DIRECT_URL', 'POOLER_HOST', 'BACKENLY_EDITION'] as const
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

const exe = (name: string) => path.join(bin, `${name}${suffix}`)
const url = (user: string, password: string, database: string) => `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`
const superUrl = (database = 'postgres') => url('postgres', SUPER_PW, database)
const authUrl = () => url('backenly_pooler_auth', AUTH_PW, POOLER_DB)

async function rows<T = Record<string, unknown>>(connection: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connection })
  client.on('error', () => {})
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

function psqlFile(connection: string, file: string): void {
  const result = spawnSync(exe('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', connection, '-f', path.join(ROOT, file)], {
    encoding: 'utf8',
    env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
    timeout: 120_000,
  })
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stdout}${result.stderr}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

function pgCtl(args: string[]): void {
  execFileSync(exe('pg_ctl'), ['-D', data, ...args], { stdio: 'ignore', timeout: 120_000 })
}

/** What the pooler is served for a login of the project's database, as the pooler asks. */
const lookup = async (login: string) =>
  rows<{ usename: string; passwd: string }>(authUrl(), 'SELECT usename, passwd FROM backenly_pooler.lookup($1, $2)', [login, PROJECT_DB])

/** The verifier the server holds for a role, and whether it can log in. */
async function onServer(login: string): Promise<{ rolpassword: string | null; rolcanlogin: boolean } | undefined> {
  const [row] = await rows<{ rolpassword: string | null; rolcanlogin: boolean }>(
    superUrl(),
    'SELECT rolpassword, rolcanlogin FROM pg_authid WHERE rolname = $1',
    [login],
  )
  return row
}

const poolerRow = async (login: string) =>
  (await rows<{ verifier: string; database: string; active: boolean }>(superUrl(POOLER_DB), 'SELECT verifier, database, active FROM backenly_pooler.logins WHERE rolname = $1', [login]))[0]

/** A session as the login, straight to the project's database, as the pooler's server connection is. */
async function session(login: string, password: string): Promise<Client> {
  const client = new Client({ connectionString: url(login, password, PROJECT_DB) })
  client.on('error', () => {})
  await client.connect()
  sessions.push(client)
  return client
}

async function signsIn(login: string, password: string): Promise<boolean> {
  try {
    const c = await session(login, password)
    await c.query('SELECT 1')
    await c.end()
    return true
  } catch {
    return false
  }
}

const stillAlive = (client: Client) => client.query('SELECT 1').then(() => true, () => false)

suite('a project database’s logins, through the application', () => {
  let rwPassword = ''

  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
    bin = binDir()
    const version = execFileSync(exe('initdb'), ['--version'], { encoding: 'utf8' })
    if (!/\(PostgreSQL\) 16\./.test(version)) throw new Error(`This suite needs PostgreSQL 16; initdb is ${version.trim()}`)

    work = fs.mkdtempSync(path.join(os.tmpdir(), 'pooler-logins-'))
    data = path.join(work, 'data')
    const pwfile = path.join(work, 'superuser-password')
    fs.writeFileSync(pwfile, SUPER_PW)
    execFileSync(exe('initdb'), ['-D', data, '-U', 'postgres', `--pwfile=${pwfile}`, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-sync'], {
      stdio: 'ignore',
      timeout: 120_000,
    })
    port = await freePort()
    fs.appendFileSync(
      path.join(data, 'postgresql.conf'),
      [`port = ${port}`, `listen_addresses = '127.0.0.1'`, `unix_socket_directories = ''`, 'fsync = off', ''].join('\n'),
    )
    pgCtl(['-l', path.join(work, 'server.log'), '-w', '-t', '60', 'start'])

    // The pooler's database and its lookup login, as the regional procedure makes them.
    await rows(superUrl(), `CREATE ROLE backenly_app LOGIN`)
    await rows(superUrl(), `CREATE ROLE backenly_pooler_auth LOGIN NOINHERIT CONNECTION LIMIT 10 PASSWORD '${scramSha256Verifier(AUTH_PW)}'`)
    await rows(superUrl(), `CREATE DATABASE ${POOLER_DB} TEMPLATE template0`)
    psqlFile(superUrl(POOLER_DB), 'tools/managed-db/regional/sql/pooler.sql')

    // The project's own database: no CONNECT through PUBLIC, marked as holding
    // one project, the drift events table and the direct-access helpers.
    await rows(superUrl(), `CREATE DATABASE ${PROJECT_DB} TEMPLATE template0`)
    await rows(superUrl(PROJECT_DB), `REVOKE ALL ON DATABASE ${PROJECT_DB} FROM PUBLIC`)
    await rows(superUrl(PROJECT_DB), `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT 'backenly_app'::text $$`)
    psqlFile(superUrl(PROJECT_DB), 'scripts/sql/schema-drift-events.sql')
    psqlFile(superUrl(PROJECT_DB), 'scripts/sql/dedicated-database.sql')
    psqlFile(superUrl(PROJECT_DB), 'scripts/setup-direct-access.sql')

    process.env.DATA_DATABASE_URL = superUrl()
    delete process.env.DATA_DIRECT_URL
    process.env.POOLER_HOST = POOLER_HOST
    delete process.env.BACKENLY_EDITION

    ownerId = (await prisma.user.create({ data: { email: `pooler-logins-${randomUUID()}@example.test`, name: 'pooler logins' }, select: { id: true } })).id
    projectId = (
      await prisma.project.create({
        data: { name: `pooler-logins-${randomUUID()}`, userId: ownerId, databaseTenancy: 'dedicated', databaseName: PROJECT_DB } as any,
        select: { id: true },
      })
    ).id
    schema = `workspace_${projectId}`
    await rows(superUrl(PROJECT_DB), `CREATE SCHEMA "${schema}"`)
    await rows(superUrl(PROJECT_DB), `CREATE TABLE "${schema}".notes (id serial PRIMARY KEY, body text)`)
    await rows(superUrl(PROJECT_DB), `INSERT INTO "${schema}".notes (body) VALUES ('hello')`)
  })

  afterAll(async () => {
    for (const c of sessions) await c.end().catch(() => {})
    await disconnectRegionalClients().catch(() => {})
    if (projectId) {
      await prisma.databaseCredential.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
      forgetProjectDatabase(projectId)
    }
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
    try {
      if (data && fs.existsSync(data)) pgCtl(['-m', 'fast', '-w', 'stop'])
    } finally {
      if (work) fs.rmSync(work, { recursive: true, force: true })
    }
  })

  it('makes each login inside the project’s database with a verifier, and the pooler is served exactly the server’s', async () => {
    const rw = await provisionDirectAccess(projectId, 'READ_WRITE')
    const ro = await provisionDirectAccess(projectId, 'READ_ONLY')
    const names = directAccessRoleNames(projectId)
    expect([rw.roleName, ro.roleName]).toEqual([names.rw, names.ro])
    rwPassword = rw.password as string

    for (const login of [names.rw, names.ro]) {
      const server = await onServer(login)
      expect(isScramVerifier(server?.rolpassword)).toBe(true)
      expect(server?.rolcanlogin).toBe(true)
      expect(await lookup(login)).toEqual([{ usename: login, passwd: server!.rolpassword }])
      expect(await poolerRow(login)).toEqual({ verifier: server!.rolpassword, database: PROJECT_DB, active: true })
      // CONNECT on this database by name, and nowhere through PUBLIC.
      const [can] = await rows<{ here: boolean; other: boolean }>(
        superUrl(),
        `SELECT has_database_privilege($1, $2, 'CONNECT') AS here, has_database_privilege($1, '${POOLER_DB}', 'CONNECT') AS other`,
        [login, PROJECT_DB],
      )
      expect(can).toEqual({ here: true, other: false })
    }

    // The strings name the pooler: session on 5432, transaction on 6543.
    expect(rw.connectionString).toBe(`postgresql://${names.rw}:${rwPassword}@${POOLER_HOST}:5432/${PROJECT_DB}?sslmode=verify-full`)
    expect(rw.transactionConnectionString).toBe(`postgresql://${names.rw}:${rwPassword}@${POOLER_HOST}:6543/${PROJECT_DB}?sslmode=verify-full`)
    expect(rw.passwordShown).toBe('once')
    expect(await signsIn(names.rw, rwPassword)).toBe(true)

    // The credential row keeps the verifier, never the password.
    const kept = await prisma.databaseCredential.findUniqueOrThrow({ where: { projectId_mode: { projectId, mode: 'READ_WRITE' } } })
    const stored = decryptValue({ valueCipher: kept.passwordCipher, valueIv: kept.passwordIv, valueTag: kept.passwordTag })
    expect(stored).toBe((await onServer(names.rw))!.rolpassword)
    expect(stored).not.toContain(rwPassword)
  })

  it('shows the read-write password once, and the read-only one, which run_query signs in with, on every read', async () => {
    const { rw, ro } = directAccessRoleNames(projectId)
    const status = await getDirectAccessStatus(projectId)
    expect(status).toMatchObject({ available: true, tenancy: 'dedicated', pooler: { host: POOLER_HOST, sessionPort: 5432, transactionPort: 6543 } })
    const read = status.credentials.find((c) => c.mode === 'READ_WRITE')!
    expect(read.password).toBeNull()
    expect(read.connectionString).toContain(`${rw}:[YOUR-PASSWORD]@`)
    expect(JSON.stringify(status)).not.toContain(rwPassword)

    const shown = status.credentials.find((c) => c.mode === 'READ_ONLY')!
    const platform = await readOnlyLogin(projectId)
    expect(platform.roleName).toBe(ro)
    expect(shown.password).toBe(platform.password)
    expect(await signsIn(ro, platform.password)).toBe(true)
    const result = await runReadQuery(projectId, 'SELECT body FROM notes')
    expect(result.rows).toEqual([{ body: 'hello' }])
  })

  it('rotates the server’s verifier and the pooler’s together, and the old password stops signing in', async () => {
    const { rw } = directAccessRoleNames(projectId)
    const before = (await onServer(rw))!.rolpassword
    const rotated = await rotateDirectAccess(projectId, 'READ_WRITE')
    const after = (await onServer(rw))!.rolpassword
    expect(after).not.toBe(before)
    expect(await lookup(rw)).toEqual([{ usename: rw, passwd: after }])
    expect(await signsIn(rw, rwPassword)).toBe(false)
    rwPassword = rotated.password as string
    expect(rotated.connectionString).toContain(`${rw}:${rwPassword}@${POOLER_HOST}:5432/`)
    expect(await signsIn(rw, rwPassword)).toBe(true)
  })

  it('pauses: the role NOLOGIN, its sessions ended and the lookup empty, then the pooler’s row off too', async () => {
    const { rw, ro } = directAccessRoleNames(projectId)
    const open = await session(rw, rwPassword)
    await prisma.project.update({ where: { id: projectId }, data: { pausedAt: new Date() } })

    expect((await stopDirectLogins(projectId, 'paused')).sort()).toEqual([ro, rw].sort())
    expect((await onServer(rw))?.rolcanlogin).toBe(false)
    expect(await stillAlive(open)).toBe(false)
    // The role alone keeps the pooler from serving it.
    expect(await lookup(rw)).toEqual([])
    expect(await lookup(ro)).toEqual([])

    expect(await stopPoolerLogins(projectId)).toBe(2)
    expect((await poolerRow(rw))?.active).toBe(false)
    expect(await lookup(rw)).toEqual([])
    expect(await signsIn(rw, rwPassword)).toBe(false)
  })

  it('resumes with the same verifier on the server and in the pooler, so the password signs in again', async () => {
    const { rw, ro } = directAccessRoleNames(projectId)
    const kept = (await poolerRow(rw))!.verifier
    await prisma.project.update({ where: { id: projectId }, data: { pausedAt: null } })

    expect((await restoreDirectLogins(projectId, 'resumed')).sort()).toEqual([ro, rw].sort())
    await restorePoolerLogins(projectId)
    const server = (await onServer(rw))!
    expect(server).toEqual({ rolpassword: kept, rolcanlogin: true })
    expect(await lookup(rw)).toEqual([{ usename: rw, passwd: kept }])
    expect(await signsIn(rw, rwPassword)).toBe(true)
    expect(await lookup(ro)).toEqual([{ usename: ro, passwd: (await onServer(ro))!.rolpassword }])
  })

  it('allows schema changes over the read-write login only while the region offers the pooler', async () => {
    delete process.env.POOLER_HOST
    try {
      await expect(setSchemaChanges(projectId, true)).rejects.toMatchObject({
        code: 'DIRECT_ACCESS_UNAVAILABLE',
        reason: 'pooler_not_offered',
        message: expect.stringContaining("isn't offered in its region yet"),
      })
      expect((await getDirectAccessStatus(projectId)).available).toBe(false)
    } finally {
      process.env.POOLER_HOST = POOLER_HOST
    }
    expect(await setSchemaChanges(projectId, true)).toMatchObject({ schemaChanges: 'allowed' })
    expect(await setSchemaChanges(projectId, false)).toMatchObject({ schemaChanges: 'refused' })
  })

  it('the scheduled pass writes back a missing row and removes one whose role is gone', async () => {
    const { rw } = directAccessRoleNames(projectId)
    const verifier = (await onServer(rw))!.rolpassword
    await rows(superUrl(POOLER_DB), 'DELETE FROM backenly_pooler.logins WHERE rolname = $1', [rw])
    const stray = 'bkn_rw_ffffffffffff'
    await rows(superUrl(POOLER_DB), 'INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ($1, $2, $3)', [
      stray,
      scramSha256Verifier(pw()),
      PROJECT_DB,
    ])

    const pass = await reconcilePoolerLogins()
    expect(pass.regions).toBe(1)
    expect(await lookup(rw)).toEqual([{ usename: rw, passwd: verifier }])
    expect(await poolerRow(stray)).toBeUndefined()
  })

  it('revokes: the pooler’s row removed, the role gone, and the lookup empty', async () => {
    const { rw } = directAccessRoleNames(projectId)
    const open = await session(rw, rwPassword)
    await revokeDirectAccess(projectId, 'READ_WRITE')
    expect(await poolerRow(rw)).toBeUndefined()
    expect(await onServer(rw)).toBeUndefined()
    expect(await lookup(rw)).toEqual([])
    expect(await stillAlive(open)).toBe(false)
    expect(await prisma.databaseCredential.count({ where: { projectId, mode: 'READ_WRITE' } })).toBe(0)
  })
})
