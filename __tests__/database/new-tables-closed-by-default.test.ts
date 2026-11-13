/**
 * A NEW TABLE WHOSE OWNER BACKENLY CANNOT TELL STARTS CLOSED, NOT OPEN
 * ===================================================================
 * Every workspace table is granted to the REST API's roles: anon may read,
 * authenticated may read and write (scripts/sql/postgrest-ddl-sync.sql). When
 * automatic row-level security could not tell who owns a row, it left the new
 * table without row-level security, so the app's publishable key read every
 * row and any signed-in end user could write any row.
 *
 * Now such a table starts closed (service-role keys only), the creator is told
 * so and how to open it, and Backenly opens it itself once a foreign key shows
 * who owns a row, unless someone has chosen a rule for it since.
 *
 * Reads and writes run as the REST API's own roles, anon and authenticated,
 * with the grants production gives them, so these are the answers the API
 * would give.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { applyPermissionPolicy, autoApplyRlsIfNeeded, closedByDefaultTables, reconcileAutoRls } from '@/lib/services/workspace-rls'
import { jwtClaimsJson } from '@/lib/services/rls-session'

let ownerId = ''
let projectId = ''
let schema = ''
const alice = randomUUID()

/** Run as a REST API role, with the claims PostgREST would set. */
async function as<T>(role: 'anon' | 'authenticated', userId: string | null, sql: string, ...values: unknown[]): Promise<T[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, jwtClaimsJson({ userId }))
    return tx.$queryRawUnsafe<T[]>(sql, ...values)
  })
}

/** Production's grants to the REST API roles, for every table now in the schema. */
async function grantRestRoles(): Promise<void> {
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated, service_role`)
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO authenticated, service_role`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO anon`)
}

async function liveRules(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT policyname AS name FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
    schema,
    table,
  )
  return rows.map((r) => r.name)
}

const createTable = (tableName: string) =>
  executeAction(
    { action: 'CREATE_TABLE', params: { tableName, columns: [{ name: 'title', type: 'TEXT' }, { name: 'body', type: 'TEXT' }] } },
    projectId,
    undefined,
    0,
    undefined,
    false,
  )

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `closed-${randomUUID()}@test.invalid`, name: 'Closed by default' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `closed-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text)`)
}, 60_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.projectPreference.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('a new table nobody can be shown to own', () => {
  let message = ''

  beforeAll(async () => {
    const res = await createTable('notes')
    expect(res.success).toBe(true)
    message = res.message
    await grantRestRoles()
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."notes" (title, body) VALUES ('a', 'private')`)
  }, 60_000)

  it('is not readable with the publishable key', async () => {
    expect(await as('anon', null, `SELECT title FROM "${schema}"."notes"`)).toEqual([])
  })

  it('is neither readable nor writable by a signed-in end user', async () => {
    expect(await as('authenticated', alice, `SELECT title FROM "${schema}"."notes"`)).toEqual([])
    await expect(as('authenticated', alice, `INSERT INTO "${schema}"."notes" (title, body) VALUES ('b', 'forged')`)).rejects.toThrow(
      /row-level security/,
    )
  })

  it('tells whoever created it that it is closed, and how to open it', () => {
    expect(message).toContain('"notes" is closed: only service-role keys can read or write it')
    expect(message).toContain('add_rls')
  })

  it('opens itself once a foreign key shows who owns a row', async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."notes" ADD COLUMN user_id uuid REFERENCES "${schema}"."users"(id)`)
    await reconcileAutoRls(projectId)
    expect(await liveRules('notes')).toContain('backenly_own_rows_select')
    expect((await closedByDefaultTables(projectId, schema)).has('notes')).toBe(false)
    // and the record of the rule it was closed with went with that rule.
    const records = await prisma.permissionPolicy.findMany({ where: { projectId, tableName: 'notes' }, select: { policyName: true } })
    expect(records.map((r) => r.policyName)).toEqual(['backenly_own_rows'])
  }, 60_000)
})

describe('a rule someone chose for a table Backenly closed', () => {
  it('is never replaced by the inference', async () => {
    expect((await createTable('catalog_entries')).success).toBe(true)
    expect((await applyPermissionPolicy(projectId, { tableName: 'catalog_entries', template: 'public_read' })).success).toBe(true)
    expect((await closedByDefaultTables(projectId, schema)).has('catalog_entries')).toBe(false)

    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."catalog_entries" ADD COLUMN user_id uuid REFERENCES "${schema}"."users"(id)`)
    await reconcileAutoRls(projectId)
    const rules = await liveRules('catalog_entries')
    expect(rules).toContain('backenly_public_read_select')
    expect(rules).not.toContain('backenly_own_rows_select')
  }, 60_000)
})

describe('a table adopted from the database', () => {
  it('is left as it is: it may already be serving an app', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."imported" (id uuid PRIMARY KEY, title text)`)
    const outcome = await autoApplyRlsIfNeeded(projectId, 'imported', [])
    expect(outcome).toEqual({ template: null, applied: false, closedByDefault: false, notice: null })
    expect(await liveRules('imported')).toEqual([])
  })
})
