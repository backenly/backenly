/**
 * EVERY VIEW OF A PROJECT'S SCHEMA IS CURRENT ONCE A CHANGE OR A RESTORE SETTLES
 * ==============================================================================
 *
 * Against a real database:
 *
 *   the REST API is asked to reload its schema when a governed change removes
 *   a table (moved into the change's vault, which the DDL trigger never
 *   reports) and again when the change is restored;
 *   the reconciler's baseline follows a governed change, so a column it
 *   dropped is not read later as missing and put back;
 *   a validator that cached a table's shape sees a column another process
 *   added, or dropped, on the next request;
 *   a restore supersedes the request behind the column it took away, so it is
 *   not reported missing and offered back;
 *   a restore the reconciler finds done puts the platform's records back as a
 *   confirmed one does: a table it removed is no longer declared.
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
import { Client, type Notification } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { archiveTable } from '@/lib/changes/preserve'
import { reloadServedSchema } from '@/lib/changes/freshness'
import { recoverChange, reconcileChange } from '@/lib/changes/recovery'
import { claimRecovery } from '@/lib/changes/lifecycle'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { validateInsertPayload } from '@/lib/services/workspace-validator'
import { captureSchemaSnapshot, getSchemaSnapshot, listSchemaSnapshots } from '@/lib/services/workspace-schema-snapshot'
import { checkIntentConformance, recordSchemaIntent } from '@/lib/autonomy/intent-conformance'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
let listener: Client
const notices: string[] = []

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })

/** A person's change in the dashboard: governed, attributed, verified. */
async function change(title: string, run: () => Promise<unknown>) {
  const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title }, async () => { await run() }))
  return change!
}

const restore = (id: string) => recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })

async function reloadsAsked(since: number, timeoutMs = 3_000): Promise<number> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const n = notices.slice(since).filter((p) => p === 'reload schema').length
    if (n > 0) return n
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return 0
}

async function latestBaselineColumns(table: string): Promise<string[] | null> {
  const [latest] = await listSchemaSnapshots(projectId, 1)
  if (!latest) return null
  const full = await getSchemaSnapshot(projectId, latest.versionNum)
  const t = full?.tables.find((x) => x.name === table)
  return t ? t.columns.map((c) => c.name).sort() : null
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `schema-fresh-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'schema-freshness', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  // PostgREST listens on the `pgrst` channel of the project's database; this
  // listens in its place.
  listener = new Client({ connectionString: process.env.DATABASE_URL })
  await listener.connect()
  listener.on('notification', (msg: Notification) => { if (msg.channel === 'pgrst') notices.push(msg.payload ?? '') })
  await listener.query('LISTEN pgrst')
}, 180_000)

afterAll(async () => {
  await listener?.end().catch(() => {})
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('the REST API', () => {
  it('is asked to reload when a change removes a table, and again when the change is restored', async () => {
    await ddl(`CREATE TABLE ${T('memos')} (id serial PRIMARY KEY, body text)`)
    const before = notices.length
    const removed = await change('remove memos', () => archiveTable(projectId, schema, 'memos'))
    expect(removed.status).toBe('healthy')
    expect(await reloadsAsked(before)).toBeGreaterThan(0)

    const beforeRestore = notices.length
    const back = await restore(removed.id)
    expect(back.ok).toBe(true)
    expect(await reloadsAsked(beforeRestore)).toBeGreaterThan(0)
  }, 120_000)

  it('is asked by the refresh itself, with no DDL for the database to notice', async () => {
    // pg_notify returns void, which reading it back as a query cannot decode:
    // the request failed on every change, and only the region's DDL trigger,
    // which does not fire for a table moved into a vault, was ever heard.
    const failures = jest.spyOn(console, 'error')
    const before = notices.length
    await reloadServedSchema(projectId)
    expect(await reloadsAsked(before)).toBe(1)
    expect(failures.mock.calls.filter((c) => String(c[0]).includes('[ChangeFreshness]'))).toEqual([])
    failures.mockRestore()
  })
})

describe('the reconciler\'s baseline', () => {
  it('follows a governed change, so a column it dropped is not read later as missing', async () => {
    await ddl(`CREATE TABLE ${T('ledger_lines')} (id serial PRIMARY KEY, note text, legacy_code text)`)
    await captureSchemaSnapshot(projectId, 'manual')
    expect(await latestBaselineColumns('ledger_lines')).toEqual(['id', 'legacy_code', 'note'])

    const dropped = await change('drop legacy_code', () => ddl(`ALTER TABLE ${T('ledger_lines')} DROP COLUMN legacy_code`))
    expect(dropped.status).toBe('healthy')
    expect(await latestBaselineColumns('ledger_lines')).toEqual(['id', 'note'])
  }, 120_000)
})

describe('a validator that cached a table\'s shape', () => {
  it('sees a column another process added, and one it dropped, on the next request', async () => {
    await ddl(`CREATE TABLE ${T('contacts')} (id serial PRIMARY KEY, name text)`)
    expect((await validateInsertPayload(projectId, 'contacts', { name: 'Ada' })).success).toBe(true)

    // As another process or region would: no call reaches this one's cache.
    await ddl(`ALTER TABLE ${T('contacts')} ADD COLUMN phone text`)
    expect((await validateInsertPayload(projectId, 'contacts', { name: 'Ada', phone: '555' })).success).toBe(true)

    await ddl(`ALTER TABLE ${T('contacts')} DROP COLUMN phone`)
    expect((await validateInsertPayload(projectId, 'contacts', { name: 'Ada', phone: '555' })).success).toBe(false)
  }, 60_000)
})

describe('a restore', () => {
  it('supersedes the request behind the column it took away', async () => {
    await ddl(`CREATE TABLE ${T('orders')} (id serial PRIMARY KEY)`)
    const added = await change('orders.discount', () => ddl(`ALTER TABLE ${T('orders')} ADD COLUMN discount integer`))
    expect(added.status).toBe('healthy')
    // The request the change carried, as the typed tool records it.
    await recordSchemaIntent(projectId, 'orders', [{ name: 'discount', type: 'integer' }], 'add_column')

    const back = await restore(added.id)
    expect(back.ok).toBe(true)
    expect(await prisma.schemaIntent.count({ where: { projectId, tableName: 'orders', columnName: 'discount' } })).toBe(0)
    const report = await checkIntentConformance(projectId)
    expect(report.findings.filter((f) => f.table === 'orders')).toEqual([])
  }, 120_000)

  it('found done by the reconciler, leaves no declaration of a table it removed', async () => {
    const created = await change('create ghost', () => ddl(`CREATE TABLE ${T('ghost')} (id serial PRIMARY KEY)`))
    expect(created.status).toBe('healthy')
    // Declared, as the table executor declares what it creates.
    await prisma.table.create({ data: { projectId, name: 'ghost', schema } })

    // A restore that committed, then lost its worker before confirming: the
    // claim and its lease remain, and the catalog is back at the checkpoint.
    const claim = await claimRecovery(created.id, ['healthy'])
    expect(claim).not.toBeNull()
    await prisma.backendChangeEvent.create({ data: { changeId: created.id, projectId, type: 'recovery_started', data: { mode: 'manual', from: 'healthy' } } })
    await ddl(`DROP TABLE ${T('ghost')}`)

    const before = notices.length
    expect(await reconcileChange(projectId, created.id, new Date(Date.now() + 16 * 60_000))).toBe('restored')
    expect((await record(created.id)).status).toBe('restored')
    expect(await prisma.table.count({ where: { projectId, name: 'ghost' } })).toBe(0)
    expect(await reloadsAsked(before)).toBeGreaterThan(0)
  }, 120_000)
})
