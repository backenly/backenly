/**
 * DELETING A PROJECT WITH A CHANGE HISTORY, A VAULT AND A PREVIEW BRANCH
 * =====================================================================
 * The change ledger's guard (prisma/migrations-canonical/20261018120000_backend_change_ledger)
 * refuses deleting or rewriting a change's evidence and its events, except
 * together with the project. Every suite that made changes cleaned up with
 * `.catch(() => {})`, so none showed that a project with a history can still
 * be deleted with the guard installed as production has it. This suite does,
 * on a project that has:
 *
 *   changes   a governed change and the restore of it, with their events
 *   a vault   the restore moved the table it removed into workspace_<id>_r<seq>
 *   a branch  a preview branch and its own schema
 *
 * Before the deletion the guard refuses deleting the history on its own; then
 * deleteProjectCompletely removes the project, every change and event, the
 * vault and the branch, and leaves no schema in the project's namespace.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER', logRetentionDays: 30 }) }
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
import { createBranch } from '@/lib/branches/engine'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { deleteProjectCompletely } from '@/lib/projects/delete'
import { createProvisionedProject } from '@/lib/projects/provision'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

jest.setTimeout(180_000)

let ownerId = ''
let projectId = ''
let schema = ''
let deleted = false

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const rows = <R = any>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<R[]>(sql, ...params)

/** Every schema in the project's namespace: its own, its vaults and its branches. */
const namespace = async () =>
  (await rows<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname = $1 OR left(nspname, length($2)) = $2 ORDER BY nspname`,
    `workspace_${projectId}`,
    `workspace_${projectId}_`,
  )).map((r) => r.nspname)

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph that runs no DDL;
  // the ledger records nothing in that mode.
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()

  ownerId = (
    await prisma.user.create({
      data: { email: `delete-ledger-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Delete Fixture' },
    })
  ).id
  const project = await createProvisionedProject({ name: 'delete-with-history', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 180_000)

afterAll(async () => {
  // Only if the deletion under test did not run or did not finish.
  if (!deleted && projectId) {
    for (const s of await namespace().catch(() => [] as string[])) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
})

it('deletes a project with changes, a vault and a branch, under the ledger guard', async () => {
  // A governed change that made a table, and rows in it.
  const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title: 'create ledgered' }, async () => {
      const db = await workspaceRawClient(projectId)
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".ledgered (id serial PRIMARY KEY, note text)`)
    }),
  )
  expect(change).toMatchObject({ status: 'healthy' })
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".ledgered (note) VALUES ('kept'), ('also kept')`)

  // Its restore: the table it made goes into the restore's vault, rows and all,
  // once the person acknowledges the rows it moves, as the dashboard asks.
  const preview = await previewRecovery(projectId, change!.id)
  expect(preview?.acknowledgement).toBeTruthy()
  const restored = await recoverChange(projectId, change!.id, { mode: 'manual', actorUserId: ownerId, acknowledged: preview!.acknowledgement })
  expect(restored).toMatchObject({ ok: true, status: 'restored' })
  const vault = `workspace_${projectId}_r${(restored as { recoverySeq: number }).recoverySeq}`

  // A preview branch with its own schema.
  const branch = await createBranch(projectId, ownerId, 'doomed')
  expect(branch).toMatchObject({ ok: true })

  const changes = await prisma.backendChange.count({ where: { projectId } })
  const events = await prisma.backendChangeEvent.count({ where: { projectId } })
  expect(changes).toBe(2)
  expect(events).toBeGreaterThanOrEqual(6)
  const before = await namespace()
  expect(before).toEqual(expect.arrayContaining([schema, vault]))
  expect(before.filter((s) => s !== schema && s !== vault)).toHaveLength(1)

  // The guard is on: the history cannot be deleted on its own.
  await expect(prisma.backendChangeEvent.deleteMany({ where: { projectId } })).rejects.toThrow()
  await expect(prisma.backendChange.deleteMany({ where: { projectId } })).rejects.toThrow()
  expect(await prisma.backendChange.count({ where: { projectId } })).toBe(changes)
  expect(await prisma.backendChangeEvent.count({ where: { projectId } })).toBe(events)

  // With the project, all of it goes.
  const result = await deleteProjectCompletely(projectId)
  deleted = true
  expect([...result.schemasDropped].sort()).toEqual([...before].sort())

  expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
  expect(await prisma.backendChange.count({ where: { projectId } })).toBe(0)
  expect(await prisma.backendChangeEvent.count({ where: { projectId } })).toBe(0)
  expect(await prisma.workspaceBranch.count({ where: { projectId } })).toBe(0)
  expect(await namespace()).toEqual([])
})
