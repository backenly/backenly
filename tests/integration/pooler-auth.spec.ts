/**
 * THE POOLER'S LOGINS, ON A REAL POSTGRESQL 16
 * ============================================
 * Customers connect to their project's own database through the connection
 * pooler (services/pooler). The pooler can sign a login in to the server only
 * because the server holds exactly the verifier the pooler is served, so this
 * suite proves the two halves on PostgreSQL itself:
 *
 *   - a role whose password is set to a verifier from lib/data-plane/scram.ts
 *     stores it byte for byte, and logs in with the plain password through
 *     node-postgres and through libpq (psql); a wrong password is refused;
 *   - tools/managed-db/regional/sql/pooler.sql, run by psql as an
 *     administrator that is NOT a superuser (like the RDS master), twice:
 *     lookup(login, database) answers only for an active login of that very
 *     database whose role can log in, databases() lists only existing project
 *     databases with an active login (the only names the pooler serves),
 *     backenly_pooler_auth can do nothing but call the two, backenly_app can
 *     write the logins and nothing more, and PUBLIC can do nothing at all.
 *
 * A throwaway cluster of its own (initdb), because roles are cluster-wide and
 * this creates backenly_app and backenly_pooler_auth by their real names; in
 * the shared test cluster they would collide with other suites'. Password
 * authentication is scram-sha-256 for every connection.
 *
 * scripts/test/pooler-image.sh then runs PgBouncer itself against the same
 * file, with TLS, in CI.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { Client } from 'pg'

import { isScramVerifier, scramSha256Verifier } from '@/lib/data-plane/scram'

jest.setTimeout(180_000)

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
// CI installs PostgreSQL 16 and runs every case (a skipped suite fails the job
// there); a machine without the binaries skips the suite.
const suite = process.env.CI || haveTools() ? describe : describe.skip

const ROOT = process.cwd()
const POOLER_SQL = path.join(ROOT, 'tools/managed-db/regional/sql/pooler.sql')
const ADMIN = 'pooler_admin'
const POOLER_DB = 'backenly_pooler'
const PROJECT_DB = `p_${randomBytes(16).toString('hex')}`
// Another project's database, and a project name with no database behind it.
const OTHER_DB = `p_${randomBytes(16).toString('hex')}`
const MISSING_DB = `p_${randomBytes(16).toString('hex')}`

const pw = () => randomBytes(24).toString('hex')
const SUPER_PW = pw()
const ADMIN_PW = pw()
const APP_PW = pw()
const AUTH_PW = pw()

let bin = ''
let work = ''
let data = ''
let port = 0

const exe = (name: string) => path.join(bin, `${name}${suffix}`)
const url = (user: string, password: string, database: string) =>
  `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`
const superUrl = (database = 'postgres') => url('postgres', SUPER_PW, database)
const adminUrl = (database = 'postgres') => url(ADMIN, ADMIN_PW, database)
const appUrl = () => url('backenly_app', APP_PW, POOLER_DB)
const authUrl = (database = POOLER_DB) => url('backenly_pooler_auth', AUTH_PW, database)

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

/** The error a statement (or the login before it) fails with, or null. */
async function refusal(connection: string, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  try {
    await rows(connection, sql, params)
    return null
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { code: e.code, message: e.message ?? String(err) }
  }
}

/** pooler.sql exactly as the regional procedure will run it. */
function runPoolerSql(connection: string): { status: number; output: string } {
  const result = spawnSync(exe('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', connection, '-f', POOLER_SQL], {
    encoding: 'utf8',
    env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
    timeout: 60_000,
  })
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
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

/** What pooler.sql controls, as the catalog has it. */
async function declared(): Promise<unknown> {
  const [row] = await rows<{ state: unknown }>(
    superUrl(POOLER_DB),
    `SELECT json_build_object(
       'database', (SELECT datacl::text FROM pg_database WHERE datname = current_database()),
       'schemas', (SELECT json_agg(json_build_object('s', nspname, 'owner', pg_get_userbyid(nspowner), 'acl', nspacl::text) ORDER BY nspname)
                     FROM pg_namespace WHERE nspname IN ('public', 'backenly_pooler')),
       'table', (SELECT json_build_object('owner', pg_get_userbyid(relowner), 'acl', relacl::text)
                   FROM pg_class WHERE oid = 'backenly_pooler.logins'::regclass),
       'checks', (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname)
                    FROM pg_constraint WHERE conrelid = 'backenly_pooler.logins'::regclass),
       'functions', (SELECT json_agg(json_build_object('f', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner),
                       'acl', p.proacl::text, 'definer', p.prosecdef, 'config', p.proconfig, 'src', md5(p.prosrc)))
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'backenly_pooler')
     ) AS state`,
  )
  return row.state
}

/** A customer login on the server, with a verifier from scram.ts. */
async function createLogin(name: string, password: string, extra = '', database = PROJECT_DB): Promise<string> {
  const verifier = scramSha256Verifier(password)
  await rows(adminUrl(), `CREATE ROLE ${name} LOGIN ${extra} PASSWORD '${verifier}'`)
  await rows(adminUrl(), `GRANT CONNECT ON DATABASE ${database} TO ${name}`)
  return verifier
}

const login = (name: string) => `bkn_${name}_${randomBytes(4).toString('hex')}`

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  bin = binDir()
  const version = execFileSync(exe('initdb'), ['--version'], { encoding: 'utf8' })
  if (!/\(PostgreSQL\) 16\./.test(version)) throw new Error(`This suite needs PostgreSQL 16; initdb is ${version.trim()}`)

  work = fs.mkdtempSync(path.join(os.tmpdir(), 'pooler-auth-'))
  data = path.join(work, 'data')
  const pwfile = path.join(work, 'superuser-password')
  fs.writeFileSync(pwfile, SUPER_PW)
  execFileSync(
    exe('initdb'),
    ['-D', data, '-U', 'postgres', `--pwfile=${pwfile}`, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-sync'],
    { stdio: 'ignore', timeout: 120_000 },
  )
  port = await freePort()
  fs.appendFileSync(
    path.join(data, 'postgresql.conf'),
    [`port = ${port}`, `listen_addresses = '127.0.0.1'`, `unix_socket_directories = ''`, 'fsync = off', ''].join('\n'),
  )
  pgCtl(['-l', path.join(work, 'server.log'), '-w', '-t', '60', 'start'])

  // An administrator like the RDS master: creates roles and databases, owns
  // what it creates, and is not a superuser.
  await rows(superUrl(), `CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB PASSWORD '${ADMIN_PW}'`)
  await rows(adminUrl(), `CREATE ROLE backenly_app LOGIN PASSWORD '${scramSha256Verifier(APP_PW)}'`)
  await rows(adminUrl(), `CREATE ROLE backenly_pooler_auth LOGIN NOINHERIT PASSWORD '${scramSha256Verifier(AUTH_PW)}'`)
  await rows(adminUrl(), `CREATE DATABASE ${POOLER_DB}`)
  for (const db of [PROJECT_DB, OTHER_DB]) {
    await rows(adminUrl(), `CREATE DATABASE ${db}`)
    await rows(adminUrl(db), `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`)
  }
})

afterAll(() => {
  try {
    if (data && fs.existsSync(data)) pgCtl(['-m', 'fast', '-w', 'stop'])
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
})

suite('a login whose verifier Backenly computed', () => {
  it('is stored byte for byte, and signs in with the plain password', async () => {
    const name = login('direct')
    const password = pw()
    const verifier = await createLogin(name, password)
    expect(isScramVerifier(verifier)).toBe(true)

    const [stored] = await rows<{ rolpassword: string }>(superUrl(), `SELECT rolpassword FROM pg_authid WHERE rolname = $1`, [name])
    expect(stored.rolpassword).toBe(verifier)

    expect(await rows(url(name, password, PROJECT_DB), 'SELECT current_user AS me, current_database() AS db')).toEqual([
      { me: name, db: PROJECT_DB },
    ])

    // libpq too (psql), which SASLpreps the password before hashing it.
    const psql = spawnSync(exe('psql'), ['-X', '-tA', '-d', `host=127.0.0.1 port=${port} dbname=${PROJECT_DB} user=${name}`, '-c', 'SELECT current_user'], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' },
      timeout: 30_000,
    })
    expect(psql.stderr).toBe('')
    expect(psql.stdout.trim()).toBe(name)
  })

  it('refuses a wrong password, so the logins above were really checked', async () => {
    const name = login('wrong')
    await createLogin(name, pw())
    const refused = await refusal(url(name, pw(), PROJECT_DB), 'SELECT 1')
    expect(refused?.code).toBe('28P01')
    expect(refused?.message).toMatch(/password authentication failed/)
  })

  it('keeps each verifier’s own salt, so two logins with one password do not share a verifier', async () => {
    const password = pw()
    const a = login('salt_a')
    const b = login('salt_b')
    const va = await createLogin(a, password)
    const vb = await createLogin(b, password)
    expect(va).not.toBe(vb)
    for (const name of [a, b]) {
      expect(await rows(url(name, password, PROJECT_DB), 'SELECT current_user AS me')).toEqual([{ me: name }])
    }
  })
})

suite('pooler.sql', () => {
  it('refuses to run anywhere but backenly_pooler', () => {
    const result = runPoolerSql(adminUrl('postgres'))
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('refusing: pooler.sql belongs in database backenly_pooler, not postgres')
  })

  it('refuses a lookup role that holds another role, and changes nothing', async () => {
    await rows(adminUrl(), `GRANT backenly_app TO backenly_pooler_auth`)
    try {
      const result = runPoolerSql(adminUrl(POOLER_DB))
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('refusing: backenly_pooler_auth is a member of backenly_app; it may hold no role')
      expect(await rows(superUrl(POOLER_DB), `SELECT 1 FROM pg_namespace WHERE nspname = 'backenly_pooler'`)).toEqual([])
    } finally {
      await rows(adminUrl(), `REVOKE backenly_app FROM backenly_pooler_auth`)
    }
  })

  it('runs as an administrator that is not a superuser, and again without changing anything', async () => {
    const first = runPoolerSql(adminUrl(POOLER_DB))
    expect(first.output).toContain('backenly_pooler: logins table, lookup, databases and privileges as declared')
    expect(first.status).toBe(0)
    const before = await declared()

    const again = runPoolerSql(adminUrl(POOLER_DB))
    expect(again.status).toBe(0)
    expect(await declared()).toEqual(before)

    const owners = await rows<{ fn: string; owner: string }>(
      superUrl(POOLER_DB),
      `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'backenly_pooler' ORDER BY 1`,
    )
    expect(owners).toEqual([
      { fn: 'backenly_pooler.databases()', owner: ADMIN },
      { fn: 'backenly_pooler.lookup(text,text)', owner: ADMIN },
    ])
  })

  describe('the lookup and the list PgBouncer reads as backenly_pooler_auth', () => {
    const lookup = (name: string, database: string | null = PROJECT_DB) =>
      rows<{ usename: string; passwd: string }>(authUrl(), 'SELECT usename, passwd FROM backenly_pooler.lookup($1, $2)', [
        name,
        database,
      ])
    const listed = async () =>
      (await rows<{ d: string }>(authUrl(), 'SELECT database AS d FROM backenly_pooler.databases() ORDER BY 1')).map((r) => r.d)

    it('answers with the verifier of an active login whose role can log in, and nothing else', async () => {
      const active = login('active')
      const inactive = login('inactive')
      const nologin = login('nologin')
      const expired = login('expired')
      const missing = login('missing')
      const verifiers: Record<string, string> = {
        [active]: await createLogin(active, pw()),
        [inactive]: await createLogin(inactive, pw()),
        [nologin]: await createLogin(nologin, pw()),
        [expired]: await createLogin(expired, pw(), `VALID UNTIL '2000-01-01'`),
        [missing]: scramSha256Verifier(pw()),
      }
      await rows(adminUrl(), `ALTER ROLE ${nologin} NOLOGIN`)
      for (const [name, verifier] of Object.entries(verifiers)) {
        await rows(appUrl(), `INSERT INTO backenly_pooler.logins (rolname, verifier, database, active) VALUES ($1, $2, $3, $4)`, [
          name,
          verifier,
          PROJECT_DB,
          name !== inactive,
        ])
      }

      expect(await lookup(active)).toEqual([{ usename: active, passwd: verifiers[active] }])
      for (const name of [inactive, nologin, expired, missing]) expect([name, await lookup(name)]).toEqual([name, []])

      // Only for its own database: not another project's, not any other
      // database, and not for no database (the pooler's query for every name
      // that is not a listed project database).
      for (const database of [OTHER_DB, MISSING_DB, 'postgres', 'template1', POOLER_DB, '', null]) {
        expect([database, await lookup(active, database)]).toEqual([database, []])
      }

      // Roles that are not customer logins have no row, whatever they are.
      for (const name of ['backenly_app', 'backenly_pooler_auth', 'postgres', ADMIN, '']) {
        expect([name, await lookup(name)]).toEqual([name, []])
      }

      // Compared as text: a longer name is not cut to 63 bytes to match.
      expect(await lookup(`${active}${'x'.repeat(64)}`)).toEqual([])
      expect(await lookup(active, `${PROJECT_DB}${'x'.repeat(64)}`)).toEqual([])

      // Turned off, it stops answering at once; on again, it answers.
      await rows(appUrl(), `UPDATE backenly_pooler.logins SET active = false, updated_at = now() WHERE rolname = $1`, [active])
      expect(await lookup(active)).toEqual([])
      await rows(appUrl(), `UPDATE backenly_pooler.logins SET active = true, updated_at = now() WHERE rolname = $1`, [active])
      expect(await lookup(active)).toHaveLength(1)
    })

    it('lists exactly the existing project databases that have an active login', async () => {
      // PROJECT_DB has active logins from the case above.
      expect(await listed()).toEqual([PROJECT_DB])

      // A login for a database that does not exist puts nothing on the list.
      const nowhere = login('nowhere')
      await rows(appUrl(), `INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ($1, $2, $3)`, [
        nowhere,
        scramSha256Verifier(pw()),
        MISSING_DB,
      ])
      expect(await listed()).toEqual([PROJECT_DB])

      // Another project's database is listed while it has an active login, and
      // leaves the list when its last one is turned off.
      const other = login('other')
      await rows(appUrl(), `INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ($1, $2, $3)`, [
        other,
        await createLogin(other, pw(), '', OTHER_DB),
        OTHER_DB,
      ])
      expect(await listed()).toEqual([PROJECT_DB, OTHER_DB].sort())

      // Its pool size is the smallest connection limit among its active logins,
      // and none while every login is unlimited.
      const poolSize = async (database: string) =>
        (await rows<{ pool_size: number | null }>(authUrl(), 'SELECT pool_size FROM backenly_pooler.databases() WHERE database = $1', [
          database,
        ]))[0]?.pool_size
      expect(await poolSize(OTHER_DB)).toBeNull()
      await rows(adminUrl(), `ALTER ROLE ${other} CONNECTION LIMIT 2`)
      expect(await poolSize(OTHER_DB)).toBe(2)

      await rows(appUrl(), `UPDATE backenly_pooler.logins SET active = false, updated_at = now() WHERE rolname = $1`, [other])
      expect(await listed()).toEqual([PROJECT_DB])
    })

    it('is all backenly_pooler_auth can do', async () => {
      for (const sql of [
        'SELECT * FROM backenly_pooler.logins',
        `INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ('bkn_x', 'x', 'x')`,
        'CREATE TABLE backenly_pooler.t (id int)',
        'CREATE TABLE public.t (id int)',
        'CREATE TEMP TABLE t (id int)',
        'CREATE SCHEMA s',
      ]) {
        const refused = await refusal(authUrl(), sql)
        expect([sql, refused?.code]).toEqual([sql, '42501'])
      }
      // Not a connection to the project's database either.
      expect((await refusal(authUrl(PROJECT_DB), 'SELECT 1'))?.code).toBe('42501')
    })
  })

  describe('backenly_app', () => {
    it('writes the logins, and nothing more', async () => {
      const name = login('app')
      const verifier = scramSha256Verifier(pw())
      await rows(appUrl(), `INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ($1, $2, $3)`, [name, verifier, PROJECT_DB])
      expect(await rows(appUrl(), `SELECT rolname, verifier, database, active FROM backenly_pooler.logins WHERE rolname = $1`, [name])).toEqual([
        { rolname: name, verifier, database: PROJECT_DB, active: true },
      ])
      await rows(appUrl(), `UPDATE backenly_pooler.logins SET verifier = $2, updated_at = now() WHERE rolname = $1`, [name, scramSha256Verifier(pw())])
      await rows(appUrl(), `DELETE FROM backenly_pooler.logins WHERE rolname = $1`, [name])

      for (const sql of [
        'TRUNCATE backenly_pooler.logins',
        `SELECT * FROM backenly_pooler.lookup('x', 'y')`,
        'SELECT * FROM backenly_pooler.databases()',
        'CREATE TABLE backenly_pooler.t (id int)',
        'CREATE TABLE public.t (id int)',
        'CREATE TEMP TABLE t (id int)',
      ]) {
        expect([sql, (await refusal(appUrl(), sql))?.code]).toEqual([sql, '42501'])
      }
    })

    it('can store only a customer login, a verifier as scram.ts writes it, and a project database', async () => {
      const good = { rolname: login('shape'), verifier: scramSha256Verifier(pw()), database: PROJECT_DB }
      const insert = (row: typeof good) =>
        refusal(appUrl(), `INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ($1, $2, $3)`, [
          row.rolname,
          row.verifier,
          row.database,
        ])
      for (const bad of [
        { ...good, rolname: 'backenly_app' },
        { ...good, rolname: 'postgres' },
        { ...good, rolname: 'BKN_UPPER' },
        { ...good, rolname: `bkn_${'a'.repeat(60)}` },
        { ...good, verifier: 'a-plain-password' },
        { ...good, verifier: 'md5cd3578025fe2c3d7ed1b9a9b26238b70' },
        { ...good, verifier: scramSha256Verifier(pw(), { iterations: 8192 }) },
        { ...good, verifier: `${good.verifier} ` },
        { ...good, database: 'postgres' },
        { ...good, database: POOLER_DB },
        { ...good, database: 'p_XYZ' },
      ]) {
        expect([bad, (await insert(bad))?.code]).toEqual([bad, '23514'])
      }
      expect(await insert(good)).toBeNull()
    })
  })

  it('leaves PUBLIC nothing: an ordinary role cannot even connect', async () => {
    const name = `nobody_${randomBytes(4).toString('hex')}`
    const password = pw()
    await rows(adminUrl(), `CREATE ROLE ${name} LOGIN PASSWORD '${scramSha256Verifier(password)}'`)
    const refused = await refusal(url(name, password, POOLER_DB), 'SELECT 1')
    expect(refused?.code).toBe('42501')
    expect(refused?.message).toMatch(/permission denied for database "backenly_pooler"/)

    const [publicHas] = await rows<Record<string, boolean>>(
      superUrl(POOLER_DB),
      `SELECT has_database_privilege('public', current_database(), 'CONNECT, TEMPORARY, CREATE') AS database,
              has_schema_privilege('public', 'public', 'USAGE, CREATE') AS public_schema,
              has_schema_privilege('public', 'backenly_pooler', 'USAGE, CREATE') AS pooler_schema,
              has_table_privilege('public', 'backenly_pooler.logins', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS logins,
              has_function_privilege('public', 'backenly_pooler.lookup(text, text)', 'EXECUTE') AS lookup,
              has_function_privilege('public', 'backenly_pooler.databases()', 'EXECUTE') AS databases`,
    )
    expect(publicHas).toEqual({
      database: false,
      public_schema: false,
      pooler_schema: false,
      logins: false,
      lookup: false,
      databases: false,
    })
  })
})
