/**
 * A PROJECT WITH A DATABASE OF ITS OWN IS REACHED THERE, AND ONLY THERE
 * =====================================================================
 * A project's row records its tenancy (lib/data-plane/regional.ts
 * projectDatabase). 'shared' keeps its schema in its region's own database, as
 * every project's always was; 'dedicated' gives it a database of its own, named
 * on the row, on the region's data instance.
 *
 * This suite creates real databases on the CI server: two named as projects'
 * own (p_ and 32 hex digits) and one standing in for another region's own
 * database (DATABASE_URL_US_EAST_1), and pins:
 *
 *   home          a home project with a database of its own is reached there by
 *                 workspaceRawClient, projectPool and projectDatabaseUrl, on
 *                 DATA_DATABASE_URL's server; region work and shared projects
 *                 stay on the platform database; without DATA_DATABASE_URL it
 *                 is refused, naming it, and nothing goes to the platform one
 *   other region  with no DATA_DATABASE_URL_<REGION>, the region's own server
 *                 holds the project's database; without the region's
 *                 connection it is refused, never sent to the home instance
 *   epoch         once this process learns the data moved, it never answers
 *                 with the old database again
 *   recorder      a statement sent on a project database's client is captured,
 *                 once
 *   drift events  the store answers exactly as the Prisma model does on the
 *                 same rows, and reads a project's own database's events there
 *   shutdown      disconnectRegionalClients closes every connection to them
 *
 * Real databases throughout: nothing that carries the property is mocked.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Client } from 'pg'

import { prisma } from '@/lib/db/prisma'
import {
  assertProjectReachable,
  disconnectRegionalClients,
  noteTenancyEpoch,
  partitionReachable,
  projectDatabase,
  projectDatabaseUrl,
  projectDriftEvents,
  projectPool,
  projectRegion,
  regionDriftEvents,
  regionPool,
  regionRawClient,
  workspaceRawClient,
} from '@/lib/data-plane/regional'
import { installSqlRecorder, withSqlCapture } from '@/lib/execution/sql-recorder'
import { HOME_REGION } from '@/lib/regions'

jest.setTimeout(180_000)

const SUFFIX = randomBytes(4).toString('hex')
const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGION_DB = `backenly_dbres_${SUFFIX}`
const HOME_OWN_DB = `p_${randomBytes(16).toString('hex')}`
const REGION_OWN_DB = `p_${randomBytes(16).toString('hex')}`
/** Named on a row only: never created, never connected to. */
const MOVED_DB = `p_${randomBytes(16).toString('hex')}`

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function rowsIn<T>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}
const run = async (connectionString: string, sql: string, params: unknown[] = []) => {
  await rowsIn(connectionString, sql, params)
}

const ENV_NAMES = ['DATA_DATABASE_URL', 'DATA_DIRECT_URL', REGION_VARIABLE, 'DATA_DATABASE_URL_US_EAST_1'] as const
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

let platformDb = ''
let ownerId = ''
let homeDedicated = ''
let regionDedicated = ''
let homeShared = ''
let moving = ''
const created: string[] = []

/** The database, and the marker row, a raw SQL client lands on. */
async function whereRaw(projectId: string): Promise<{ db: string; note: string }> {
  const db = await workspaceRawClient(projectId)
  const [row] = await db.$queryRawUnsafe<Array<{ db: string; note: string }>>(
    'SELECT current_database()::text AS db, note FROM public.dbres_marker',
  )
  return row
}

async function wherePool(projectId: string): Promise<{ db: string; note: string }> {
  const pool = await projectPool(projectId, 'dbres-probe', { max: 5 })
  const { rows } = await pool.query<{ db: string; note: string }>('SELECT current_database()::text AS db, note FROM public.dbres_marker')
  return rows[0]
}

async function whereUrl(projectId: string): Promise<{ db: string; note: string }> {
  const [row] = await rowsIn<{ db: string; note: string }>(
    await projectDatabaseUrl(projectId),
    'SELECT current_database()::text AS db, note FROM public.dbres_marker',
  )
  return row
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  platformDb = new URL(homeUrl()).pathname.slice(1)

  for (const name of [REGION_DB, HOME_OWN_DB, REGION_OWN_DB]) {
    await run(homeUrl(), `CREATE DATABASE "${name}"`)
    created.push(name)
  }
  // Each database says which it is, so a query landing anywhere else is seen.
  await run(homeUrl(), `CREATE TABLE IF NOT EXISTS public.dbres_marker (note text)`)
  await run(homeUrl(), `DELETE FROM public.dbres_marker`)
  await run(homeUrl(), `INSERT INTO public.dbres_marker VALUES ('platform')`)
  for (const [name, note] of [[REGION_DB, 'region'], [HOME_OWN_DB, 'home own'], [REGION_OWN_DB, 'region own']] as const) {
    await run(urlFor(name), `CREATE TABLE public.dbres_marker (note text)`)
    await run(urlFor(name), `INSERT INTO public.dbres_marker VALUES ($1)`, [note])
  }
  // The drift event table a project's own database holds, as the procedure
  // installs it; backenly_app_role() names the role the application connects as.
  for (const name of [HOME_OWN_DB, REGION_OWN_DB]) {
    await run(urlFor(name), `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
    await run(urlFor(name), fs.readFileSync('scripts/sql/schema-drift-events.sql', 'utf8'))
  }

  // The home data instance is this server; its database part is replaced by
  // each project's own. us-east-1 names no data instance, so its own server is.
  process.env.DATA_DATABASE_URL = urlFor('postgres')
  delete process.env.DATA_DIRECT_URL
  process.env[REGION_VARIABLE] = urlFor(REGION_DB)
  delete process.env.DATA_DATABASE_URL_US_EAST_1

  ownerId = (
    await prisma.user.create({ data: { email: `dbres-${randomUUID()}@example.test`, name: 'database resolution fixture' }, select: { id: true } })
  ).id
  const project = async (data: Record<string, unknown>) =>
    (await prisma.project.create({ data: { name: `dbres-${randomUUID()}`, userId: ownerId, ...data } as any, select: { id: true } })).id
  homeDedicated = await project({ databaseTenancy: 'dedicated', databaseName: HOME_OWN_DB })
  regionDedicated = await project({ region: 'us-east-1', databaseTenancy: 'dedicated', databaseName: REGION_OWN_DB })
  homeShared = await project({})
  moving = await project({})
})

afterAll(async () => {
  await disconnectRegionalClients().catch(() => {})
  const ids = [homeDedicated, regionDedicated, homeShared, moving].filter(Boolean)
  await prisma.schemaDriftEvent.deleteMany({ where: { id: { endsWith: `-${SUFFIX}` } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  await run(homeUrl(), `DROP TABLE IF EXISTS public.dbres_marker`).catch(() => {})
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  for (const name of created) await run(homeUrl(), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
})

describe('a home project with a database of its own', () => {
  it('resolves to that database in the home region', async () => {
    expect(await projectDatabase(homeDedicated)).toEqual({
      region: HOME_REGION,
      tenancy: 'dedicated',
      database: HOME_OWN_DB,
      instance: 'primary',
      epoch: 0,
    })
    expect(await projectRegion(homeDedicated)).toBe(HOME_REGION)
  })

  it('is reached there by workspaceRawClient, projectPool and projectDatabaseUrl', async () => {
    const own = { db: HOME_OWN_DB, note: 'home own' }
    expect(await whereRaw(homeDedicated)).toEqual(own)
    expect(await wherePool(homeDedicated)).toEqual(own)
    expect(await whereUrl(homeDedicated)).toEqual(own)

    const url = new URL(await projectDatabaseUrl(homeDedicated))
    expect(url.pathname).toBe(`/${HOME_OWN_DB}`)
    expect(url.host).toBe(new URL(process.env.DATA_DATABASE_URL as string).host)

    // Small pools, whatever a subsystem asks for, one per database.
    const pool = await projectPool(homeDedicated, 'dbres-probe', { max: 5 })
    expect((pool as any).options.max).toBe(2)
    expect(pool).not.toBe(await projectPool(homeShared, 'dbres-probe'))
  })

  it('leaves work about the region, and shared projects, on the platform database', async () => {
    const platform = { db: platformDb, note: 'platform' }
    const [region] = await regionRawClient(HOME_REGION).$queryRawUnsafe<Array<{ db: string; note: string }>>(
      'SELECT current_database()::text AS db, note FROM public.dbres_marker',
    )
    expect(region).toEqual(platform)
    const { rows } = await regionPool(HOME_REGION, 'dbres-probe').query('SELECT current_database()::text AS db, note FROM public.dbres_marker')
    expect(rows[0]).toEqual(platform)
    expect(await projectPool(homeShared, 'dbres-probe')).toBe(regionPool(HOME_REGION, 'dbres-probe'))

    expect(await projectDatabase(homeShared)).toEqual({ region: HOME_REGION, tenancy: 'shared', database: null, instance: null, epoch: 0 })
    expect(await whereRaw(homeShared)).toEqual(platform)
    expect(await workspaceRawClient(homeShared)).toBe(regionRawClient(HOME_REGION))
    expect(await projectDatabaseUrl(homeShared)).toBe(homeUrl())
  })

  it('needs a data instance variable for each role, never borrowing the platform one', async () => {
    // DIRECT_URL is set (the platform's); DATA_DIRECT_URL is not.
    await expect(projectDatabaseUrl(homeDedicated, 'direct')).rejects.toMatchObject({
      code: 'REGION_NOT_CONFIGURED',
      variable: 'DATA_DIRECT_URL',
    })
  })

  it('is refused without DATA_DATABASE_URL, and nothing is sent to the platform database', async () => {
    const held = await workspaceRawClient(homeDedicated)
    const dataUrl = process.env.DATA_DATABASE_URL
    delete process.env.DATA_DATABASE_URL
    try {
      const refused = { code: 'REGION_NOT_CONFIGURED', variable: 'DATA_DATABASE_URL' }
      await expect(workspaceRawClient(homeDedicated)).rejects.toMatchObject(refused)
      await expect(projectPool(homeDedicated, 'dbres-probe')).rejects.toMatchObject(refused)
      await expect(projectDatabaseUrl(homeDedicated)).rejects.toMatchObject(refused)
      await expect(assertProjectReachable(homeDedicated)).rejects.toMatchObject(refused)
      await expect(projectDriftEvents(homeDedicated)).rejects.toMatchObject(refused)
      // A client handed out before is checked on every use.
      await expect(async () => held.$queryRawUnsafe('SELECT 1')).rejects.toMatchObject(refused)

      const { reachable, unreachable } = await partitionReachable([{ id: homeDedicated }, { id: homeShared }])
      expect(reachable).toEqual([{ id: homeShared }])
      expect(unreachable).toEqual([
        { projectId: homeDedicated, region: HOME_REGION, code: 'REGION_NOT_CONFIGURED', variable: 'DATA_DATABASE_URL' },
      ])
      // Shared projects are untouched by it.
      expect(await whereRaw(homeShared)).toEqual({ db: platformDb, note: 'platform' })
    } finally {
      process.env.DATA_DATABASE_URL = dataUrl
    }
    expect(await assertProjectReachable(homeDedicated)).toMatchObject({ tenancy: 'dedicated', database: HOME_OWN_DB })
  })
})

describe('a project in another region with a database of its own', () => {
  it('is reached on its region’s server, while region work stays on the region’s own database', async () => {
    expect(await projectDatabase(regionDedicated)).toMatchObject({ region: 'us-east-1', tenancy: 'dedicated', database: REGION_OWN_DB })
    const own = { db: REGION_OWN_DB, note: 'region own' }
    expect(await whereRaw(regionDedicated)).toEqual(own)
    expect(await wherePool(regionDedicated)).toEqual(own)
    expect(await whereUrl(regionDedicated)).toEqual(own)

    const [region] = await regionRawClient('us-east-1').$queryRawUnsafe<Array<{ db: string; note: string }>>(
      'SELECT current_database()::text AS db, note FROM public.dbres_marker',
    )
    expect(region).toEqual({ db: REGION_DB, note: 'region' })
    expect((await partitionReachable([{ id: regionDedicated }])).reachable).toEqual([{ id: regionDedicated }])
  })

  it('is refused without its region’s connection, never sent to the home data instance', async () => {
    delete process.env[REGION_VARIABLE]
    try {
      expect(process.env.DATA_DATABASE_URL).toBeTruthy()
      const refused = { code: 'REGION_NOT_CONFIGURED', region: 'us-east-1', variable: REGION_VARIABLE }
      await expect(workspaceRawClient(regionDedicated)).rejects.toMatchObject(refused)
      await expect(projectPool(regionDedicated, 'dbres-probe')).rejects.toMatchObject(refused)
      await expect(projectDatabaseUrl(regionDedicated)).rejects.toMatchObject(refused)
      expect((await partitionReachable([{ id: regionDedicated }])).unreachable).toEqual([
        { projectId: regionDedicated, region: 'us-east-1', code: 'REGION_NOT_CONFIGURED', variable: REGION_VARIABLE },
      ])
    } finally {
      process.env[REGION_VARIABLE] = urlFor(REGION_DB)
    }
  })
})

describe('a project whose data moves to a database of its own', () => {
  it('is never answered with the old database once this process learns the epoch moved', async () => {
    expect(await projectDatabase(moving)).toMatchObject({ tenancy: 'shared', epoch: 0 })
    expect(await whereRaw(moving)).toEqual({ db: platformDb, note: 'platform' })

    await prisma.project.update({
      where: { id: moving },
      data: { databaseTenancy: 'dedicated', databaseName: MOVED_DB, tenancyEpoch: 1 } as any,
    })
    // Cached until told: the epoch, carried by a read, is how a process learns.
    expect(await projectDatabase(moving)).toMatchObject({ tenancy: 'shared', epoch: 0 })

    noteTenancyEpoch(moving, 1)
    expect(await projectDatabase(moving)).toEqual({
      region: HOME_REGION,
      tenancy: 'dedicated',
      database: MOVED_DB,
      instance: 'primary',
      epoch: 1,
    })
    expect(new URL(await projectDatabaseUrl(moving)).pathname).toBe(`/${MOVED_DB}`)

    // A caller that read the epoch itself gets an answer at least that new.
    await prisma.project.update({ where: { id: moving }, data: { databaseTenancy: 'shared', databaseName: null, tenancyEpoch: 2 } as any })
    expect(await projectDatabase(moving, { epoch: 2 })).toMatchObject({ tenancy: 'shared', database: null, epoch: 2 })

    // A fresh read of the rows (partitionReachable) notes their epochs too.
    await prisma.project.update({ where: { id: moving }, data: { databaseTenancy: 'dedicated', databaseName: MOVED_DB, tenancyEpoch: 3 } as any })
    await partitionReachable([{ id: moving }])
    expect(await projectDatabase(moving)).toMatchObject({ tenancy: 'dedicated', database: MOVED_DB, epoch: 3 })
  })
})

describe('the SQL recorder', () => {
  it('captures a statement sent on a project database’s client, once', async () => {
    const db = await workspaceRawClient(homeDedicated)
    // What a governed change used to do: a no-op on top of the client's own.
    installSqlRecorder(db as any)
    const sql = `CREATE TABLE public.recorded_${SUFFIX} (id int)`
    const { statements } = await withSqlCapture(async () => {
      await db.$queryRawUnsafe('SELECT 1')
      await db.$executeRawUnsafe(sql)
    })
    expect(statements.map((s) => s.sql)).toEqual([sql])
    const [{ db: landed }] = await rowsIn<{ db: string }>(
      urlFor(HOME_OWN_DB),
      `SELECT current_database()::text AS db FROM pg_class WHERE relname = $1`,
      [`recorded_${SUFFIX}`],
    )
    expect(landed).toBe(HOME_OWN_DB)
  })

  it('captures statements inside a transaction on it, and on a region’s client, with nothing installed by the caller', async () => {
    const db = await workspaceRawClient(regionDedicated)
    const inside = `CREATE TABLE public.recorded_tx_${SUFFIX} (id int)`
    const onRegion = `CREATE TABLE public.recorded_region_${SUFFIX} (id int)`
    const { statements } = await withSqlCapture(async () => {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(inside)
      })
      // The region's own client: its recorder came with it, as no governed
      // change or repair has run in this file to install one.
      await regionRawClient('us-east-1').$executeRawUnsafe(onRegion)
    })
    expect(statements.map((s) => s.sql)).toEqual([inside, onRegion])
  })
})

describe('the drift event store', () => {
  const at = (minutes: number) => new Date(Date.UTC(2000, 0, 1, 0, minutes, 0, 123 + minutes))
  const gone = randomUUID()
  // Twins with no project row, so each resolves to the platform table: one is
  // written by the store, the other by the model, and the results compared.
  const twinX = randomUUID()
  const twinY = randomUUID()
  const row = (id: string, projectId: string | null, minute: number, status: string, resolvedMinute?: number) => ({
    id: `${id}-${SUFFIX}`,
    projectId,
    roleName: 'bkn_rw_fixture',
    commandTag: minute % 2 ? 'CREATE TABLE' : 'DROP TABLE',
    objectType: 'table',
    objectIdentity: `workspace_x.t${minute}`,
    schemaName: 'workspace_x',
    capturedAt: at(minute),
    status,
    resolvedAt: resolvedMinute === undefined ? null : at(resolvedMinute),
  })

  beforeAll(async () => {
    await prisma.schemaDriftEvent.createMany({
      data: [
        row('a1', homeShared, 1, 'pending'),
        row('a2', homeShared, 3, 'pending'),
        row('a3', homeShared, 5, 'adopted', 6),
        row('a4', homeShared, 7, 'pending'),
        row('a5', homeShared, 9, 'ignored', 10),
        row('g1', gone, 2, 'pending'),
        row('g2', gone, 4, 'pending'),
        row('n1', null, 8, 'pending'),
        // Twins, for comparing a write with the model's on rows of the same shape.
        row('x1', twinX, 11, 'pending'),
        row('x2', twinX, 12, 'adopted', 13),
        row('y1', twinY, 11, 'pending'),
        row('y2', twinY, 12, 'adopted', 13),
        // In the platform table, naming the project with a database of its own:
        // never what that project's events are read from.
        row('d1', homeDedicated, 14, 'pending'),
      ],
    })
  })

  const model = prisma.schemaDriftEvent

  it('reads exactly what the model reads from the platform table', async () => {
    const store = await projectDriftEvents(homeShared)
    expect(await store.pending(homeShared)).toEqual(
      await model.findMany({ where: { projectId: homeShared, status: 'pending' }, orderBy: { capturedAt: 'asc' } }),
    )
    expect(await store.pending(homeShared, { take: 2 })).toEqual(
      await model.findMany({ where: { projectId: homeShared, status: 'pending' }, orderBy: { capturedAt: 'asc' }, take: 2 }),
    )
    expect(await store.capturedBetween(homeShared, { from: at(2), to: at(7), take: 2 })).toEqual(
      await model.findMany({
        where: { projectId: homeShared, capturedAt: { gte: at(2), lte: at(7) } },
        orderBy: { capturedAt: 'desc' },
        take: 2,
      }),
    )
    expect(await store.capturedBetween(homeShared, { from: at(3), take: 500 })).toEqual(
      await model.findMany({ where: { projectId: homeShared, capturedAt: { gte: at(3) } }, orderBy: { capturedAt: 'desc' }, take: 500 }),
    )
    expect(await store.countPending(homeShared)).toBe(await model.count({ where: { projectId: homeShared, status: 'pending' } }))
    expect(await store.countPending(homeShared)).toBe(3)
  })

  it('groups pending events by project exactly as the model does', async () => {
    const store = regionDriftEvents(HOME_REGION)
    const asModel = async (capturedBefore?: Date) =>
      (
        await model.groupBy({
          by: ['projectId'],
          where: { status: 'pending', ...(capturedBefore ? { capturedAt: { lt: capturedBefore } } : {}) },
          _count: { _all: true },
          _min: { capturedAt: true },
        })
      ).map((g) => ({ projectId: g.projectId, count: g._count._all, oldestCapturedAt: g._min.capturedAt }))
    const sorted = <T extends { projectId: string | null }>(groups: T[]) =>
      [...groups].sort((a, b) => (a.projectId ?? '').localeCompare(b.projectId ?? ''))

    expect(sorted(await store.pendingByProject())).toEqual(sorted(await asModel()))
    expect(sorted(await store.pendingByProject({ capturedBefore: at(4) }))).toEqual(sorted(await asModel(at(4))))
    expect((await store.pendingByProject()).find((g) => g.projectId === homeShared)).toEqual({
      projectId: homeShared,
      count: 3,
      oldestCapturedAt: at(1),
    })
  })

  it('adopts exactly what the model’s update did, and is no statement of a change', async () => {
    const resolvedAt = new Date(Date.UTC(2000, 0, 2, 0, 0, 0, 456))
    const store = await projectDriftEvents(twinX)
    // Captured where it runs, the model's write never was; neither is this.
    const { result: adopted, statements } = await withSqlCapture(() =>
      store.adopt(twinX, [`x1-${SUFFIX}`, `x2-${SUFFIX}`, 'no-such-event'], resolvedAt),
    )
    const { count } = await model.updateMany({
      where: { projectId: twinY, status: 'pending', id: { in: [`y1-${SUFFIX}`, `y2-${SUFFIX}`, 'no-such-event'] } },
      data: { status: 'adopted', resolvedAt },
    })
    expect(adopted).toBe(count)
    expect(adopted).toBe(1)
    expect(statements).toEqual([])

    const shape = (rows: Array<{ id: string; projectId: string | null }>) =>
      rows.map(({ id, projectId: _projectId, ...rest }) => ({ ...rest, id: id.slice(1) }))
    expect(shape(await model.findMany({ where: { projectId: twinX }, orderBy: { id: 'asc' } }))).toEqual(
      shape(await model.findMany({ where: { projectId: twinY }, orderBy: { id: 'asc' } })),
    )
  })

  it('deletes exactly the events the model would', async () => {
    const store = regionDriftEvents(HOME_REGION)
    const cutoff = new Date(Date.UTC(2000, 0, 1, 0, 8, 0, 0))

    const resolvedWhere = { status: { in: ['adopted', 'ignored'] }, resolvedAt: { lt: cutoff } }
    const resolved = (await model.findMany({ where: resolvedWhere, select: { id: true } })).map((r) => r.id).sort()
    expect(resolved).toContain(`a3-${SUFFIX}`)
    expect(resolved).not.toContain(`a5-${SUFFIX}`)
    expect(await store.deleteResolvedBefore(cutoff)).toBe(resolved.length)
    expect(await model.count({ where: resolvedWhere })).toBe(0)
    expect(await model.count({ where: { id: `a5-${SUFFIX}` } })).toBe(1)

    const later = new Date(Date.UTC(2000, 0, 1, 0, 9, 0, 0))
    const pendingWhere = { status: 'pending', capturedAt: { lt: later }, OR: [{ projectId: null }, { projectId: { in: [gone] } }] }
    const orphans = (await model.findMany({ where: pendingWhere, select: { id: true } })).map((r) => r.id).sort()
    expect(orphans).toEqual(expect.arrayContaining([`g1-${SUFFIX}`, `g2-${SUFFIX}`, `n1-${SUFFIX}`]))
    expect(await store.deletePendingBefore(later, { projectIds: [gone], unnamed: true })).toBe(orphans.length)
    expect(await model.count({ where: pendingWhere })).toBe(0)
    // The project's own pending events are not orphans.
    expect(await model.count({ where: { projectId: homeShared, status: 'pending' } })).toBe(3)
    expect(await store.deletePendingBefore(later, { projectIds: [], unnamed: false })).toBe(0)
  })

  it('reads a project’s own database’s events there, not the platform’s', async () => {
    await run(
      urlFor(HOME_OWN_DB),
      `INSERT INTO public.schema_drift_events ("id", "projectId", "roleName", "commandTag", "objectIdentity", "schemaName", "capturedAt")
       VALUES ($1, $2, 'bkn_own_fixture', 'CREATE TABLE', 'workspace_x.own', 'workspace_x', '2000-01-03 00:00:00.789')`,
      [`own-${SUFFIX}`, homeDedicated],
    )
    const store = await projectDriftEvents(homeDedicated)
    const pending = await store.pending(homeDedicated)
    expect(pending).toEqual([
      {
        id: `own-${SUFFIX}`,
        projectId: homeDedicated,
        roleName: 'bkn_own_fixture',
        commandTag: 'CREATE TABLE',
        objectType: null,
        objectIdentity: 'workspace_x.own',
        schemaName: 'workspace_x',
        capturedAt: new Date(Date.UTC(2000, 0, 3, 0, 0, 0, 789)),
        status: 'pending',
        resolvedAt: null,
        findingId: null,
      },
    ])
    // The platform table holds a pending event naming this project too (d1), and it is not read.
    expect(await model.count({ where: { projectId: homeDedicated, status: 'pending' } })).toBe(1)
    expect(await store.countPending(homeDedicated)).toBe(1)
  })
})

describe('closing down', () => {
  it('closes every connection to projects’ own databases', async () => {
    // Open both kinds first, so there is something to close.
    await whereRaw(homeDedicated)
    await wherePool(regionDedicated)
    await disconnectRegionalClients()

    const open = async () =>
      (
        await rowsIn<{ n: number }>(
          homeUrl(),
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`,
          [[HOME_OWN_DB, REGION_OWN_DB]],
        )
      )[0].n
    const deadline = Date.now() + 10_000
    let n = await open()
    while (n > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      n = await open()
    }
    expect(n).toBe(0)
  })
})
