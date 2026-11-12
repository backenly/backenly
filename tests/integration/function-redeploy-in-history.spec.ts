/**
 * A REDEPLOY SAYS WHERE THE PREVIOUS CODE IS, AND IT IS THERE
 * ===========================================================
 *
 * Production QA (2026-11-09): every redeploy answered "The previous code is
 * not kept, so there is nothing to roll back to", while llms.txt says every
 * change to functions is one History entry you can restore. The history was
 * right: a redeploy is a governed change and keeps the code it replaced
 * (lib/changes/resources/functions.ts). The answer now names that change, and
 * restoring it brings the previous code back. Real ledger, real project.
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
import { withChangeAttribution } from '@/lib/changes/ledger'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
const original = { edition: process.env.BACKENLY_EDITION, engine: process.env.ENGINE_MODE }

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `redeploy-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'function-redeploy-in-history', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<{ nspname: string }[]>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = original.edition
  process.env.ENGINE_MODE = original.engine
}, 120_000)

const deploy = (code: string) =>
  withChangeAttribution({ source: 'mcp' }, () =>
    deployFunctionCode({ userId: ownerId, projectId }, { name: 'send-welcome', trigger: 'on_signup', code }))
const storedCode = async () =>
  (await prisma.aiFunction.findFirstOrThrow({ where: { projectId, name: 'send-welcome' }, select: { generatedCode: true } })).generatedCode

it('names the change that keeps the previous code, and restoring that change brings it back', async () => {
  expect((await deploy('return { version: 1 }')).ok).toBe(true)
  const second = await deploy('return { version: 2 }')
  expect(second.ok).toBe(true)
  expect(second.summary).not.toMatch(/not kept|nothing to roll back/)

  const change = (second.data as { change: { id: string; seq: number } }).change
  expect(change).toEqual({ id: expect.any(String), seq: expect.any(Number) })
  expect(second.summary).toContain(`The previous code is kept in the change history as change #${change.seq}`)
  expect(second.summary).toContain(`deploy { action: "revert_change", changeId: "${change.id}" }`)
  expect((await prisma.backendChange.findUniqueOrThrow({ where: { id: change.id } })).seq).toBe(change.seq)

  expect(await storedCode()).toBe('return { version: 2 }')
  expect(await recoverChange(projectId, change.id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })).toMatchObject({ ok: true })
  expect(await storedCode()).toBe('return { version: 1 }')
}, 120_000)

it('says so, and names no change, when the code it deploys is the code already there', async () => {
  const code = await storedCode()
  const again = await deploy(code)
  expect(again.ok).toBe(true)
  expect(again.summary).toContain('Its code was already this, so the code did not change')
  expect((again.data as { change: unknown }).change).toBeNull()
}, 120_000)
