/**
 * DIRECT POSTGRES THROUGH THE CONNECTION POOLER: WHERE A LOGIN CONNECTS, AND
 * WHAT IS REFUSED BEFORE ANYTHING IS SENT
 * ==========================================================================
 *
 * lib/services/direct-access.ts decides where a project's logins connect from
 * the project's placement and the environment, and lib/data-plane/pooler.ts
 * keeps the pooler's row for each login of a project's own database. Without
 * a database, this pins:
 *
 *   - a project's own database is reached through its region's pooler, named
 *     by POOLER_HOST (home) or POOLER_HOST_<REGION>: a session string on 5432
 *     and a transaction string on 6543, both sslmode=verify-full, and the psql
 *     and pg_dump commands with sslrootcert=system; without the setting there
 *     is no string, and the refusal names the setting;
 *   - a shared database keeps the host its operator gives (a self-hosted
 *     deployment); on Backenly Cloud, where none is given, the refusal says a
 *     shared database is not reached from outside;
 *   - a password that is not shown reads [YOUR-PASSWORD];
 *   - the pooler's database is reached on the region's data instance as
 *     backenly_pooler, and nothing else's connection string is used;
 *   - a row the pooler's table would refuse is refused here first, without
 *     connecting, and no error or log line carries a verifier.
 */

import { randomBytes } from 'crypto'
import {
  credentialStrings,
  DIRECT_ACCESS_UNAVAILABLE_MESSAGES,
  directConnectionTarget,
  PASSWORD_PLACEHOLDER,
  POOLER_GUIDANCE,
} from '@/lib/services/direct-access'
import {
  ensurePoolerLogins,
  POOLER_DATABASE,
  poolerDatabaseUrl,
  poolerEndpoint,
  PoolerLoginsError,
  putPoolerLogin,
} from '@/lib/data-plane/pooler'
import { scramSha256Verifier } from '@/lib/data-plane/scram'
import type { ProjectDatabase } from '@/lib/data-plane/regional'

const DB = 'p_0123456789abcdef0123456789abcdef'
const own = (region: ProjectDatabase['region'] = 'ap-south-1'): ProjectDatabase => ({
  region,
  tenancy: 'dedicated',
  database: DB,
  instance: 'primary',
  epoch: 0,
})
const shared = (region: ProjectDatabase['region'] = 'ap-south-1'): ProjectDatabase => ({
  region,
  tenancy: 'shared',
  database: null,
  instance: null,
  epoch: 0,
})
const PRODUCTION = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://app:x@platform.internal:5432/backenly' }
/** A stand-in password, interpolated wherever it sits in a connection string. */
const PW = 'not-a-real-password'

describe('a project with a database of its own', () => {
  it('connects through its region’s pooler: session on 5432, transaction on 6543, verify-full', () => {
    const target = directConnectionTarget(own(), { ...PRODUCTION, POOLER_HOST: 'ap-south-1.db.backenly.com' })
    expect(target).toEqual({ kind: 'pooler', host: 'ap-south-1.db.backenly.com', sessionPort: 5432, transactionPort: 6543, database: DB })

    const s = credentialStrings(target, 'bkn_rw_0123456789ab', PW, 'workspace_p1')
    expect(s.connectionString).toBe(`postgresql://bkn_rw_0123456789ab:${PW}@ap-south-1.db.backenly.com:5432/${DB}?sslmode=verify-full`)
    expect(s.transactionConnectionString).toBe(`postgresql://bkn_rw_0123456789ab:${PW}@ap-south-1.db.backenly.com:6543/${DB}?sslmode=verify-full`)
    expect(s).toMatchObject({ host: 'ap-south-1.db.backenly.com', port: 5432, transactionPort: 6543, database: DB })
    // psql and pg_dump on the session port, with the system's trusted roots; the strings without.
    expect(s.psqlCommand).toBe(`psql "${s.connectionString}&sslrootcert=system"`)
    expect(s.pgDumpCommand.startsWith(`pg_dump "${s.connectionString}&sslrootcert=system" --schema="workspace_p1" --enable-row-security`)).toBe(true)
    expect(s.connectionString).not.toContain('sslrootcert')
  })

  it('reads the setting of the project’s own region, never the home one', () => {
    const env = { ...PRODUCTION, POOLER_HOST: 'ap-south-1.db.backenly.com', POOLER_HOST_US_EAST_1: 'us-east-1.staging.db.backenly.com' }
    expect(directConnectionTarget(own('us-east-1'), env)).toMatchObject({ host: 'us-east-1.staging.db.backenly.com' })
    expect(() => directConnectionTarget(own('eu-central-1'), env)).toThrow(
      expect.objectContaining({ code: 'DIRECT_ACCESS_UNAVAILABLE', reason: 'pooler_not_offered', variable: 'POOLER_HOST_EU_CENTRAL_1' }),
    )
  })

  it('has no string where its region does not offer the pooler, and says so', () => {
    for (const env of [PRODUCTION, { ...PRODUCTION, NODE_ENV: 'test' }, { ...PRODUCTION, DIRECT_DB_HOST: 'db.example.test' }]) {
      let refused: any
      try {
        directConnectionTarget(own(), env)
      } catch (err) {
        refused = err
      }
      expect(refused).toMatchObject({ code: 'DIRECT_ACCESS_UNAVAILABLE', reason: 'pooler_not_offered', variable: 'POOLER_HOST' })
      expect(refused.message).toBe(DIRECT_ACCESS_UNAVAILABLE_MESSAGES.pooler_not_offered)
    }
  })

  it('treats a pooler setting that is not a host name as unset', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(poolerEndpoint('ap-south-1', { POOLER_HOST: 'https://ap-south-1.db.backenly.com:5432' })).toBeNull()
    expect(poolerEndpoint('ap-south-1', { POOLER_HOST: '  ' })).toBeNull()
    expect(poolerEndpoint('ap-south-1', { POOLER_HOST: 'AP-SOUTH-1.DB.BACKENLY.COM' })).toEqual({
      host: 'ap-south-1.db.backenly.com',
      sessionPort: 5432,
      transactionPort: 6543,
    })
    warn.mockRestore()
  })

  it('puts [YOUR-PASSWORD] where the password is not shown', () => {
    const target = directConnectionTarget(own(), { POOLER_HOST: 'ap-south-1.db.backenly.com' })
    const s = credentialStrings(target, 'bkn_rw_0123456789ab', null, 'workspace_p1')
    expect(PASSWORD_PLACEHOLDER).toBe('[YOUR-PASSWORD]')
    expect(s.connectionString).toContain(':[YOUR-PASSWORD]@')
    expect(s.transactionConnectionString).toContain(':[YOUR-PASSWORD]@')
  })

  it('says which port is for what, Prisma included', () => {
    expect(POOLER_GUIDANCE.join(' ')).toMatch(/5432 is session pooling: use it for migrations/)
    expect(POOLER_GUIDANCE.join(' ')).toMatch(/6543 is transaction pooling: use it for application traffic and serverless/)
    expect(POOLER_GUIDANCE.join(' ')).toContain('Prisma: the application on 6543 (url) and Prisma Migrate on 5432 (directUrl).')
  })
})

describe('a project in its region’s shared database', () => {
  it('keeps the host its operator gives, as a self-hosted deployment does', () => {
    const target = directConnectionTarget(shared(), { ...PRODUCTION, DIRECT_DB_HOST: 'db.example.test', POOLER_HOST: 'ap-south-1.db.backenly.com' })
    expect(target).toEqual({ kind: 'direct', host: 'db.example.test', port: 5432, database: 'backenly', sslmode: 'require' })
    const s = credentialStrings(target, 'bkn_ro_0123456789ab', PW, 'workspace_p1')
    expect(s.connectionString).toBe(`postgresql://bkn_ro_0123456789ab:${PW}@db.example.test:5432/backenly?sslmode=require`)
    expect(s.transactionConnectionString).toBeUndefined()
    expect(s.psqlCommand).toBe(`psql "${s.connectionString}"`)
  })

  it('keeps localhost outside production in the home region', () => {
    expect(directConnectionTarget(shared(), { NODE_ENV: 'test' })).toMatchObject({ kind: 'direct', host: 'localhost', sslmode: 'prefer' })
  })

  it('has no string on Backenly Cloud, which gives no host, and says a shared database is not reached from outside', () => {
    let refused: any
    try {
      directConnectionTarget(shared(), { ...PRODUCTION, BACKENLY_EDITION: 'cloud', POOLER_HOST: 'ap-south-1.db.backenly.com' })
    } catch (err) {
      refused = err
    }
    expect(refused).toMatchObject({ code: 'DIRECT_ACCESS_UNAVAILABLE', reason: 'shared_database', variable: 'DIRECT_DB_HOST' })
    expect(refused.message).toBe(DIRECT_ACCESS_UNAVAILABLE_MESSAGES.shared_database)
  })

  it('says only that nothing outside can reach it on a self-hosted deployment with no host', () => {
    expect(() => directConnectionTarget(shared('us-east-1'), PRODUCTION)).toThrow(
      expect.objectContaining({ reason: 'no_host', variable: 'DIRECT_DB_HOST_US_EAST_1', message: DIRECT_ACCESS_UNAVAILABLE_MESSAGES.no_host }),
    )
  })
})

describe('the pooler’s database', () => {
  it('is backenly_pooler on the region’s data instance', () => {
    expect(POOLER_DATABASE).toBe('backenly_pooler')
    expect(poolerDatabaseUrl('ap-south-1', { DATA_DATABASE_URL: 'postgresql://backenly_app:pw@data.internal:5432/postgres?sslmode=verify-full' })).toBe(
      'postgresql://backenly_app:pw@data.internal:5432/backenly_pooler?sslmode=verify-full',
    )
    // Outside the home region the region's own instance is its data instance.
    expect(poolerDatabaseUrl('us-east-1', { DATABASE_URL_US_EAST_1: 'postgresql://backenly_app:pw@east.internal:5432/backenly' })).toBe(
      'postgresql://backenly_app:pw@east.internal:5432/backenly_pooler',
    )
  })

  it('is never the platform database, and refuses what it cannot build, without quoting the URL', () => {
    expect(() => poolerDatabaseUrl('ap-south-1', { DATABASE_URL: 'postgresql://app:pw@platform.internal:5432/backenly' })).toThrow(
      expect.objectContaining({ code: 'REGION_NOT_CONFIGURED' }),
    )
    for (const url of ['not a url', `mysql://app:${PW}@data.internal/db`, `postgresql://app:${PW}@data.internal/db?dbname=other`]) {
      let refused: any
      try {
        poolerDatabaseUrl('ap-south-1', { DATA_DATABASE_URL: url })
      } catch (err) {
        refused = err
      }
      expect(refused).toBeInstanceOf(PoolerLoginsError)
      expect(refused.message).not.toContain(PW)
    }
  })
})

describe('a row the pooler’s table would refuse', () => {
  // An address nothing listens on: a check that connected would fail on it, not on the row.
  const ENV = { DATA_DATABASE_URL: 'postgresql://backenly_app:pw@127.0.0.1:1/postgres' }
  const good = () => ({ rolname: 'bkn_rw_0123456789ab', verifier: scramSha256Verifier(randomBytes(24).toString('base64url')), database: DB, active: true })
  let saved: NodeJS.ProcessEnv

  beforeEach(() => {
    saved = process.env
    process.env = { ...process.env, ...ENV }
  })
  afterEach(() => {
    process.env = saved
  })

  it.each([
    ['a name that is not a customer login’s', { rolname: 'backenly_app' }, /is not a customer login's name/],
    ['a password where the verifier goes', { verifier: 'not-a-verifier-but-a-password' }, /is not a SCRAM-SHA-256 verifier of 4096 iterations/],
    [
      'a verifier of other iterations',
      { verifier: scramSha256Verifier(PW, { iterations: 8192 }) },
      /is not a SCRAM-SHA-256 verifier of 4096 iterations/,
    ],
    ['a database that is not a project’s own', { database: 'backenly_pooler' }, /is not a project database's name/],
  ])('refuses %s before connecting, and says nothing of the values', async (_label, change, message) => {
    const row = { ...good(), ...change }
    let refused: any
    try {
      await putPoolerLogin('ap-south-1', row)
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(PoolerLoginsError)
    expect(refused.message).toMatch(message)
    expect(refused.code).toBeUndefined()
    expect(refused.message).not.toContain(row.verifier)
    await expect(ensurePoolerLogins('ap-south-1', [row])).rejects.toBeInstanceOf(PoolerLoginsError)
  })

  it('reports a failed write by its code only: no error and no log line carries the verifier', async () => {
    const said: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(' '))
      }),
    )
    const row = good()
    let refused: any
    try {
      await putPoolerLogin('ap-south-1', row)
    } catch (err) {
      refused = err
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(refused).toBeInstanceOf(PoolerLoginsError)
    expect(refused.message).toMatch(/^The pooler's logins could not be written \(ECONNREFUSED\)\.$/)
    const everything = [refused.message, refused.stack ?? '', ...said].join('\n')
    expect(everything).not.toContain(row.verifier)
    expect(everything).not.toContain(row.verifier.split('$')[2])
  })
})
