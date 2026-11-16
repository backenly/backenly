/**
 * A TABLE MOVED IN BRINGS NOTHING ITS SOURCE DID NOT HAVE
 * ======================================================
 *
 * CREATE_TABLE provisions things a table's NAME suggests: a table called
 * `uploads`, `videos` or `*_jobs` gets three storage buckets, one of them
 * public (`thumbnails`), and a table declared with no columns gets a
 * blueprint's. Right for a table Backenly designs from a description; wrong
 * for one moved in from Supabase, Firebase or Postgres (lib/import), where
 * it would create buckets and public access the source never had.
 *
 * `noAutoProvision: true` turns both off, for the import steps only. Every
 * other caller keeps the default, pinned here too. Real provisioned project,
 * real executor, real DDL.
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
import { executeAction } from '@/lib/ai/minimal-executor'
import { createTableParams } from '@/lib/import/pg-engine'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let schema: string
const env = { BACKENLY_EDITION: process.env.BACKENLY_EDITION, ENGINE_MODE: process.env.ENGINE_MODE }

async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    schema,
    table,
  )
  return rows.map((r) => r.column_name)
}

const buckets = () => prisma.storageBucket.findMany({ where: { projectId }, select: { name: true, isPublic: true }, orderBy: { name: 'asc' } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (
    await prisma.user.create({
      data: { email: `no-auto-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
    })
  ).id
  const project = await createProvisionedProject({ name: 'no-auto-provision', userId: ownerId })
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

it('a moved-in `uploads` table creates no buckets', async () => {
  const r = await executeAction(
    { action: 'CREATE_TABLE', params: { tableName: 'uploads', asWritten: true, noAutoProvision: true, columns: [{ name: 'path', type: 'TEXT', sqlType: 'text' }] } } as any,
    projectId,
  )
  expect(r.success).toBe(true)
  expect(await columnsOf('uploads')).toContain('path')
  expect(await buckets()).toEqual([])
}, 120_000)

it('a moved-in table declared with no columns gets no blueprint columns', async () => {
  const r = await executeAction(
    { action: 'CREATE_TABLE', params: { tableName: 'orders', asWritten: true, noAutoProvision: true, columns: [] } } as any,
    projectId,
  )
  expect(r.success).toBe(true)
  expect((await columnsOf('orders')).sort()).toEqual(['createdAt', 'deleted_at', 'id', 'updatedAt'])
}, 120_000)

it('the import steps always pass it', () => {
  const params = createTableParams({
    sourceSchema: 'public', sourceName: 'videos', sourceKey: 'public.videos', name: 'videos', columns: [], select: [], copy: [],
    pk: { kind: 'none', columns: [], carrier: null }, deferredForeignKeys: [], rows: 0, rowsExact: true, bytes: 0, notes: [], columnMap: {},
  })
  expect(params).toMatchObject({ asWritten: true, noAutoProvision: true })
})

it('every other caller keeps the default: `videos` still gets its buckets', async () => {
  const r = await executeAction(
    { action: 'CREATE_TABLE', params: { tableName: 'videos', columns: [{ name: 'title', type: 'TEXT' }] } } as any,
    projectId,
  )
  expect(r.success).toBe(true)
  expect((await buckets()).map((b) => b.name)).toEqual(['source-assets', 'thumbnails', 'videos'])
}, 120_000)
