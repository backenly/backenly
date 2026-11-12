/**
 * A PREVIEW KEY ENDS WITH ITS BRANCH
 * ==================================
 *
 * Production QA (2026-11-09): after one session, five preview keys of
 * discarded branches were still listed as live client keys, expiring in
 * February 2027. The runtime already refused them (BRANCH_INACTIVE); every
 * list said otherwise, because a key kept the 90-day expiry it was minted with.
 *
 * Against a real database and the real branch engine (PostgREST registration
 * stubbed, as in branch-migrations.spec.ts): merging or discarding a branch
 * ends its keys, no other key is touched, and the agent's key list says which
 * keys ended with their branch.
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
import { executeAction } from '@/lib/ai/minimal-executor'
import { createBranch, discardBranch, mergeBranch } from '@/lib/branches/engine'
import { mintPreviewKey } from '@/lib/branches/preview'

let ownerId: string
let projectId: string
let mainSchema: string
let mainKeyId: string
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `branch-keys-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'closed-branch-keys', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
  // A key on main, with its own expiry, which closing a branch must not touch.
  mainKeyId = (await prisma.apiKey.create({
    data: {
      name: 'web app', keyPrefix: `proj_live_${crypto.randomBytes(3).toString('hex')}`, keyHash: crypto.randomBytes(32).toString('hex'),
      userId: ownerId, projectId, keyType: 'public', permissions: ['read'], capabilities: [],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  })).id
}, 180_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 180_000)

/** A branch with a preview key, as an agent makes them. */
async function branchWithKey(name: string) {
  const made = await createBranch(projectId, ownerId, name)
  if (!made.ok) throw new Error((made as { error: string }).error)
  const branchId = (made as any).branch.id as string
  const key = await mintPreviewKey(projectId, branchId)
  if (!key.ok) throw new Error('could not mint a preview key')
  const keyId = (key as any).minted.keyId as string
  const before = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId }, select: { expiresAt: true } })
  expect(before.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000)
  return { branchId, keyId }
}

const expiry = async (id: string) => (await prisma.apiKey.findUniqueOrThrow({ where: { id }, select: { expiresAt: true } })).expiresAt

it('discarding a branch ends its keys', async () => {
  const { branchId, keyId } = await branchWithKey('scratch')
  expect((await discardBranch(projectId, ownerId, branchId)).ok).toBe(true)
  expect((await expiry(keyId))!.getTime()).toBeLessThanOrEqual(Date.now())
}, 120_000)

it('merging a branch ends its keys', async () => {
  const { branchId, keyId } = await branchWithKey('ready')
  const merged = await mergeBranch(projectId, ownerId, branchId)
  expect(merged.ok).toBe(true)
  expect(await prisma.workspaceBranch.findUniqueOrThrow({ where: { id: branchId }, select: { status: true } })).toEqual({ status: 'merged' })
  expect((await expiry(keyId))!.getTime()).toBeLessThanOrEqual(Date.now())
}, 120_000)

it('CONTROL: a key on main keeps its own expiry', async () => {
  expect((await expiry(mainKeyId))!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
})

it('the agent’s key list says which keys ended with their branch', async () => {
  const listed: any = await executeAction({ action: 'LIST_KEYS', params: {} } as any, projectId)
  expect(listed.success).toBe(true)
  expect(listed.message).toContain('· ended with branch scratch (discarded)')
  expect(listed.message).toContain('· ended with branch ready (merged)')
  expect(listed.message).toMatch(/\*\*web app\*\*[^\n]*\(never used\)\n|\*\*web app\*\*[^\n]*\(never used\)$/)
})
