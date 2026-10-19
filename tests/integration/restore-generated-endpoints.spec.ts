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
 * Against a real database, through the executor: the restore removes exactly
 * the generated rows, the reapply generates them again, and a row an agent
 * deployed over a generated name, an unrelated function, and a name another
 * remaining table still generates are never touched.
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

const functions = () =>
  prisma.aiFunction.findMany({
    where: { projectId },
    select: { name: true, codeOrigin: true, generatedCode: true, triggerTable: true },
    orderBy: { name: 'asc' },
  })

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

describe('a restore and a reapply keep generated endpoints in step with the tables', () => {
  let createdId: string
  let restoreId: string
  let generated: string[]

  it('creating a jobs table generates its endpoints, in the same change', async () => {
    const result: any = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      executeAction(
        { action: 'CREATE_TABLE', params: { tableName: 'jobs', columns: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }] } } as any,
        projectId, undefined, 0, undefined, false,
      ))
    expect(result.success).toBe(true)
    expect(result.change?.status).toBe('healthy')
    createdId = result.change.id

    generated = (await functions()).filter((f) => f.name.startsWith('jobs-')).map((f) => f.name)
    expect(generated).toContain('jobs-schema')
    expect(generated).toContain('jobs-cancel')

    // An agent redeployed one generated name with its own code, and the project
    // has a function of its own. Neither is Backenly's to remove.
    await prisma.aiFunction.updateMany({
      where: { projectId, name: 'jobs-cancel' },
      data: { codeOrigin: 'agent', generatedCode: 'export default async function cancel() { return "the agent wrote this" }' },
    })
    await prisma.aiFunction.create({
      data: { projectId, name: 'weekly-report', description: 'the owner made this', generatedCode: 'export default async function () {}', triggerType: 'cron', triggerTable: '0 9 * * 1', codeOrigin: 'agent' },
    })
  }, 120_000)

  it('the restore removes the table and the endpoints generated for it', async () => {
    const out = await recoverChange(projectId, createdId, { mode: 'manual', actorUserId: ownerId, acknowledged: null })
    expect(out.ok).toBe(true)
    restoreId = (out as any).recoveryId
    expect(await tableExists('jobs')).toBe(false)

    const left = await functions()
    const generatedLeft = left.filter((f) => f.name.startsWith('jobs-') && f.codeOrigin === 'generated')
    expect(generatedLeft).toEqual([])
    // Kept: the agent's code over a generated name, and the project's own function.
    expect(left.find((f) => f.name === 'jobs-cancel')?.generatedCode).toMatch(/the agent wrote this/)
    expect(left.find((f) => f.name === 'weekly-report')).toBeDefined()
  }, 120_000)

  it('the reapply brings the table back with its generated endpoints, and leaves the agent code as it was', async () => {
    const out = await recoverChange(projectId, restoreId, { mode: 'manual', actorUserId: ownerId, acknowledged: null })
    expect(out.ok).toBe(true)
    expect(await tableExists('jobs')).toBe(true)

    const back = await functions()
    for (const name of generated.filter((n) => n !== 'jobs-cancel')) {
      const row = back.find((f) => f.name === name)
      expect(row).toBeDefined()
      expect(row!.codeOrigin).toBe('generated')
      expect(row!.triggerTable).toMatch(new RegExp(`^[A-Z]+ /api/v1/${projectId}/fn/${name}$`))
    }
    expect(back.find((f) => f.name === 'jobs-cancel')?.generatedCode).toMatch(/the agent wrote this/)
    expect(back.find((f) => f.name === 'weekly-report')).toBeDefined()
  }, 120_000)
})

describe('removing the endpoints of a table that is gone', () => {
  it('keeps a name that a remaining table also generates', async () => {
    // Every auth table generates the same auth endpoints.
    await registerDomainEndpoints(projectId, 'users', ['users', 'accounts'], { replace: false })
    await registerDomainEndpoints(projectId, 'accounts', ['users', 'accounts'], { replace: false })
    const shared = (await functions()).filter((f) => f.name.startsWith('auth-')).map((f) => f.name)
    expect(shared.length).toBeGreaterThan(0)

    const removed = await removeDomainEndpoints(projectId, ['accounts'], ['users'])
    expect(removed).toContain('accounts-schema')
    expect(removed.filter((n) => n.startsWith('auth-'))).toEqual([])

    const left = (await functions()).map((f) => f.name)
    for (const name of shared) expect(left).toContain(name)
    expect(left).toContain('users-schema')
    expect(left).not.toContain('accounts-schema')
  }, 60_000)
})
