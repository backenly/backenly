/**
 * A TABLE'S GENERATED ENDPOINTS FOLLOW IT THROUGH A RESTORE AND A REAPPLY
 * =======================================================================
 *
 * Creating a table registers the endpoints Backenly generates for it as
 * AiFunction rows (a validation schema for every table, and more for a jobs
 * table). Staging qualification found them outliving the table: after
 * "Restore the state before #N" removed the table, read_backend_state still
 * listed `<table>-schema`, a callable route over a table that was gone. The
 * ledger's restore put the table registry and its row-level-security rules back
 * and never these.
 *
 * Against a real database, through the executor:
 *   - a restore removes exactly the generated rows, and its record keeps them;
 *   - undoing that restore (a reapply) puts back exactly those rows: one
 *     switched off stays off, rewritten code is kept, and one the owner had
 *     deleted is not invented;
 *   - a restore of anything else (a drop) brings no generated endpoint back;
 *   - an automatic recovery removes them as a restore does;
 *   - code an agent deployed over a generated name, the project's own
 *     functions, and a name another remaining table still generates are never
 *     touched.
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
import { withGovernedChange } from '@/lib/changes/ledger'
import { generatedEndpointsFollow, recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { executeAction } from '@/lib/ai/minimal-executor'
import { registerDomainEndpoints, removeDomainEndpoints } from '@/lib/services/domain-endpoints'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function tableExists(table: string): Promise<boolean> {
  const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
    schema,
    table,
  )
  return r[0].n > 0
}

const functions = () => prisma.aiFunction.findMany({ where: { projectId }, orderBy: { name: 'asc' } })
const named = async (name: string) => (await functions()).find((f) => f.name === name)

/** Run an executor action as a person in the dashboard; the governed change it made. */
async function asPerson(action: Record<string, unknown>) {
  const result: any = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    executeAction(action as any, projectId, undefined, 0, undefined, false))
  expect(result.success).toBe(true)
  expect(result.change?.status).toBe('healthy')
  return result.change as { id: string; seq: number }
}

const restore = (id: string) => recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `endpoints-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'restore-generated-endpoints', userId: ownerId })
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

describe('a restore and its reapply', () => {
  let createdId: string
  let restoreId: string
  /** The generated rows as the restore found them. */
  let before: Map<string, Awaited<ReturnType<typeof functions>>[number]>

  it('creating a jobs table generates its endpoints, in the same change', async () => {
    createdId = (await asPerson({ action: 'CREATE_TABLE', params: { tableName: 'jobs', columns: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }] } })).id
    const names = (await functions()).map((f) => f.name)
    for (const n of ['jobs-schema', 'jobs-create', 'jobs-cancel', 'jobs-retry', 'jobs-progress']) expect(names).toContain(n)

    // What happens to them before the restore, each a case the restore must respect.
    await prisma.aiFunction.updateMany({
      where: { projectId, name: 'jobs-cancel' },
      data: { codeOrigin: 'agent', generatedCode: 'export default async function cancel() { return "the agent wrote this" }' },
    })
    await prisma.aiFunction.updateMany({ where: { projectId, name: 'jobs-retry' }, data: { status: 'inactive' } })
    await prisma.aiFunction.updateMany({
      where: { projectId, name: 'jobs-progress' },
      data: { generatedCode: 'export default async function progress() { return "rewritten in place" }' },
    })
    await prisma.aiFunction.deleteMany({ where: { projectId, name: 'jobs-create' } })
    await prisma.aiFunction.create({
      data: { projectId, name: 'weekly-report', description: 'the owner made this', generatedCode: 'export default async function () {}', triggerType: 'cron', triggerTable: '0 9 * * 1', codeOrigin: 'agent' },
    })
    before = new Map((await functions()).map((f) => [f.name, f]))
  }, 120_000)

  it('the restore removes the table and the endpoints generated for it, and its record keeps them', async () => {
    const out = await restore(createdId)
    expect(out.ok).toBe(true)
    restoreId = (out as any).recoveryId
    expect(await tableExists('jobs')).toBe(false)

    const left = (await functions()).map((f) => f.name)
    expect(left.filter((n) => n.startsWith('jobs-'))).toEqual(['jobs-cancel'])
    expect((await named('jobs-cancel'))?.generatedCode).toMatch(/the agent wrote this/)
    expect(left).toContain('weekly-report')

    const kept = await prisma.backendChangeEvent.findMany({ where: { changeId: restoreId, type: 'generated_endpoints_removed' } })
    expect(kept).toHaveLength(1)
    expect(((kept[0].data as any).functions as Array<{ name: string }>).map((f) => f.name).sort()).toEqual(['jobs-progress', 'jobs-retry', 'jobs-schema'])
  }, 120_000)

  it('the reapply puts back exactly what the restore removed, and nothing else', async () => {
    const out = await restore(restoreId)
    expect(out.ok).toBe(true)
    expect(await tableExists('jobs')).toBe(true)

    for (const name of ['jobs-schema', 'jobs-retry', 'jobs-progress']) {
      const row = await named(name)
      const was = before.get(name)!
      expect(row).toMatchObject({
        id: was.id,
        generatedCode: was.generatedCode,
        codeOrigin: 'generated',
        triggerType: was.triggerType,
        triggerTable: was.triggerTable,
        status: was.status,
      })
    }
    // Switched off before the restore, so still off: the runtime refuses it.
    expect((await named('jobs-retry'))?.status).toBe('inactive')
    // Rewritten in place, so the rewrite comes back, not the template.
    expect((await named('jobs-progress'))?.generatedCode).toMatch(/rewritten in place/)
    // Deleted by its owner before the restore, so not invented by the reapply.
    expect(await named('jobs-create')).toBeUndefined()
    expect((await named('jobs-cancel'))?.generatedCode).toMatch(/the agent wrote this/)
    expect(await named('weekly-report')).toBeDefined()
  }, 120_000)
})

describe('a restore of anything else', () => {
  it('brings no generated endpoint back: restoring a drop leaves a deleted one deleted', async () => {
    await asPerson({ action: 'CREATE_TABLE', params: { tableName: 'notes', columns: [{ name: 'body', type: 'text' }] } })
    expect(await named('notes-schema')).toBeDefined()
    await prisma.aiFunction.deleteMany({ where: { projectId, name: 'notes-schema' } })

    const dropped = await asPerson({ action: 'DROP_TABLE', params: { tableName: 'notes', confirmed: true } })
    expect(await tableExists('notes')).toBe(false)
    const out = await restore(dropped.id)
    expect(out.ok).toBe(true)
    expect(await tableExists('notes')).toBe(true)
    expect(await named('notes-schema')).toBeUndefined()
  }, 120_000)
})

describe('an automatic recovery', () => {
  it('removes the endpoints generated for a table it removed, as a restore does', async () => {
    const T = `"${schema}"."renders_log"`
    await expect(
      withChangeAttribution({ source: 'mcp' }, () =>
        withGovernedChange({ projectId, title: 'a table, then a step that cannot apply' }, async () => {
          const created: any = await executeAction(
            { action: 'CREATE_TABLE', params: { tableName: 'renders_log', columns: [{ name: 'body', type: 'text' }] } } as any,
            projectId, undefined, 0, undefined, false,
          )
          expect(created.success).toBe(true)
          await prisma.$executeRawUnsafe(`ALTER TABLE ${T} ADD COLUMN broken nosuchtype`)
        })),
    ).rejects.toThrow(/nosuchtype/)

    const failed = await prisma.backendChange.findFirstOrThrow({ where: { projectId, title: 'a table, then a step that cannot apply' } })
    expect(failed.status).toBe('recovered')
    expect(await tableExists('renders_log')).toBe(false)
    expect((await functions()).filter((f) => f.name.startsWith('renders_log-'))).toEqual([])

    const recovery = await prisma.backendChange.findFirstOrThrow({ where: { projectId, kind: 'recovery', recoversId: failed.id } })
    const kept = await prisma.backendChangeEvent.findMany({ where: { changeId: recovery.id, type: 'generated_endpoints_removed' } })
    expect(((kept[0]?.data as any)?.functions ?? []).map((f: { name: string }) => f.name)).toContain('renders_log-schema')
  }, 120_000)
})

describe('removing the endpoints of a table that is gone', () => {
  it('keeps a name that a remaining table also generates', async () => {
    // Every auth table generates the same auth endpoints.
    await registerDomainEndpoints(projectId, 'users', ['users', 'accounts'])
    await registerDomainEndpoints(projectId, 'accounts', ['users', 'accounts'])
    const shared = (await functions()).filter((f) => f.name.startsWith('auth-')).map((f) => f.name)
    expect(shared.length).toBeGreaterThan(0)

    const removed = (await removeDomainEndpoints(projectId, ['accounts'], ['users'])).map((r) => r.name)
    expect(removed).toContain('accounts-schema')
    expect(removed.filter((n) => n.startsWith('auth-'))).toEqual([])

    const left = (await functions()).map((f) => f.name)
    for (const name of shared) expect(left).toContain(name)
    expect(left).toContain('users-schema')
    expect(left).not.toContain('accounts-schema')
  }, 60_000)
})

describe('removing them only where a copy is kept, and only what is still generated', () => {
  it('removes nothing when the copy cannot be kept', async () => {
    await registerDomainEndpoints(projectId, 'widgets', ['widgets'])
    await expect(
      removeDomainEndpoints(projectId, ['widgets'], [], async () => { throw new Error('the record could not be written') }),
    ).rejects.toThrow(/could not be written/)
    expect((await functions()).map((f) => f.name)).toContain('widgets-schema')
  }, 60_000)

  it('leaves the code an agent deployed over a generated row while it was being removed', async () => {
    await registerDomainEndpoints(projectId, 'gadgets', ['gadgets'])
    await removeDomainEndpoints(projectId, ['gadgets'], [], async () => {
      // Between the selection and the delete, as an agent's deploy can land.
      await prisma.aiFunction.updateMany({
        where: { projectId, name: 'gadgets-schema' },
        data: { codeOrigin: 'agent', generatedCode: 'export default async function () { return "deployed meanwhile" }' },
      })
    })
    expect((await named('gadgets-schema'))?.generatedCode).toMatch(/deployed meanwhile/)
  }, 60_000)

  it('leaves the endpoints of a removed table where no restore record can keep them', async () => {
    await registerDomainEndpoints(projectId, 'sprockets', ['sprockets'])
    await generatedEndpointsFollow(
      projectId,
      { id: crypto.randomUUID(), kind: 'change', footprint: [{ kind: 'added', before: null, after: 'sprockets', details: [] }], resultState: { tables: { sprockets: {} } } as any },
      { tables: {} } as any,
      null,
    )
    expect((await functions()).map((f) => f.name)).toContain('sprockets-schema')
  }, 60_000)
})
