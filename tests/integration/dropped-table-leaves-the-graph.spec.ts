/**
 * A TABLE THAT IS GONE IS GONE FROM THE DATABASE PAGE
 * ===================================================
 * Production QA (2026-11-09): after an approved drop of `reviews`, the Database
 * page still listed it. The page lists the live tables and, beside them, every
 * entity of the project's active graph that has no table. The drop took the
 * entity out of whichever graph row the database returned first, usually the
 * oldest version, editing history in place, and left the active graph with the
 * table in it. A table removed any other way, by a restore or over a direct
 * connection, stayed listed too: nothing ever took an entity out of the graph.
 *
 * Against a real database, through the executor and the change ledger:
 *   - a drop takes the table out of the active graph as a new version, with
 *     the API entries that serve it and the relationships other tables hold to
 *     it, and leaves every earlier version as it was;
 *   - a table that a restore removed is not listed, and the next
 *     reconciliation takes it out of the graph.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
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
import { withChangeAttribution } from '@/lib/changes/attribution'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { executeAction } from '@/lib/ai/minimal-executor'
import { createInitialGraph, getActiveGraph, saveNewGraph } from '@/lib/orchestration/graph-pointer'
import { createEmptyGraph, type BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
import { reconcileGraphDrift, resolveWorkspaceTables } from '@/lib/services/workspace-schema-resolver'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

/** Run an executor action as a person in the dashboard; the governed change it made. */
async function asPerson(action: Record<string, unknown>) {
  const result: any = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    executeAction(action as any, projectId, undefined, 0, undefined, false))
  expect(result.success).toBe(true)
  expect(result.change?.status).toBe('healthy')
  return result.change as { id: string; seq: number }
}

const entity = (name: string, relationships: Array<{ from: string; to: string }> = []) => ({
  name,
  reason: 'reconciled_from_database',
  fields: {},
  relationships: relationships.map((r) => ({ ...r, type: 'one-to-many' as const, reason: `${r.to}.${r.from}_id`, createdBy: 'real-fk' })),
  createdAt: new Date().toISOString(),
  createdBy: 'system:schema-reconciler',
  dependencies: [],
})
const api = (path: string, entityName: string) => ({
  path, methods: ['GET'], requiresAuth: false, rateLimit: 100, reason: 'generated', createdBy: 'test', dependsOn: [entityName],
})

/** Saves a new version of the active graph, as every writer of it does. */
async function saveGraph(change: (graph: BackendStateGraph) => BackendStateGraph) {
  const active = await getActiveGraph(projectId)
  if (active) await saveNewGraph(projectId, change(active), undefined, { skipBillingCheck: true })
  else await createInitialGraph(projectId, change(createEmptyGraph(projectId)))
}

const versions = () =>
  prisma.backendGraph.findMany({ where: { projectId }, orderBy: { sequenceNumber: 'asc' }, select: { id: true, graphData: true } })
const listedTables = async () => (await resolveWorkspaceTables(projectId)).tables.map((t) => t.name)

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `graph-drop-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'dropped-table-leaves-the-graph', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

it('a drop takes the table out of the active graph as a new version, and leaves history as it was', async () => {
  await asPerson({ action: 'CREATE_TABLE', params: { tableName: 'products', columns: [{ name: 'name', type: 'text' }] } })
  await asPerson({ action: 'CREATE_TABLE', params: { tableName: 'reviews', columns: [{ name: 'rating', type: 'integer' }] } })

  // Versions after the empty first one and the two the creates recorded: one
  // with both tables, then the active one with more about them.
  await saveGraph((g) => ({ ...g, entities: { products: entity('products'), reviews: entity('reviews') } }))
  await saveGraph((g) => ({
    ...g,
    entities: { products: entity('products', [{ from: 'products', to: 'reviews' }]), reviews: entity('reviews') },
    apis: {
      '/products': api('/products', 'products'),
      '/reviews': api('/reviews', 'reviews'),
      '/reviews/:id': api('/reviews/:id', 'reviews'),
      '/reviews_archive': api('/reviews_archive', 'reviews_archive'),
    },
  }))
  const before = await versions()
  expect(await listedTables()).toEqual(['products', 'reviews'])

  // confirmed: as the drop runs once a person approves it.
  await asPerson({ action: 'DROP_TABLE', params: { tableName: 'reviews', confirmed: true } })

  expect(await listedTables()).toEqual(['products'])
  const active = (await getActiveGraph(projectId))!
  expect(Object.keys(active.entities)).toEqual(['products'])
  expect(active.entities.products.relationships).toEqual([])
  expect(Object.keys(active.apis).sort()).toEqual(['/products', '/reviews_archive'])

  // A new version, active; the ones before it unchanged.
  const after = await versions()
  expect(after.length).toBeGreaterThan(before.length)
  expect(after.slice(0, before.length)).toEqual(before)
  expect((await prisma.project.findUnique({ where: { id: projectId }, select: { activeGraphId: true } }))?.activeGraphId)
    .toBe(after[after.length - 1].id)
})

it('a table a restore removed is not listed, and the next reconciliation takes it out of the graph', async () => {
  const created = await asPerson({ action: 'CREATE_TABLE', params: { tableName: 'drafts', columns: [{ name: 'body', type: 'text' }] } })
  await saveGraph((g) => ({ ...g, entities: { ...g.entities, drafts: entity('drafts') } }))
  expect(await listedTables()).toContain('drafts')

  const outcome = await recoverChange(projectId, created.id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })
  expect(outcome).toMatchObject({ ok: true, status: 'restored' })

  const resolved = await resolveWorkspaceTables(projectId)
  expect(resolved.tables.map((t) => t.name)).not.toContain('drafts')
  expect(resolved.driftDetected).toBe(true)

  await reconcileGraphDrift(projectId)
  const entities = Object.keys((await getActiveGraph(projectId))!.entities)
  expect(entities).toContain('products')
  expect(entities).not.toContain('drafts')
})
