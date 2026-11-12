/**
 * Restore to a point proves every step before it runs any.
 *
 * On production (2026-11-09) Deploy → "Restore to v1" listed 9 changes with no
 * warning, undid #46 (an index self-healing had just added), then stopped at
 * #45 with an error, and left the backend between v1 and where it was. Each
 * step was proved only on reaching it, after the steps before it had run.
 *
 * Here the newest change restores cleanly and an older one cannot be undone
 * without a person (a column it added has been written since). Nothing may
 * run, and the older step is named before anything does. A sequence whose
 * older step only works after the newer ones are undone must still prove, and
 * run, whole.
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
import { planRestoreTo, proveRestoreTo, restoreTo } from '@/lib/changes/range'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const hex = (n = 8) => crypto.randomBytes(n).toString('hex')
const hasIndex = async (name: string) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = '${schema}' AND indexname = '${name}'`))[0].n === 1
const hasColumn = async (table: string, column: string) =>
  (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' AND column_name = '${column}'`))[0].n === 1

async function change(title: string, fn: () => Promise<unknown>) {
  const { change: closed } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `restore-to-first-${hex(6)}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-restore-to-proves-first', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('a sequence with a step that cannot run', () => {
  let point = 0
  let olderSeq = 0

  beforeAll(async () => {
    point = (await change('create orders', () => ddl(`CREATE TABLE ${T('orders')} (id serial PRIMARY KEY, total int)`))).seq
    await ddl(`INSERT INTO ${T('orders')} (total) SELECT g FROM generate_series(1, 20) g`)
    // The older change: a column, then values written into it since.
    olderSeq = (await change('add orders.refund_reason', () => ddl(`ALTER TABLE ${T('orders')} ADD COLUMN refund_reason text`))).seq
    await ddl(`UPDATE ${T('orders')} SET refund_reason = 'damaged' WHERE id <= 3`)
    // The newest change: an index, which restores cleanly.
    await change('index orders.total', () => ddl(`CREATE INDEX orders_total_idx ON ${T('orders')} (total)`))
  }, 120_000)

  it('names the step that would stop it before anything runs', async () => {
    const plan = await planRestoreTo(projectId, point)
    expect(plan.steps).toHaveLength(2)
    const stop = await proveRestoreTo(projectId, plan)
    expect(stop).toMatchObject({ seq: olderSeq, code: 'NEEDS_APPROVAL', beforeAnything: true })
  })

  it('runs nothing: the newer change stays exactly as it is', async () => {
    const out = await restoreTo(projectId, point, { actorUserId: ownerId })
    expect(out.restored).toEqual([])
    expect(out.stoppedAt).toMatchObject({ seq: olderSeq, beforeAnything: true })
    expect(await hasIndex('orders_total_idx')).toBe(true)
    expect(await hasColumn('orders', 'refund_reason')).toBe(true)
    // Nothing was recorded as restored either.
    const restores = await prisma.backendChange.count({ where: { projectId, kind: 'recovery' } })
    expect(restores).toBe(0)
  })
})

describe('a sequence whose older step only works once the newer ones are undone', () => {
  let point = 0

  beforeAll(async () => {
    point = (await change('create invoices', () => ddl(`CREATE TABLE ${T('invoices')} (id serial PRIMARY KEY, amount int)`))).seq
    // Both change the same table: undoing the older one alone would find the
    // table changed since; undone newest first, it is exactly as it left it.
    await change('add invoices.note', () => ddl(`ALTER TABLE ${T('invoices')} ADD COLUMN note text`))
    await change('add invoices.due_on', () => ddl(`ALTER TABLE ${T('invoices')} ADD COLUMN due_on date`))
  }, 120_000)

  it('proves whole, and runs whole', async () => {
    const plan = await planRestoreTo(projectId, point)
    expect(plan.steps).toHaveLength(2)
    expect(await proveRestoreTo(projectId, plan)).toBeNull()
    const out = await restoreTo(projectId, point, { actorUserId: ownerId })
    expect(out.stoppedAt).toBeNull()
    expect(out.restored).toHaveLength(2)
    expect(await hasColumn('invoices', 'note')).toBe(false)
    expect(await hasColumn('invoices', 'due_on')).toBe(false)
  })
})
