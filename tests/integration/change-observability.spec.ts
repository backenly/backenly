/**
 * A GOVERNED CHANGE CAN BE FOLLOWED IN THE LOGS, AND ONE THAT NEEDS A PERSON SAYS SO
 * =================================================================================
 *
 * Every change metric names the project, the region holding its data, the
 * change, and for a recovery how it ran, and never a row's data. A change that
 * needs a person writes one line in a fixed form an operator's log alarm can
 * match (BACKENLY_CHANGE_NEEDS_PERSON), with ids only. Against a real database.
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
import { metrics } from '@/lib/observability/metrics'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { recordEvent } from '@/lib/changes/lifecycle'
import { keepChange, reconcileChange } from '@/lib/changes/recovery'
import { closeChangeLockPool, readCatalogOn, withChangeLock } from '@/lib/changes/lock'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
let regionalId: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const recorded = jest.spyOn(metrics, 'record')

function labelsOf(metric: string, changeId: string): Record<string, string>[] {
  return recorded.mock.calls
    .filter(([name, , labels]) => name === metric && (labels as Record<string, string> | undefined)?.changeId === changeId)
    .map(([, , labels]) => labels as Record<string, string>)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `change-obs-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-observability', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  regionalId = (await prisma.project.create({
    data: { name: 'change-observability-regional', userId: ownerId, jwtSecret: 'a'.repeat(64), region: 'us-east-1' },
  })).id
}, 180_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  for (const id of [projectId, regionalId].filter(Boolean)) await prisma.project.delete({ where: { id } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  recorded.mockRestore()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('change metrics', () => {
  it('name the project, the region and the change, and nothing a row holds', async () => {
    const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'add notes' }, async () => {
        await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}".notes (id serial PRIMARY KEY, body text)`)
      }))
    expect(change!.status).toBe('healthy')
    const seen = recorded.mock.calls
      .filter(([name, , labels]) => String(name).startsWith('change.') && (labels as Record<string, string> | undefined)?.changeId === change!.id)
    expect(seen.length).toBeGreaterThan(0)
    for (const [, , labels] of seen) {
      expect(labels).toEqual({ projectId, region: 'ap-south-1', changeId: change!.id })
    }
  }, 120_000)

  it('say which region a project kept elsewhere is in, and how its recovery ran', async () => {
    const row = await prisma.backendChange.create({
      data: { projectId: regionalId, seq: 1, kind: 'change', source: 'mcp', title: 'in us-east-1', status: 'applying', checkpoint: {} as any },
    })
    await recordEvent(row.id, regionalId, 'recovery_started', { mode: 'automatic' })
    expect(labelsOf('change.recovery_started', row.id)).toEqual([
      { projectId: regionalId, region: 'us-east-1', changeId: row.id, mode: 'automatic' },
    ])
  }, 60_000)
})

describe('a change that needs a person', () => {
  it('is announced once, in the alarm\'s fixed form, with ids only', async () => {
    // As a process that died mid-change leaves it: the row, its checkpoint, nothing else.
    const checkpoint = await withChangeLock(projectId, (client) => readCatalogOn(client, schema))
    const last = await prisma.backendChange.findFirstOrThrow({ where: { projectId }, orderBy: { seq: 'desc' } })
    const stale = await prisma.backendChange.create({
      data: {
        projectId, seq: last.seq + 1, kind: 'change', source: 'mcp', title: 'interrupted', status: 'applying',
        parentId: last.id, checkpoint: { database: checkpoint } as any, createdAt: new Date(Date.now() - 60 * 60_000),
      },
    })
    // jest.setup.js replaces console.error before each file's tests run, so the
    // spy goes on here, over whatever is in place now.
    const errors = jest.spyOn(console, 'error')
    let printed: string[]
    try {
      expect(await reconcileChange(projectId, stale.id)).toBe('manual_intervention_required')
      printed = errors.mock.calls.map((c) => String(c[0]))
    } finally {
      // Restoring also clears what the spy saw, so it is read first.
      errors.mockRestore()
    }

    const lines = printed.filter((l) => l.startsWith('BACKENLY_CHANGE_NEEDS_PERSON'))
    expect(lines).toEqual([`BACKENLY_CHANGE_NEEDS_PERSON project=${projectId} region=ap-south-1 change=${stale.id} seq=${stale.seq}`])
    expect(labelsOf('change.needs_person', stale.id)).toEqual([{ projectId, region: 'ap-south-1', changeId: stale.id }])

    // Clear it so automation is not left paused.
    expect((await keepChange(projectId, stale.id, ownerId)).ok).toBe(true)
  }, 60_000)
})
