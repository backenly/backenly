/**
 * AN IMPORT STOPS AT THE ROOM THE PLAN HAS LEFT, WHATEVER THE SOURCE SAID
 * ======================================================================
 *
 * The pre-checks compare the size a source reports (pg_table_size, a sample's
 * estimate) with what is left of the organization's database storage. A
 * source can report 0: a partitioned table's parent did, and a server that is
 * not PostgreSQL can answer anything. So the copy writes rows only as far as
 * the room lets them in, measuring the project's tables as it fills, and
 * stops there in the pre-check's words (lib/import/limits.ts RowRoom,
 * lib/import/pg-engine.ts copyRows).
 *
 * Here a source reports 0 bytes and then sends rows without end, rows that
 * PostgreSQL stores at more than their text (out of line, pages part-used):
 * the first version of the room counted text alone and let these tables grow
 * past it. Real provisioned project, governed table creation, the project's
 * own database; the source is a stand-in reader, since no socket is involved.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { ImportInputError } from '@/lib/import/driver'
import { limitsLeft } from '@/lib/import/limits'
import type { SourceReader } from '@/lib/import/net'
import { copyRows, createTables, rowRoomFor } from '@/lib/import/pg-engine'
import { buildPlan, type CatalogColumn, type SourceCatalog } from '@/lib/import/pg-plan'

const MB = 1024 * 1024
let ownerId: string
let projectId: string
let schema: string
const env = { BACKENLY_EDITION: process.env.BACKENLY_EDITION, ENGINE_MODE: process.env.ENGINE_MODE }

function col(name: string, formatted: string, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name,
    formatted,
    typeName: formatted,
    typeKind: 'b',
    category: formatted === 'uuid' ? 'U' : 'S',
    elementFormatted: null,
    elementTypeName: null,
    elementKind: null,
    domain: null,
    nullable: true,
    defaultExpr: null,
    identity: false,
    generated: false,
    ...extra,
  }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (
    await prisma.user.create({
      data: { email: `import-room-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
    })
  ).id
  const project = await createProvisionedProject({ name: 'import-room', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 240_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool().catch(() => {})
  process.env.BACKENLY_EDITION = env.BACKENLY_EDITION
  process.env.ENGINE_MODE = env.ENGINE_MODE
})

it('stops at the room when a source that reported 0 bytes keeps sending rows', async () => {
  const catalog: SourceCatalog = {
    tables: [
      {
        schema: 'public',
        name: 'blobs',
        columns: [col('id', 'uuid', { nullable: false }), col('body', 'text')],
        primaryKey: ['id'],
        uniques: [],
        foreignKeys: [],
        rlsEnabled: false,
        partitioned: false,
        // What the source said: nothing.
        bytes: 0,
        rows: 0,
        rowsExact: true,
      },
    ],
    policies: [],
    functions: 0,
    triggers: 0,
    views: 0,
    materializedViews: 0,
    extensions: [],
  }
  const plan = buildPlan(catalog, { source: 'postgres', usersMoving: false, schemas: ['public'] })
  const t = plan.tables[0]
  await createTables(projectId, plan, { title: 'Move in from Postgres: 1 table', signal: new AbortController().signal })

  // Rows of 10 KB that do not compress (as stored, about what they are as text), for as long as they are asked for.
  const idAt = t.copy.find((c) => c.column === 'id')!.from
  let sent = 0
  const source: SourceReader = {
    query: async () => ({ rows: [], fields: [] }),
    queryArrays: async (text: string) => {
      const n = Number(/FETCH FORWARD (\d+)/.exec(text)?.[1] ?? 0)
      const rows = Array.from({ length: n }, () => t.select.map((_, i) => (i === idAt ? crypto.randomUUID() : crypto.randomBytes(5_000).toString('hex'))))
      sent += rows.length
      return { rows, fields: [] }
    },
  }

  // 4 MB left of the plan's 6 MB.
  const limits = limitsLeft({ planRowBytes: 6 * MB, planFileBytes: null, usedRowBytes: 2 * MB, usedFileBytes: 0, planName: 'Free' })
  const room = await rowRoomFor(projectId, () => [t.name], limits)
  const err = await copyRows(source, projectId, plan, {
    signal: new AbortController().signal,
    secret: crypto.randomBytes(32),
    room,
    onRows: () => {},
  }).catch((e) => e)

  expect(err).toBeInstanceOf(ImportInputError)
  expect(err.message).toMatch(
    /^Backenly stopped the import after \d+ MB of rows: the organization has 4 MB left of the 6 MB of database storage on Free\. Free some space or upgrade the organization, then import again\.$/,
  )
  // Measured as the plan's usage is (lib/usage/db-storage.ts): indexes and TOAST included.
  const [held] = await prisma.$queryRawUnsafe<Array<{ bytes: string; n: string }>>(
    `SELECT pg_total_relation_size('"${schema}"."blobs"'::regclass)::text AS bytes, (SELECT count(*) FROM "${schema}"."blobs")::text AS n`,
  )
  expect(Number(held.n)).toBeGreaterThan(0)
  expect(Number(held.n)).toBeLessThan(sent)
  expect(Number(held.bytes)).toBeLessThanOrEqual(limits.maxRowBytes)
}, 240_000)
