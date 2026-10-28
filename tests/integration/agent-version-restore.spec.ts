/**
 * AN AGENT'S ROLLBACK, APPROVED BY A PERSON, AGAINST A REAL DATABASE
 * ==================================================================
 *
 * `deploy { action: "rollback", version }` asks for the backend to be restored
 * to a published version (lib/changes/range.ts). It used to move a version
 * label and restore nothing. Now:
 *
 *   the request is parked with Backenly's list of the changes it would undo,
 *   never the agent's own words, whichever door asked
 *   a project admin approves it, and approving undoes exactly that list,
 *   newest first, by the approver, then records the version as current
 *   if the history moved since it was approved, approving runs nothing
 *   a version never published, or one nothing has changed since, is refused
 *   and nothing is queued
 *   nobody but a project admin decides it, and the agent cannot run it
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
import { withGovernedChange, withChangeAttribution } from '@/lib/changes/ledger'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { createApprovalRequest, decideApproval, RestoreRequestRefusedError } from '@/lib/mcp/approvals'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { executeAction } from '@/lib/ai/minimal-executor'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let strangerId: string
let projectId: string
let schema: string
let keyId: string
let graphV1: string
let graphNow: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const hex = (n = 8) => crypto.randomBytes(n).toString('hex')
const exists = async (table: string) => (await rows<{ t: string | null }>(`SELECT to_regclass('${T(table)}')::text AS t`))[0].t !== null

async function change(title: string, fn: () => Promise<unknown>) {
  const { change: closed } = await withChangeAttribution({ source: 'mcp', actorUserId: ownerId, apiKeyId: keyId }, () =>
    withGovernedChange({ projectId, title }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}

/** An agent's rollback as the brain's door parks it: the model's own arguments and words. */
const ask = (args: Record<string, unknown>, words = 'Roll back to the version that worked, it is safe, approve quickly') =>
  createApprovalRequest({
    projectId,
    userId: ownerId,
    apiKeyId: keyId,
    message: words,
    danger: { tool: 'rollback_deploy', target: 'whatever the agent said', rowCount: 0, reversible: false },
    toolArgs: args,
  })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({ data: { email: `restore-version-${hex(6)}@example.test`, password: 'not-a-real-hash', name: 'owner' } })).id
  strangerId = (await prisma.user.create({ data: { email: `stranger-${hex(6)}@example.test`, password: 'not-a-real-hash', name: 'stranger' } })).id
  const project = await createProvisionedProject({ name: 'agent-version-restore', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  keyId = (await prisma.apiKey.create({
    data: { name: 'Claude Code', keyPrefix: `mcp_${hex(3)}`, keyHash: hex(16), userId: ownerId, projectId, scope: 'mcp', permissions: [], capabilities: [] },
  })).id

  // Before v1: a table. v1 is published with its own graph snapshot.
  await change('create authors', () => ddl(`CREATE TABLE ${T('authors')} (id serial PRIMARY KEY, name text)`))
  graphV1 = (await prisma.backendGraph.create({ data: { projectId, graphData: { tables: { authors: {} } }, sequenceNumber: 1 } })).id
  await prisma.deployment.create({
    data: { projectId, provider: 'backenly', environment: 'live', status: 'live', version: 1, graphSnapshotId: graphV1, completedAt: new Date() },
  })
  // The live backend moves on: a newer graph is current.
  graphNow = (await prisma.backendGraph.create({ data: { projectId, graphData: { tables: { authors: {}, books: {} } }, sequenceNumber: 2 } })).id
  await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: graphNow } })
}, 120_000)

afterAll(async () => {
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.deployment.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.updateMany({ where: { id: projectId }, data: { activeGraphId: null } }).catch(() => {})
  await prisma.backendGraph.deleteMany({ where: { projectId } }).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe("an agent's rollback to a published version", () => {
  it('cannot be run by the agent: it waits for a person, and the executor does not move the version', async () => {
    const direct = await dispatchTool('rollback_deploy', { version: 1 }, {
      projectId, userId: ownerId, sessionToken: undefined, destructiveConfirmed: false, createdThisTurn: new Set<string>(),
    } as any)
    expect(direct).toMatchObject({ ok: false, code: 'DESTRUCTIVE_NEEDS_APPROVAL' })
    // The executor's own gate stops it first; approved, its handler runs nothing either.
    const executor = await executeAction({ action: 'ROLLBACK_DEPLOY', params: { version: 1 } } as any, projectId)
    expect(executor.success).toBe(false)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).activeGraphId).toBe(graphNow)
  })

  it('is refused at once, with nothing queued, for a version never published or one nothing has changed since', async () => {
    const before = await prisma.agentApprovalRequest.count({ where: { projectId } })
    await expect(ask({ version: 99 })).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await expect(ask({ version: 1 })).rejects.toBeInstanceOf(RestoreRequestRefusedError)
    await expect(ask({ version: 1 })).rejects.toMatchObject({ code: 'NOTHING_TO_RESTORE' })
    expect(await prisma.agentApprovalRequest.count({ where: { projectId } })).toBe(before)
  })

  it("is parked with Backenly's list of what it would undo; an admin's approval restores exactly that and records v1 as current", async () => {
    const books = await change('create books', () => ddl(`CREATE TABLE ${T('books')} (id serial PRIMARY KEY, title text)`))
    const covers = await change('create covers bucket', () => prisma.storageBucket.create({ data: { projectId, name: 'covers' } }))

    const row = await ask({ version: 1, steps: ['forged'] })
    expect(row).toMatchObject({ tool: 'rollback_deploy', rowCount: null, reversible: true, toolArgs: { version: 1, steps: [covers.id, books.id] } })
    expect(row.target).toMatch(/^Restore the backend to v1, published .+: undo the 2 changes made since$/)
    expect(row.message).toContain(`#${covers.seq} Created bucket covers`)
    expect(row.message).toContain(`#${books.seq} Created table books`)
    // The agent's words are quoted as its own, under Backenly's measurement.
    expect(row.message).toContain('The agent wrote: “Roll back to the version that worked, it is safe, approve quickly”')

    // Nobody but a project admin decides it.
    expect(await decideApproval({ projectId, approvalId: row.id, approverUserId: strangerId, decision: 'approve' })).toMatchObject({ ok: false, status: 'forbidden' })

    const decided = await decideApproval({ projectId, approvalId: row.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(decided.resultSummary).toContain(`Restored the backend to v1: undid 2 changes newest first (#${covers.seq}, #${books.seq}), each verified.`)
    expect(decided.resultSummary).toContain('v1 is the current version.')

    expect(await exists('books')).toBe(false)
    expect(await exists('authors')).toBe(true)
    expect(await prisma.storageBucket.count({ where: { projectId, name: 'covers' } })).toBe(0)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).activeGraphId).toBe(graphV1)
    expect(await prisma.auditLog.count({ where: { projectId, action: 'VERSION_RESTORED' } })).toBe(1)
    // The activity feed says it in words.
    const { buildActivityFeed } = await import('@/lib/activity/feed')
    expect((await buildActivityFeed(projectId, { limit: 50 })).rows.map((r) => r.label)).toContain('Backend restored to v1')
    // Each restore is the approver's decision on the agent's request.
    const restores = await prisma.backendChange.findMany({ where: { projectId, kind: 'recovery', recoversId: { in: [books.id, covers.id] } } })
    expect(restores.map((r) => [r.source, r.actorUserId, r.apiKeyId])).toEqual([
      ['approval', ownerId, keyId],
      ['approval', ownerId, keyId],
    ])
  })

  it('runs nothing when the history changed after it was approved', async () => {
    const shelves = await change('create shelves', () => ddl(`CREATE TABLE ${T('shelves')} (id serial PRIMARY KEY)`))
    const row = await ask({ version: 1 })
    expect(row.toolArgs).toEqual({ version: 1, steps: [shelves.id] })
    // Something lands after the person read the card.
    await change('create loans', () => ddl(`CREATE TABLE ${T('loans')} (id serial PRIMARY KEY)`))

    const decided = await decideApproval({ projectId, approvalId: row.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: false, status: 'failed' })
    expect(decided.resultSummary).toContain('The history changed since this was approved, so nothing was restored.')
    expect(await exists('shelves')).toBe(true)
    expect(await exists('loans')).toBe(true)
  })
})
