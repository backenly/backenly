/**
 * BACKENLY'S OWN CHECKS AND KEYS SEE EVERY ROW, AS PRODUCTION OWNS A WORKSPACE
 * ===========================================================================
 * Production QA (2026-11-16). Every review pointed at a user who existed, and:
 *  - Autonomy's "reviews has a relation with no foreign key constraint" →
 *    Approve & fix answered 500: "Could not add foreign key on
 *    "reviews.user_id": Invalid `prisma.$executeRawUnsafe()` invocation …
 *    23503 … violates foreign key constraint "fk_reviews_user"";
 *  - the agent's merge of the same key was refused before it ran: "reviews has
 *    rows whose user_id matches no users.id";
 *  - a merge card for renaming two populated columns and adding replacements
 *    said nothing about the rows they change.
 *
 * Every workspace table has FORCE ROW LEVEL SECURITY, which binds its owner
 * too, and the role Backenly connects as owns the tables without bypassing
 * RLS. Asked as nobody, `users` is empty to it. PostgreSQL checks a key added
 * to existing rows with one query under the tables' policies (RI_Initial_Check),
 * and the merge checks and the card's counts read the same empty view.
 *
 * The local test role is a superuser, which RLS exempts, so this file hands the
 * workspace to a NOSUPERUSER NOBYPASSRLS login and points every connection
 * Backenly opens to the project's data at it, as production's application role
 * is (the harness of change-restore-forced-rls.spec.ts).
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
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
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { jwtClaimFunctionSql, ownRowsPolicies } from '@/lib/postgrest/rls-translation'
import { executeAction } from '@/lib/ai/minimal-executor'
import { repairForeignKeysWithDetails } from '@/lib/ai/fk-repair'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { mergeWouldFail } from '@/lib/branches/merge-preflight'
import { mergeImpact } from '@/lib/branches/merge-impact'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const originalUrl = process.env.DATABASE_URL
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const run = crypto.randomBytes(4).toString('hex')
const PLATFORM = `bkn_rows_plat_${run}`
const PASSWORD = crypto.randomBytes(12).toString('hex')

let ownerId: string
let projectId: string
let schema: string

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)

/** A table end users write and anyone reads, each row pointing at a user. */
async function publicChild(table: string, userIds: string[]) {
  await ddl(`CREATE TABLE ${T(table)} (id serial PRIMARY KEY, user_id uuid NOT NULL, body text)`)
  await ddl(`ALTER TABLE ${T(table)} ENABLE ROW LEVEL SECURITY`)
  await ddl(`ALTER TABLE ${T(table)} FORCE ROW LEVEL SECURITY`)
  await ddl(`CREATE POLICY ${table}_public_read ON ${T(table)} FOR SELECT USING (true)`)
  for (const u of userIds) await ddl(`INSERT INTO ${T(table)} (user_id, body) VALUES ('${u}', 'hello')`)
}

async function foreignKeys(table: string): Promise<Array<{ name: string; validated: boolean }>> {
  return rows(
    `SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE contype = 'f' AND conrelid = '${T(table)}'::regclass ORDER BY 1`,
  )
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `rows-${run}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'platform-checks-see-every-row', userId: ownerId })
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
  await ddl(`CREATE TABLE IF NOT EXISTS ${T('users')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text)`)
  for (const s of ownRowsPolicies(schema, 'users', 'id').statements) await ddl(s)
  const ada = crypto.randomUUID()
  const alan = crypto.randomUUID()
  await ddl(`INSERT INTO ${T('users')} (id, email) VALUES ('${ada}', 'ada@example.test'), ('${alan}', 'alan@example.test')`)

  // Rows that all point at a user who exists, one table per path under test.
  for (const t of ['reviews', 'comments', 'likes', 'ratings']) await publicChild(t, [ada, ada, alan])
  // A key added without checking the rows there, as a migration's first step does.
  await ddl(`ALTER TABLE ${T('likes')} ADD CONSTRAINT fk_likes_user FOREIGN KEY (user_id) REFERENCES ${T('users')}(id) NOT VALID`)
  // And one table with a row that really points nowhere.
  await publicChild('notes', [ada, crypto.randomUUID()])

  // Readable by the service role only, as Backenly closes a table with no owner.
  await ddl(`CREATE TABLE ${T('qa_probe')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, sku text, note text)`)
  await ddl(`ALTER TABLE ${T('qa_probe')} ENABLE ROW LEVEL SECURITY`)
  await ddl(`ALTER TABLE ${T('qa_probe')} FORCE ROW LEVEL SECURITY`)
  await ddl(`CREATE POLICY backenly_admin_only ON ${T('qa_probe')} USING ("${schema}".backenly_jwt_claim('role') = 'service_role')`)
  await ddl(`INSERT INTO ${T('qa_probe')} (status, sku, note) VALUES ('paid', 'S1', 'n1'), ('paid', 'S1', 'n2'), ('paid', 'S2', NULL)`)

  await ddl(`ALTER SCHEMA "${schema}" OWNER TO "${PLATFORM}"`)
  for (const t of ['users', 'reviews', 'comments', 'likes', 'ratings', 'notes', 'qa_probe']) {
    await ddl(`ALTER TABLE ${T(t)} OWNER TO "${PLATFORM}"`)
    // Known to the platform, as a table Backenly built is.
    await prisma.table.create({ data: { projectId, name: t, schema, description: 'fixture' } })
  }

  // From here every connection Backenly opens to the project's data, and the
  // change ledger's, is the platform role's.
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

const asOwner = <T>(fn: () => Promise<T>) => withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, fn)

it('is production-shaped: the platform role sees no user on its own', async () => {
  const seen = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${PLATFORM}"`)
    return tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${T('users')}`)
  })
  expect(seen[0].n).toBe(0)
})

describe('before a merge is put to a person', () => {
  it('finds the user every review points at, so a valid key is not refused', async () => {
    expect(await mergeWouldFail(projectId, ['ALTER TABLE reviews ADD CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id)'])).toEqual([])
  })

  it('still refuses a key a row really breaks', async () => {
    const reasons = await mergeWouldFail(projectId, ['ALTER TABLE notes ADD CONSTRAINT fk_notes_user FOREIGN KEY (user_id) REFERENCES users(id)'])
    expect(reasons).toEqual([expect.stringContaining('notes has rows whose user_id matches no users.id')])
  })

  it('sees the duplicates, empty values and broken rows of a table only the service role reads', async () => {
    const reasons = await mergeWouldFail(projectId, [
      'ALTER TABLE qa_probe ADD CONSTRAINT qa_probe_sku_key UNIQUE (sku)',
      'ALTER TABLE qa_probe ALTER COLUMN note SET NOT NULL',
      "ALTER TABLE qa_probe ADD CONSTRAINT qa_probe_status_chk CHECK (status IN ('pending'))",
      'ALTER TABLE qa_probe ADD COLUMN code text NOT NULL',
    ])
    expect(reasons).toEqual([
      expect.stringContaining('share a value of sku'),
      expect.stringContaining('no value in note'),
      expect.stringContaining("break CHECK (status IN ('pending'))"),
      expect.stringContaining('code is added NOT NULL with no default'),
    ])
  })
})

describe('a merge card', () => {
  it('says what renaming a populated column and adding a replacement does to its rows', async () => {
    const impact = await mergeImpact(projectId, schema, [
      'ALTER TABLE qa_probe RENAME COLUMN status TO legacy_status',
      "ALTER TABLE qa_probe ADD COLUMN status text NOT NULL DEFAULT 'pending'",
    ])
    expect(impact.existingRows).toEqual([
      'qa_probe: status is renamed legacy_status; its values in 3 rows move with it, and a client still reading status stops finding it',
      "qa_probe: the 3 existing rows get 'pending' in the new column status",
    ])
  })
})

describe('adding and validating a foreign key on production', () => {
  it('approving Autonomy\'s missing key adds it over rows that point at existing users', async () => {
    const out = await asOwner(() =>
      executeAction({ action: 'ADD_CONSTRAINT', params: { tableName: 'reviews', columnName: 'user_id', constraintType: 'foreign_key' } }, projectId, undefined, 0, undefined, false))
    expect(out).toMatchObject({ success: true })
    expect(await foreignKeys('reviews')).toEqual([{ name: 'fk_reviews_user', validated: true }])
  }, 60_000)

  it('a migration that declares the key applies it', async () => {
    const out = await asOwner(() => applyMigrationToMain(
      projectId, ownerId,
      'ALTER TABLE comments ADD CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)',
      { agentSurface: false, workspaceSchema: schema },
    ))
    expect(out).toMatchObject({ ok: true })
    expect(await foreignKeys('comments')).toEqual([{ name: 'fk_comments_user', validated: true }])
  }, 60_000)

  it('validating a key added NOT VALID checks the rows that are there and passes', async () => {
    const out = await asOwner(() =>
      executeAction({ action: 'VALIDATE_CONSTRAINT', params: { tableName: 'likes', constraintName: 'fk_likes_user' } }, projectId, undefined, 0, undefined, false))
    expect(out).toMatchObject({ success: true })
    expect(await foreignKeys('likes')).toEqual([{ name: 'fk_likes_user', validated: true }])
  }, 60_000)

  it('the repair after a new table adds the keys its names imply', async () => {
    const result = await repairForeignKeysWithDetails(projectId)
    expect(result.details.find((d) => d.table === 'ratings')).toMatchObject({ refTable: 'users', success: true })
    expect((await foreignKeys('ratings')).map((k) => k.name)).toEqual(['fk_ratings_user'])
  }, 60_000)

  it('a key a row really breaks is refused in plain words, with the code an approval answers 409 to', async () => {
    const out = await asOwner(() =>
      executeAction({ action: 'ADD_CONSTRAINT', params: { tableName: 'notes', columnName: 'user_id', constraintType: 'foreign_key' } }, projectId, undefined, 0, undefined, false))
    expect(out).toMatchObject({ success: false, code: 'EXISTING_ROWS_VIOLATE' })
    expect(out.message).toContain('Some rows in notes have a user_id that matches no row in users')
    expect(out.message).not.toMatch(/prisma|invocation/i)
    expect(await foreignKeys('notes')).toEqual([])
  }, 60_000)
})
