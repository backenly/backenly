/**
 * THE ACTIVE-BRANCH LIMIT HOLDS, AND IS SAID AS A LIMIT
 * =====================================================
 *
 * Production QA (2026-11-09): an agent ended up with six branches on a project
 * allowed five. createBranch counted the active branches, cloned the schema,
 * and only then wrote the branch's row, so two creates that arrived together
 * both counted four and both went through. And the agent's list_branches said
 * "Preview branches (6)" when five were active and one merged, which reads as a
 * project past its limit.
 *
 * Against a real database and the real branch engine; only PostgREST's schema
 * registry is stubbed, as in branch-migrations.spec.ts.
 */
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX' }) }
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

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { createBranch } from '@/lib/branches/engine'

let ownerId: string
let projectId: string
let mainSchema: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `branch-limit-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'branch-limit', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
  // Something to clone, so a branch takes the time a real one does.
  const made = await dispatchTool('create_table', {
    tableName: 'orders',
    columns: [{ name: 'total', type: 'integer' }],
  }, { projectId, userId: ownerId, createdThisTurn: new Set<string>() })
  if (!made.ok) throw new Error(`setup create_table failed: ${made.summary}`)
}, 180_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await import('@/lib/branches/create-lock').then((m) => m.closeBranchCreateLockPool()).catch(() => {})
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

const active = () => prisma.workspaceBranch.count({ where: { projectId, status: 'active' } })

it('two creates that arrive together cannot take a project past its limit', async () => {
  for (const name of ['one', 'two', 'three', 'four']) {
    const made = await createBranch(projectId, ownerId, name)
    if (!made.ok) throw new Error((made as { error: string }).error)
  }
  const both = await Promise.all([createBranch(projectId, ownerId, 'five'), createBranch(projectId, ownerId, 'six')])
  expect(both.filter((r) => r.ok)).toHaveLength(1)
  expect((both.find((r) => !r.ok) as { error: string }).error).toBe('Branch limit reached (5 active) — merge or discard one first.')
  expect(await active()).toBe(5)
}, 180_000)

it('the agent’s list counts active branches against the limit, and merged ones apart', async () => {
  // A branch merged earlier, as a merge leaves it: closed, its schema gone.
  await prisma.workspaceBranch.create({
    data: {
      projectId, name: 'shipped', schemaName: `${mainSchema}_br_shipped`, status: 'merged', createdBy: ownerId, mergedAt: new Date(),
    },
  })
  const listed = await dispatchTool('list_branches', {}, { projectId, userId: ownerId, createdThisTurn: new Set<string>() })
  expect(listed.ok).toBe(true)
  const [head, ...lines] = listed.summary.split('\n')
  expect(head).toBe('**Preview branches:** 5 of 5 active, 1 merged.')
  // Active first, so the five that count against the limit read as the five.
  expect(lines.slice(0, 5).every((l) => l.includes('(active)'))).toBe(true)
  expect(lines[5]).toContain('shipped (merged)')
}, 60_000)
