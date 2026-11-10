/**
 * Restoring, as production owns a workspace: a role that owns every table,
 * is not a superuser and does not bypass row-level security, on tables with
 * FORCE ROW LEVEL SECURITY and Backenly's own policies.
 *
 * On production (2026-11-09) an agent dropped `reviews` (2 rows), and History
 * offered the restore: "Its 2 rows are kept". The restore refused:
 *
 *   The restore would fail against today's data: insert or update on table
 *   "reviews" violates foreign key constraint "fk_reviews_user"
 *
 * Both reviewers existed. The restore re-adds the table's foreign keys, and
 * PostgreSQL validates a key added to existing rows with one bulk query
 * (RI_Initial_Check) that runs under the tables' policies: as their owner with
 * FORCE ROW LEVEL SECURITY and no claims, `users` is empty. Row-by-row checks
 * do not have this problem, which is why the key had held until the drop.
 *
 * The local test role is a superuser, which row-level security exempts, so
 * this file hands the workspace to a NOSUPERUSER NOBYPASSRLS login and points
 * the change ledger's connection at it, as production's application role is.
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
import { archiveTable } from '@/lib/changes/preserve'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { jwtClaimFunctionSql, ownRowsPolicies } from '@/lib/postgrest/rls-translation'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const originalUrl = process.env.DATABASE_URL
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const run = crypto.randomBytes(4).toString('hex')
const PLATFORM = `bkn_restore_plat_${run}`
const PASSWORD = crypto.randomBytes(12).toString('hex')

let ownerId: string
let projectId: string
let schema: string
let reviewerId: string

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)

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
    data: { email: `restore-rls-${run}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-restore-forced-rls', userId: ownerId })
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
  // End users, with Backenly's own-rows policy: each sees only their own row.
  await ddl(`CREATE TABLE ${T('users')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text)`)
  for (const s of ownRowsPolicies(schema, 'users', 'id').statements) await ddl(s)
  // Public reviews of products, written by end users.
  await ddl(`CREATE TABLE ${T('reviews')} (id serial PRIMARY KEY, user_id uuid NOT NULL, rating int NOT NULL, comment text)`)
  await ddl(`ALTER TABLE ${T('reviews')} ENABLE ROW LEVEL SECURITY`)
  await ddl(`ALTER TABLE ${T('reviews')} FORCE ROW LEVEL SECURITY`)
  await ddl(`CREATE POLICY reviews_public_read ON ${T('reviews')} FOR SELECT USING (true)`)

  reviewerId = crypto.randomUUID()
  await ddl(`INSERT INTO ${T('users')} (id, email) VALUES ('${reviewerId}', 'bob@example.test'), (gen_random_uuid(), 'carol@example.test')`)
  await ddl(`INSERT INTO ${T('reviews')} (user_id, rating, comment) VALUES ('${reviewerId}', 5, 'Great mug'), ('${reviewerId}', 4, 'Still great')`)
  // What lib/ai/fk-repair.ts adds for a user_id column.
  await ddl(`ALTER TABLE ${T('reviews')} ADD CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES ${T('users')}(id) ON DELETE CASCADE ON UPDATE CASCADE`)

  await ddl(`ALTER SCHEMA "${schema}" OWNER TO "${PLATFORM}"`)
  for (const t of ['users', 'reviews']) await ddl(`ALTER TABLE ${T(t)} OWNER TO "${PLATFORM}"`)

  // From here every governed change and restore connects as the platform role.
  const url = new URL(ADMIN_URL)
  url.username = PLATFORM
  url.password = PASSWORD
  process.env.DATABASE_URL = url.toString()
  await closeChangeLockPool()
}, 120_000)

afterAll(async () => {
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
})

describe('restoring under FORCE ROW LEVEL SECURITY, as the platform role', () => {
  let dropId = ''

  it('the fixture is production-shaped: the platform role sees no user rows on its own', async () => {
    const seen = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${PLATFORM}"`)
      return tx.$queryRawUnsafe<{ who: string; n: number }[]>(`SELECT current_user::text AS who, count(*)::int AS n FROM ${T('users')}`)
    })
    expect(seen[0]).toEqual({ who: PLATFORM, n: 0 })
  })

  it('drops reviews into the vault, rows and all', async () => {
    const closed = await change('drop reviews', async () => {
      const t = await archiveTable(projectId, schema, 'reviews')
      expect(t.handled).toBe(true)
    })
    dropId = closed.id
    expect((await rows<{ t: string | null }>(`SELECT to_regclass('${T('reviews')}')::text AS t`))[0].t).toBeNull()
  })

  it('proves the restore lossless, although fk_reviews_user points at a table whose rows the platform role cannot see', async () => {
    const p = (await previewRecovery(projectId, dropId))!
    expect(p.details.proof?.error ?? null).toBeNull()
    expect(p.safety).toBe('lossless')
  })

  it('restores the table with both rows and the key validated', async () => {
    const out = await recoverChange(projectId, dropId, { mode: 'manual', actorUserId: ownerId })
    expect(out.ok).toBe(true)
    const back = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('reviews')} WHERE user_id = '${reviewerId}'`)
    expect(back[0].n).toBe(2)
    const fk = await rows<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_reviews_user' AND conrelid = '${T('reviews')}'::regclass`,
    )
    expect(fk).toEqual([{ convalidated: true }])
  })

  it('measures data written since a change in rows only the service role can see', async () => {
    // An added column, then a value written into it on a row the platform role
    // cannot see on its own. Undoing the change would remove that value, so the
    // restore must say so and wait for a person, not call itself lossless.
    const add = await change('add users.nickname', () => ddl(`ALTER TABLE ${T('users')} ADD COLUMN nickname text`))
    await ddl(`UPDATE ${T('users')} SET nickname = 'bobby' WHERE id = '${reviewerId}'`)
    const p = (await previewRecovery(projectId, add.id))!
    expect(p.details.proof?.error ?? null).toBeNull()
    expect(p.safety).toBe('needs_approval')
  })
})
