/**
 * THE RECEIPTS SAY WHICH DELETE KEEPS A ROW
 * =========================================
 *
 * Production QA (#22, re-tested 2026-11-16): create_table's receipt said every
 * table's "deleted_at" is set by "a client DELETE". Only one door does that:
 * the SDK's delete(), which posts to /api/v1/{projectId}/database/delete and
 * sets deleted_at on a table that has it. A DELETE on /db goes to PostgREST as
 * a real DELETE (server/routes/postgrest-handler.ts), so does one on /api/v2,
 * and bkn_pgrst_soft_delete is only a filter on reads. An agent that wrote a
 * client against /db, trusting the receipt, removed rows it believed it could
 * get back.
 *
 * Read here as an agent reads them, on a real provisioned project: the
 * create_table receipt, the note on a UNIQUE index scoped to live rows, the
 * note on a UNIQUE constraint over every row, and the runtime API guide.
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
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { forgetProtection } from '@/lib/branches/protection'
import { executeAction } from '@/lib/ai/minimal-executor'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const asPerson = <R>(fn: () => Promise<R>) => withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, fn)
const migrate = (sql: string) =>
  asPerson(() => applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }))

/** What the old receipts said, which only the SDK's delete() does. */
const WRONG = /a client DELETE/i

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `delete-doors-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'receipts-say-what-delete-does', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  forgetProtection(projectId)
}, 180_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('what an agent is told a delete does', () => {
  it('create_table says the SDK’s delete() sets deleted_at and a DELETE on /db or /api/v2 removes the row', async () => {
    const out = await migrate('CREATE TABLE notes (body text NOT NULL)')
    expect(out).toMatchObject({ ok: true })
    const receipt = (out as any).applied[0].summary as string
    expect(receipt).toContain('"deleted_at" (set by the SDK\'s delete(); a DELETE on /db or /api/v2 removes the row)')
    expect(receipt).not.toMatch(WRONG)
  }, 120_000)

  it('a UNIQUE index scoped to live rows says which delete keeps a row', async () => {
    const out = await asPerson(() =>
      executeAction({ action: 'CREATE_INDEX', params: { tableName: 'notes', columns: ['body'], unique: true } } as any, projectId, undefined, 0, undefined, false),
    )
    expect(out).toMatchObject({ success: true, data: { softDeleteScoped: true } })
    expect(out.message).toContain('the SDK\'s delete() sets `deleted_at` and keeps the row (a DELETE on /db or /api/v2 removes it)')
    expect(out.message).not.toMatch(WRONG)
  }, 120_000)

  it('a UNIQUE constraint over every row says which delete keeps its value taken', async () => {
    const out = await migrate('ALTER TABLE notes ADD CONSTRAINT notes_body_every_row UNIQUE (body)')
    expect(out).toMatchObject({ ok: true })
    const receipt = (out as any).applied[0].summary as string
    expect(receipt).toContain('the SDK\'s delete() on notes sets "deleted_at" and keeps the row, so its value stays taken')
    expect(receipt).toContain('a DELETE on /db or /api/v2 removes the row and frees it')
    expect(receipt).not.toMatch(WRONG)
  }, 120_000)

  it('the runtime API guide says what DELETE on /db does', async () => {
    const guide = await dispatchTool('get_instructions', {}, { projectId, userId: ownerId, createdThisTurn: new Set<string>() })
    expect(guide.ok).toBe(true)
    expect(guide.summary).toContain('`DELETE /db/<table>/<id>` removes the row, as a DELETE on `/api/v2` does; the SDK\'s `delete()` sets `"deleted_at"` and keeps the row')
  }, 60_000)
})
