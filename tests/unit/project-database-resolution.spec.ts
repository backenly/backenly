/**
 * Where a project's data lives when the project has a database of its own.
 *
 * Pure rules, with an injected environment and stand-in clients, so this runs
 * without a database: the variable names of a region's data instance, the
 * refusal to open a project's own database on the home region's platform
 * database, never falling back to another region or instance, the names
 * withDatabase accepts, the epoch cache that never answers with an older
 * epoch than it was told about, and the bounded client registry that never
 * closes a pinned or busy client. The database-backed half is
 * tests/integration/project-database-resolution.spec.ts.
 */
import {
  DatabaseBusyError,
  PRIMARY_DATA_INSTANCE,
  ProjectDatabaseNameError,
  RegionNotConfiguredError,
  UnknownProjectDatabaseError,
  UnknownRegionError,
  databaseClient,
  databaseClientUrl,
  databaseOfRecord,
  dataInstanceEnvName,
  isProjectDatabaseName,
  isRegionError,
  regionDataInstanceUrl,
  regionEnvName,
  requireRegionDataInstanceUrl,
  unlessRegionError,
  withDatabase,
  type DataPlaneRole,
} from '@/lib/data-plane/regional'
import { DatabaseRegistry, type UseTracker } from '@/lib/data-plane/database-registry'
import { EpochBehindError, EpochCache } from '@/lib/data-plane/epoch-cache'
import { CLOUD_REGIONS, HOME_REGION } from '@/lib/regions'

const ROLES: DataPlaneRole[] = ['app', 'direct', 'backup', 'admin']
const DB = `p_${'0123456789abcdef'.repeat(2)}`
const OTHER_DB = `p_${'fedcba9876543210'.repeat(2)}`

const ENV = {
  DATABASE_URL: 'postgresql://platform:platform-secret@home.example.test:5432/platform',
  DATA_DATABASE_URL: 'postgresql://app:home-data-secret@data.home.example.test:5432/postgres?sslmode=require',
  DATABASE_URL_US_EAST_1: 'postgresql://app:virginia-secret@virginia.example.test:5432/region',
  DIRECT_URL_US_EAST_1: 'postgresql://app:virginia-secret@virginia-direct.example.test:5432/region',
  DATA_DATABASE_URL_EU_CENTRAL_1: 'postgresql://app:frankfurt-secret@data.frankfurt.example.test:5432/postgres',
  DATABASE_URL_EU_CENTRAL_1: 'postgresql://app:frankfurt-secret@frankfurt.example.test:5432/region',
  DATA_DATABASE_URL_US_WEST_2: '   ',
}

describe('the data instance variables', () => {
  it('put DATA_ before each role’s own variable, and keep the home region’s unsuffixed', () => {
    expect(ROLES.map((role) => dataInstanceEnvName(HOME_REGION, role))).toEqual([
      'DATA_DATABASE_URL',
      'DATA_DIRECT_URL',
      'DATA_BACKUP_DATABASE_URL',
      'DATA_BACKENLY_ADMIN_DATABASE_URL',
    ])
    expect(dataInstanceEnvName('us-east-1')).toBe('DATA_DATABASE_URL_US_EAST_1')
    expect(dataInstanceEnvName('eu-central-1', 'direct')).toBe('DATA_DIRECT_URL_EU_CENTRAL_1')
    expect(dataInstanceEnvName('ap-southeast-1', 'backup')).toBe('DATA_BACKUP_DATABASE_URL_AP_SOUTHEAST_1')
  })

  it('give every region and role a variable of its own, none shared with a region’s own', () => {
    const data = CLOUD_REGIONS.flatMap((region) => ROLES.map((role) => dataInstanceEnvName(region.id, role)))
    const own = CLOUD_REGIONS.flatMap((region) => ROLES.map((role) => regionEnvName(region.id, role)))
    expect(new Set([...data, ...own]).size).toBe(data.length + own.length)
  })
})

describe('regionDataInstanceUrl', () => {
  it('reads the home region’s data instance, and never the platform database in its place', () => {
    expect(regionDataInstanceUrl(HOME_REGION, 'app', ENV)).toBe(ENV.DATA_DATABASE_URL)
    expect(regionDataInstanceUrl(HOME_REGION, 'app', { DATABASE_URL: ENV.DATABASE_URL })).toBeUndefined()
    expect(regionDataInstanceUrl(HOME_REGION, 'direct', ENV)).toBeUndefined()
  })

  it('uses a region’s own connection for the role when the region names no data instance', () => {
    expect(regionDataInstanceUrl('us-east-1', 'app', ENV)).toBe(ENV.DATABASE_URL_US_EAST_1)
    expect(regionDataInstanceUrl('us-east-1', 'direct', ENV)).toBe(ENV.DIRECT_URL_US_EAST_1)
    expect(regionDataInstanceUrl('us-east-1', 'backup', ENV)).toBeUndefined()
  })

  it('prefers the region’s data instance when it names one', () => {
    expect(regionDataInstanceUrl('eu-central-1', 'app', ENV)).toBe(ENV.DATA_DATABASE_URL_EU_CENTRAL_1)
  })

  it('never answers with another region’s data instance or the home one', () => {
    expect(regionDataInstanceUrl('ap-southeast-1', 'app', ENV)).toBeUndefined()
    expect(regionDataInstanceUrl('us-west-2', 'app', ENV)).toBeUndefined()
  })
})

describe('requireRegionDataInstanceUrl', () => {
  const thrown = (fn: () => unknown): RegionNotConfiguredError => {
    try {
      fn()
    } catch (err) {
      return err as RegionNotConfiguredError
    }
    throw new Error('nothing was thrown')
  }

  it('refuses a home project’s own database without DATA_DATABASE_URL, naming it and nothing else', () => {
    const error = thrown(() => requireRegionDataInstanceUrl(HOME_REGION, 'app', { env: { DATABASE_URL: ENV.DATABASE_URL }, projectId: 'p-home' }))
    expect(error).toBeInstanceOf(RegionNotConfiguredError)
    expect(error.code).toBe('REGION_NOT_CONFIGURED')
    expect(error.variable).toBe('DATA_DATABASE_URL')
    expect(error.message).toContain('DATA_DATABASE_URL')
    expect(error.message).toContain('p-home')
    expect(error.message).toContain('platform database')
    expect(error.message).not.toContain('postgresql://')
    expect(error.message).not.toContain('platform-secret')
    expect(isRegionError(error)).toBe(true)
  })

  it('names the region’s own variable elsewhere, and the data one beside it', () => {
    const error = thrown(() => requireRegionDataInstanceUrl('ap-southeast-1', 'direct', { env: ENV, projectId: 'p-sg' }))
    expect(error.variable).toBe('DIRECT_URL_AP_SOUTHEAST_1')
    expect(error.message).toContain('DATA_DIRECT_URL_AP_SOUTHEAST_1')
    expect(error.message).not.toContain('postgresql://')
  })

  it('returns the configured connection', () => {
    expect(requireRegionDataInstanceUrl('us-east-1', 'app', { env: ENV })).toBe(ENV.DATABASE_URL_US_EAST_1)
  })
})

describe('withDatabase', () => {
  it('replaces only the database, keeping credentials, host, port and parameters', () => {
    const url = new URL(withDatabase(ENV.DATA_DATABASE_URL, DB))
    expect(url.pathname).toBe(`/${DB}`)
    expect(url.username).toBe('app')
    expect(url.password).toBe('home-data-secret')
    expect(url.host).toBe('data.home.example.test:5432')
    expect(url.searchParams.get('sslmode')).toBe('require')
    expect(withDatabase('postgres://u:p@h/', DB)).toBe(`postgres://u:p@h/${DB}`)
    expect(withDatabase('postgresql://u:p@h:6543', DB)).toBe(`postgresql://u:p@h:6543/${DB}`)
  })

  it.each([
    ['the platform database', 'platform'],
    ['an empty name', ''],
    ['upper-case hex', `p_${'0123456789ABCDEF'.repeat(2)}`],
    ['one digit short', DB.slice(0, -1)],
    ['one digit long', `${DB}0`],
    ['a path', `${DB}/../platform`],
    ['quoting', `${DB}";DROP DATABASE x;--`],
    ['a query string', `${DB}?dbname=platform`],
    ['another prefix', `x_${DB.slice(2)}`],
  ])('refuses %s', (_label, name) => {
    expect(() => withDatabase(ENV.DATA_DATABASE_URL, name)).toThrow(ProjectDatabaseNameError)
    expect(isProjectDatabaseName(name)).toBe(false)
  })

  it('refuses what is not a PostgreSQL URL with a host, without quoting it', () => {
    for (const url of ['not a url', 'mysql://u:secret-pw@h/db', 'postgresql:///db', 'http://u:secret-pw@h/db']) {
      let message = ''
      try {
        withDatabase(url, DB)
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectDatabaseNameError)
        message = (err as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('secret-pw')
    }
  })

  it('refuses a URL that names its database in a parameter, which libpq reads over the path', () => {
    expect(() => withDatabase('postgresql://u:p@h/x?dbname=platform', DB)).toThrow(ProjectDatabaseNameError)
    expect(() => withDatabase('postgresql://u:p@h/x?database=platform', DB)).toThrow(ProjectDatabaseNameError)
  })
})

describe('databaseClientUrl', () => {
  it('opens the project’s database with a pool of two and no statement cache, whatever the instance URL says', () => {
    const url = new URL(databaseClientUrl(`${ENV.DATABASE_URL_US_EAST_1}?connection_limit=20`, DB))
    expect(url.pathname).toBe(`/${DB}`)
    expect(url.searchParams.get('connection_limit')).toBe('2')
    expect(url.searchParams.get('statement_cache_size')).toBe('0')
  })
})

describe('databaseOfRecord', () => {
  it('reads a row with no tenancy, or shared, as the region’s shared database', () => {
    expect(databaseOfRecord('p', HOME_REGION, { region: null })).toEqual({
      region: HOME_REGION,
      tenancy: 'shared',
      database: null,
      instance: null,
      epoch: 0,
    })
    expect(
      databaseOfRecord('p', 'us-east-1', { region: 'us-east-1', databaseTenancy: 'shared', databaseName: DB, tenancyEpoch: 3 }),
    ).toEqual({ region: 'us-east-1', tenancy: 'shared', database: null, instance: null, epoch: 3 })
  })

  it('reads a database of the project’s own on the primary data instance', () => {
    expect(
      databaseOfRecord('p', 'us-east-1', { region: 'us-east-1', databaseTenancy: 'dedicated', databaseName: DB, tenancyEpoch: 1 }),
    ).toEqual({ region: 'us-east-1', tenancy: 'dedicated', database: DB, instance: PRIMARY_DATA_INSTANCE, epoch: 1 })
    expect(
      databaseOfRecord('p', HOME_REGION, { region: null, databaseTenancy: 'dedicated', databaseName: DB, databaseInstance: 'primary' }).instance,
    ).toBe('primary')
  })

  it.each([
    ['a tenancy this build does not know', { databaseTenancy: 'sharded', databaseName: DB }],
    ['a database of its own with no name', { databaseTenancy: 'dedicated', databaseName: null }],
    ['a database of its own with a name Backenly never gives', { databaseTenancy: 'dedicated', databaseName: 'platform' }],
    ['another data instance, never looked for on the primary one', { databaseTenancy: 'dedicated', databaseName: DB, databaseInstance: 'second' }],
  ])('refuses %s', (_label, fields) => {
    let error: unknown
    try {
      databaseOfRecord('p-odd', HOME_REGION, { region: null, ...fields })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(UnknownProjectDatabaseError)
    expect((error as UnknownProjectDatabaseError).code).toBe('UNKNOWN_PROJECT_DATABASE')
    expect((error as Error).message).toContain('p-odd')
    // A fail-soft read rethrows it: the data was never read.
    expect(isRegionError(error)).toBe(true)
    expect(() => unlessRegionError([])(error)).toThrow(UnknownProjectDatabaseError)
  })
})

describe('databaseClient', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const name of ['DATA_DATABASE_URL', 'DATABASE_URL_US_EAST_1', 'DATA_DATABASE_URL_US_EAST_1']) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  it('refuses a home project’s own database without DATA_DATABASE_URL before anything is opened', () => {
    delete process.env.DATA_DATABASE_URL
    expect(process.env.DATABASE_URL).toBeTruthy()
    expect(() => databaseClient(HOME_REGION, DB, 'p-home')).toThrow(RegionNotConfiguredError)
    expect(() => databaseClient(HOME_REGION, DB, 'p-home')).toThrow(/DATA_DATABASE_URL/)
  })

  it('refuses a region with no connection, never using the home data instance', () => {
    process.env.DATA_DATABASE_URL = ENV.DATA_DATABASE_URL
    delete process.env.DATABASE_URL_US_EAST_1
    delete process.env.DATA_DATABASE_URL_US_EAST_1
    let error: unknown
    try {
      databaseClient('us-east-1', DB, 'p-virginia')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(RegionNotConfiguredError)
    expect((error as RegionNotConfiguredError).region).toBe('us-east-1')
    expect((error as RegionNotConfiguredError).variable).toBe('DATABASE_URL_US_EAST_1')
  })

  it('refuses a name that is not a project database’s', () => {
    process.env.DATA_DATABASE_URL = ENV.DATA_DATABASE_URL
    expect(() => databaseClient(HOME_REGION, 'platform')).toThrow(ProjectDatabaseNameError)
  })
})

describe('regions stay regions', () => {
  it('an unknown region is still refused as one', () => {
    expect(isRegionError(new UnknownRegionError('p', 'mars-north-1'))).toBe(true)
    expect(isRegionError(new DatabaseBusyError('project database clients', 2))).toBe(true)
    // An unusable connection string for a project's database: its data was not read either.
    expect(isRegionError(new ProjectDatabaseNameError('not a URL'))).toBe(true)
    expect(isRegionError(new Error('anything else'))).toBe(false)
  })
})

// ── The epoch cache ─────────────────────────────────────────────────────────

interface Answer {
  epoch: number
  tenancy: 'shared' | 'dedicated'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('EpochCache', () => {
  it('reads once and answers from the cache after that', async () => {
    const cache = new EpochCache<Answer>()
    const load = jest.fn(async () => ({ epoch: 0, tenancy: 'shared' as const }))
    expect(await cache.get('p', load)).toEqual({ epoch: 0, tenancy: 'shared' })
    expect(await cache.get('p', load)).toEqual({ epoch: 0, tenancy: 'shared' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('caches nothing for a record that does not exist', async () => {
    const cache = new EpochCache<Answer>()
    const load = jest.fn(async () => null)
    expect(await cache.get('p', load)).toBeNull()
    expect(await cache.get('p', load)).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never answers shared again once told the epoch moved', async () => {
    const cache = new EpochCache<Answer>()
    let row: Answer = { epoch: 0, tenancy: 'shared' }
    const load = async () => row
    expect((await cache.get('p', load))?.tenancy).toBe('shared')

    row = { epoch: 1, tenancy: 'dedicated' }
    // Not told yet: the cached answer stands (the epoch is how a process learns).
    expect((await cache.get('p', load))?.tenancy).toBe('shared')

    cache.note('p', 1)
    expect(cache.peek('p')).toBeUndefined()
    expect(await cache.get('p', load)).toEqual({ epoch: 1, tenancy: 'dedicated' })
  })

  it('reads again when asked for an epoch later than the cached one', async () => {
    const cache = new EpochCache<Answer>()
    let row: Answer = { epoch: 0, tenancy: 'shared' }
    await cache.get('p', async () => row)
    row = { epoch: 2, tenancy: 'dedicated' }
    expect(await cache.get('p', async () => row, 2)).toEqual({ epoch: 2, tenancy: 'dedicated' })
    // An older epoch noted later does not bring the older answer back.
    cache.note('p', 1)
    expect(cache.peek('p')).toEqual({ epoch: 2, tenancy: 'dedicated' })
  })

  it('neither caches nor returns a read that was in flight when the epoch moved', async () => {
    const cache = new EpochCache<Answer>()
    const first = deferred<Answer>()
    const reads: Array<Promise<Answer>> = [first.promise, Promise.resolve({ epoch: 1, tenancy: 'dedicated' })]
    const load = jest.fn(() => reads.shift() as Promise<Answer>)

    const pending = cache.get('p', load)
    // The move is learned while the first read is still out.
    cache.note('p', 1)
    first.resolve({ epoch: 0, tenancy: 'shared' })

    expect(await pending).toEqual({ epoch: 1, tenancy: 'dedicated' })
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.peek('p')).toEqual({ epoch: 1, tenancy: 'dedicated' })
  })

  it('refuses rather than answer with a record that stays behind the noted epoch', async () => {
    const cache = new EpochCache<Answer>()
    cache.note('p', 5)
    const load = jest.fn(async () => ({ epoch: 4, tenancy: 'shared' as const }))
    await expect(cache.get('p', load)).rejects.toBeInstanceOf(EpochBehindError)
    expect(load).toHaveBeenCalledTimes(3)
    expect(cache.peek('p')).toBeUndefined()
  })

  it('keeps a later answer another read cached meanwhile', async () => {
    const cache = new EpochCache<Answer>()
    const slow = deferred<Answer>()
    const pending = cache.get('p', () => slow.promise)
    await cache.get('p', async () => ({ epoch: 3, tenancy: 'dedicated' }))
    slow.resolve({ epoch: 2, tenancy: 'dedicated' })
    expect(await pending).toEqual({ epoch: 3, tenancy: 'dedicated' })
  })

  it('is bounded, oldest entry out first', async () => {
    const cache = new EpochCache<Answer>(2)
    for (const key of ['a', 'b', 'c']) await cache.get(key, async () => ({ epoch: 0, tenancy: 'shared' }))
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBeDefined()
    expect(cache.peek('c')).toBeDefined()
  })
})

// ── The client registry ─────────────────────────────────────────────────────

interface FakeClient {
  key: string
  closed: boolean
  tracker: UseTracker
}

function registry(max: number, { minIdleMs = 0, idle }: { minIdleMs?: number; idle?: (c: FakeClient) => boolean } = {}) {
  let clock = 1_000_000
  const closed: string[] = []
  const reg = new DatabaseRegistry<FakeClient>({
    max,
    minIdleMs,
    idle,
    now: () => clock,
    close: (client) => {
      client.closed = true
      closed.push(client.key)
    },
    what: 'project database clients',
  })
  const open = (key: string) => reg.get(key, (tracker) => ({ key, closed: false, tracker }))
  const pin = (key: string) => reg.pin(key, (tracker) => ({ key, closed: false, tracker }))
  return { reg, open, pin, closed, tick: (ms: number) => (clock += ms) }
}

describe('DatabaseRegistry', () => {
  it('opens one client per database and hands the same one back', () => {
    const { reg, open } = registry(4)
    const a = open('a')
    expect(open('a')).toBe(a)
    expect(reg.size).toBe(1)
  })

  it('closes the least recently used idle client to make room', () => {
    const { reg, open, closed } = registry(2)
    open('a')
    open('b')
    open('a') // b is now the least recently used
    open('c')
    expect(closed).toEqual(['b'])
    expect(reg.has('a')).toBe(true)
    expect(reg.has('c')).toBe(true)
    expect(reg.size).toBe(2)
  })

  it('never closes a pinned client, however long unused', () => {
    const { reg, open, pin, closed, tick } = registry(2)
    const release = pin('a')
    open('b')
    tick(60_000)
    open('c') // a is older, but pinned: b goes
    expect(closed).toEqual(['b'])
    expect(reg.isPinned('a')).toBe(true)

    // Both left are in use now: nothing is opened past the cap.
    const releaseC = pin('c')
    let error: unknown
    try {
      open('d')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(DatabaseBusyError)
    expect((error as DatabaseBusyError).code).toBe('PROJECT_DATABASE_BUSY')
    expect((error as DatabaseBusyError).retryable).toBe(true)
    expect(reg.size).toBe(2)
    expect(closed).toEqual(['b'])

    // Released, a is the least recently used and makes room.
    release()
    release() // twice is harmless
    tick(1)
    open('d')
    expect(closed).toEqual(['b', 'a'])
    expect(reg.has('c')).toBe(true)
    releaseC()
  })

  it('nests pins: a client stays pinned until every pin is released', () => {
    const { reg, pin } = registry(2)
    const first = pin('a')
    const second = pin('a')
    first()
    expect(reg.isPinned('a')).toBe(true)
    second()
    expect(reg.isPinned('a')).toBe(false)
  })

  it('never closes a client while a query or transaction runs on it', () => {
    const { reg, open, closed } = registry(1)
    open('a')
    const done = reg.track('a')
    expect(() => open('b')).toThrow(DatabaseBusyError)
    done()
    done()
    open('b')
    expect(closed).toEqual(['a'])
  })

  it('counts uses through the tracker it gave the client', () => {
    const { open, closed } = registry(1)
    const client = open('a')
    const done = client.tracker.start()
    expect(() => open('b')).toThrow(DatabaseBusyError)
    done()
    open('b')
    expect(closed).toEqual(['a'])
  })

  it('leaves a client used a moment ago open', () => {
    const { open, closed, tick } = registry(1, { minIdleMs: 1_000 })
    open('a')
    expect(() => open('b')).toThrow(DatabaseBusyError)
    tick(1_000)
    open('b')
    expect(closed).toEqual(['a'])
  })

  it('asks the value whether it is idle', () => {
    let busy = true
    const { open, closed } = registry(1, { idle: () => !busy })
    open('a')
    expect(() => open('b')).toThrow(DatabaseBusyError)
    busy = false
    open('b')
    expect(closed).toEqual(['a'])
  })

  it('closes everything on shutdown, pinned or not', async () => {
    const { reg, open, pin, closed } = registry(3)
    pin('a')
    open('b')
    await reg.closeAll()
    expect(closed.sort()).toEqual(['a', 'b'])
    expect(reg.size).toBe(0)
  })

  it('swallows a close that fails: the client is gone either way', async () => {
    const reg = new DatabaseRegistry<{ key: string }>({
      max: 1,
      close: () => {
        throw new Error('already closed')
      },
      what: 'project database clients',
    })
    reg.get('a', () => ({ key: 'a' }))
    expect(() => reg.get('b', () => ({ key: 'b' }))).not.toThrow()
    await expect(reg.closeAll()).resolves.toBeUndefined()
  })

  it('refuses a cap below one', () => {
    expect(() => new DatabaseRegistry({ max: 0, close: () => {}, what: 'clients' })).toThrow()
  })
})

it('uses distinct names for distinct databases', () => {
  expect(DB).not.toBe(OTHER_DB)
  expect(isProjectDatabaseName(DB) && isProjectDatabaseName(OTHER_DB)).toBe(true)
})
