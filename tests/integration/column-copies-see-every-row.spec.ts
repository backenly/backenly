/**
 * HISTORY KEEPS EVERY VALUE OF A DROPPED OR RETYPED COLUMN, AS PRODUCTION OWNS A WORKSPACE
 * ======================================================================================
 * A schema change that destroys or rewrites a column's values first copies them
 * into the change's vault (lib/changes/preserve.ts), so restoring the change can
 * put each value back on its row. The copy is `CREATE TABLE … AS SELECT … FROM
 * <table>`, sent on the change's connection.
 *
 * Every workspace table has FORCE ROW LEVEL SECURITY, which binds its owner
 * too, and the role Backenly connects as owns the tables without bypassing RLS.
 * With no claims set, a table only the service role may read showed it no row,
 * so the copy kept none of them while History said the values were kept, and a
 * restore had nothing to put back.
 *
 * The local test role is a superuser, which RLS exempts, so this file hands the
 * workspace to a NOSUPERUSER NOBYPASSRLS login and points the change ledger and
 * the executor at it, as production's application role is (the harness of
 * change-restore-forced-rls.spec.ts).
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER', logRetentionDays: 7 }) }
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
import { closeChangeLockPool } from '@/lib/changes/lock'
import { recoverChange } from '@/lib/changes/recovery'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { applyMigrationToMain, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const originalUrl = process.env.DATABASE_URL
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const run = crypto.randomBytes(4).toString('hex')
const PLATFORM = `bkn_copies_plat_${run}`
const PASSWORD = crypto.randomBytes(12).toString('hex')

let ownerId: string
let projectId: string
let schema: string

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)

/** Values a person can read, as a superuser reads them. */
async function values(column: string): Promise<Array<string | null>> {
  const out = await rows<{ v: string | null }>(`SELECT ${column}::text AS v FROM ${T('orders')} ORDER BY ref`)
  return out.map((r) => r.v)
}

/** What the change recorded it kept of `column`. */
async function kept(changeId: string, column: string): Promise<{ reason: string; rows: number | null; inVault: number }> {
  const change = await prisma.backendChange.findUnique({ where: { id: changeId }, select: { preserved: true } })
  const entries = ((change?.preserved as { entries?: any[] } | null)?.entries ?? [])
  const entry = entries.find((e) => e.kind === 'column' && e.column === column)
  if (!entry) throw new Error(`the change kept nothing of ${column}`)
  const inVault = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "${entry.vault}"."${entry.vaultTable}"`)
  return { reason: entry.reason, rows: entry.rows, inVault: inVault[0].n }
}

async function migrated(sql: string): Promise<MigrationSuccess> {
  const out = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }))
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out as MigrationSuccess
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `copies-${run}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'column-copies-see-every-row', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  // The platform role: owns the workspace, is not a superuser, does not bypass RLS.
  const database = new URL(ADMIN_URL).pathname.slice(1)
  await ddl(`CREATE ROLE "${PLATFORM}" LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS`)
  await ddl(`GRANT CREATE, CONNECT ON DATABASE "${database}" TO "${PLATFORM}"`)
  await ddl(`GRANT USAGE ON SCHEMA public TO "${PLATFORM}"`)
  await ddl(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${PLATFORM}"`)
  await ddl(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${PLATFORM}"`)

  await ddl(jwtClaimFunctionSql(schema))
  // Readable by the service role only, as Backenly closes a table with no owner.
  await ddl(`CREATE TABLE ${T('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ref text NOT NULL, note text, score numeric)`)
  await ddl(`ALTER TABLE ${T('orders')} ENABLE ROW LEVEL SECURITY`)
  await ddl(`ALTER TABLE ${T('orders')} FORCE ROW LEVEL SECURITY`)
  await ddl(`CREATE POLICY backenly_admin_only ON ${T('orders')} USING ("${schema}".backenly_jwt_claim('role') = 'service_role')`)
  await ddl(`INSERT INTO ${T('orders')} (ref, note, score) VALUES ('o1', 'gift wrap', 4.7), ('o2', 'leave at door', 3.2), ('o3', 'call first', 1.5)`)

  await ddl(`ALTER SCHEMA "${schema}" OWNER TO "${PLATFORM}"`)
  await ddl(`ALTER TABLE ${T('orders')} OWNER TO "${PLATFORM}"`)
  await prisma.table.create({ data: { projectId, name: 'orders', schema, description: 'fixture' } })

  // From here the change ledger and the executor connect as the platform role.
  const url = new URL(ADMIN_URL)
  url.username = PLATFORM
  url.password = PASSWORD
  process.env.DATABASE_URL = url.toString()
  await disconnectRegionalClients()
  await closeChangeLockPool()
}, 180_000)

afterAll(async () => {
  await disconnectRegionalClients()
  await closeChangeLockPool()
  process.env.DATABASE_URL = originalUrl
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await ddl(`DROP OWNED BY "${PLATFORM}"`).catch(() => {})
  await ddl(`DROP ROLE IF EXISTS "${PLATFORM}"`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
}, 60_000)

it('is production-shaped: the platform role sees no order on its own', async () => {
  const seen = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${PLATFORM}"`)
    return tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${T('orders')}`)
  })
  expect(seen[0].n).toBe(0)
})

describe('dropping a column', () => {
  let changeId = ''

  it('keeps all three of its values with the change', async () => {
    const out = await migrated('ALTER TABLE orders DROP COLUMN note')
    changeId = out.change!.id
    expect(await kept(changeId, 'note')).toEqual({ reason: 'dropped', rows: 3, inVault: 3 })
  }, 120_000)

  it('restoring the change puts each value back on its row', async () => {
    const out = await recoverChange(projectId, changeId, { mode: 'manual', actorUserId: ownerId })
    expect(out.ok).toBe(true)
    expect(await values('note')).toEqual(['gift wrap', 'leave at door', 'call first'])
  }, 120_000)
})

describe('retyping a column', () => {
  let changeId = ''

  it('keeps the values it rewrote, all three, beside what they became', async () => {
    const out = await migrated('ALTER TABLE orders ALTER COLUMN score TYPE integer')
    changeId = out.change!.id
    expect(await values('score')).toEqual(['5', '3', '2'])
    expect(await kept(changeId, 'score')).toEqual({ reason: 'retyped', rows: 3, inVault: 3 })
  }, 120_000)

  it('restoring the change gives back the values from before', async () => {
    const out = await recoverChange(projectId, changeId, { mode: 'manual', actorUserId: ownerId })
    expect(out.ok).toBe(true)
    expect(await values('score')).toEqual(['4.7', '3.2', '1.5'])
  }, 120_000)
})

it('a column added with a default that is not a constant keeps the value it filled into each row', async () => {
  const out = await migrated('ALTER TABLE orders ADD COLUMN seen_at timestamptz DEFAULT now()')
  expect(await kept(out.change!.id, 'seen_at')).toEqual({ reason: 'filled', rows: 3, inVault: 3 })
}, 120_000)
