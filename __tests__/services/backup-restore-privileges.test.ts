/**
 * Backup and restore under a PRODUCTION-style role, not a superuser.
 *
 * Every other test of this path runs as the local development role, which is a
 * superuser. Superusers bypass row-level security, so a superuser-only test
 * proves nothing about the deployment that actually matters — and that gap is
 * not hypothetical. `lib/services/workspace-backup.ts` records the incident:
 * pg_dump running as the application role against FORCE ROW LEVEL SECURITY
 * tables aborted, "every nightly backup failed for at least four days" while
 * the pruner deleted the last good ones, ending at zero backups on disk.
 *
 * The self-hosted Compose stack hides this, because POSTGRES_USER defaults to
 * `backenly_user` and the bootstrap user of a postgres image is a superuser.
 * Managed Postgres does not hide it.
 *
 * So this suite builds what production has: an application role that is
 * NOSUPERUSER and NOBYPASSRLS, owning tables with FORCE ROW LEVEL SECURITY,
 * and a separate backup role. It asserts the failure is clean and explicit
 * without BACKUP_DATABASE_URL, that the full round trip works with it, and
 * that a failed restore puts the original schema back.
 */
import { randomBytes, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backenly-priv-test-'))
process.env.BACKUP_DIR = BACKUP_DIR

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL
const ORIGINAL_BACKUP_URL = process.env.BACKUP_DATABASE_URL
const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) {
    throw new Error('Refusing: DATABASE_URL is not the test database')
  }
}

// require, not import: BACKUP_DIR must be set before the service evaluates.
const { prisma } = require('@/lib/db/prisma')
const { backupWorkspace, restoreWorkspace } = require('@/lib/services/workspace-backup')

const SUFFIX = randomBytes(4).toString('hex')
const APP_ROLE = `bkn_t_app_${SUFFIX}`
const BACKUP_ROLE = `bkn_t_bkp_${SUFFIX}`
const ROLE_SECRET = randomBytes(12).toString('hex')

/** A connection URL for `role`, derived from the test URL. Never a literal. */
function urlFor(role: string): string {
  const u = new URL(DB_URL as string)
  u.username = role
  u.password = ROLE_SECRET
  return u.toString()
}

/** Run SQL as a specific role, so ownership and privileges are real. */
function psqlAs(role: string, sql: string): string {
  const u = new URL(urlFor(role))
  return execFileSync(
    'psql',
    [
      '--host', u.hostname,
      '--port', u.port || '5432',
      '--username', decodeURIComponent(u.username),
      '--dbname', u.pathname.replace(/^\//, ''),
      '--no-password', '-v', 'ON_ERROR_STOP=1', '-t', '-c', sql,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: ROLE_SECRET }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

const createdProjectIds: string[] = []
const createdUserIds: string[] = []

async function makeProject(): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `priv-${randomUUID()}@test.invalid`, name: 'Privilege Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `priv-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

const schemaOf = (projectId: string) => `workspace_${projectId}`

/**
 * A workspace the way the product builds one: owned by the application role,
 * with FORCE ROW LEVEL SECURITY and a policy, which is what pg_dump trips over.
 */
async function seedProductionShapedWorkspace(projectId: string): Promise<void> {
  const s = schemaOf(projectId)
  psqlAs(APP_ROLE, `
    CREATE SCHEMA "${s}";
    CREATE TABLE "${s}".customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id text NOT NULL,
      email text NOT NULL UNIQUE,
      age int CHECK (age >= 0)
    );
    CREATE INDEX idx_customers_age ON "${s}".customers(age);
    -- Rows first: under FORCE RLS the owner is subject to its own policy, and
    -- this one keys on a JWT claim no seeding connection carries. That is the
    -- product's real order too (data exists, then the policy is applied), and
    -- a FORCE RLS table WITH rows is the case pg_dump actually trips over.
    INSERT INTO "${s}".customers (owner_id, email, age)
      SELECT 'owner-' || g, 'user' || g || '@test.invalid', 20 + g FROM generate_series(1,5) g;
    ALTER TABLE "${s}".customers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "${s}".customers FORCE ROW LEVEL SECURITY;
    CREATE POLICY own_rows ON "${s}".customers USING (owner_id = current_setting('request.jwt.claim.sub', true));
    GRANT USAGE ON SCHEMA "${s}" TO ${BACKUP_ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA "${s}" TO ${BACKUP_ROLE};
  `)
}

// --- catalog reads, as the admin connection ---
const one = async (sql: string, ...params: unknown[]): Promise<number> => {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params)
  return Number(rows[0].n)
}
const relationCount = (s: string) =>
  one(`SELECT count(*)::bigint n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
       WHERE ns.nspname=$1 AND c.relkind IN ('r','v','m','p')`, s)
const rowCount = (s: string) => one(`SELECT count(*)::bigint n FROM "${s}".customers`)
const indexCount = (s: string) => one(`SELECT count(*)::bigint n FROM pg_indexes WHERE schemaname=$1`, s)
const policyCount = (s: string) => one(`SELECT count(*)::bigint n FROM pg_policies WHERE schemaname=$1`, s)
const constraintCount = (s: string) =>
  one(`SELECT count(*)::bigint n FROM information_schema.table_constraints WHERE table_schema=$1`, s)
const grantCount = (s: string) =>
  one(`SELECT count(*)::bigint n FROM information_schema.role_table_grants WHERE table_schema=$1`, s)
const grantsTo = (s: string, grantee: string) =>
  one(`SELECT count(*)::bigint n FROM information_schema.role_table_grants
       WHERE table_schema=$1 AND grantee=$2`, s, grantee)
const forceRlsCount = (s: string) =>
  one(`SELECT count(*)::bigint n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
       WHERE ns.nspname=$1 AND c.relrowsecurity AND c.relforcerowsecurity`, s)
const ownerOf = async (s: string, rel: string): Promise<string> => {
  const rows = await prisma.$queryRawUnsafe<{ owner: string }[]>(
    `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
       JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=$1 AND c.relname=$2`, s, rel)
  return rows[0]?.owner ?? '(none)'
}
const schemaOwnerOf = async (s: string): Promise<string> => {
  const rows = await prisma.$queryRawUnsafe<{ owner: string }[]>(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1`, s)
  return rows[0]?.owner ?? '(none)'
}
const asideCount = (s: string) =>
  one(`SELECT count(*)::bigint n FROM pg_namespace WHERE nspname LIKE $1`, `${s}_pre%`)

beforeAll(async () => {
  assertSafeTestDatabase()
  // No forced edition: snapshots are un-gated, so this runs in the default
  // single-tenant edition, the way a self-hosted install does. See the note in
  // backup-restore-integrity.test.ts.

  // The application role production actually runs as. NOBYPASSRLS is the whole
  // point: with it, pg_dump reads FORCE RLS tables and the defect is invisible.
  await prisma.$executeRawUnsafe(
    `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${ROLE_SECRET}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
  )
  // A dedicated backup role. BYPASSRLS so the dump can read every row; CREATE
  // on the database because restore replays `CREATE SCHEMA` over this same
  // connection. Deliberately NOT a superuser.
  await prisma.$executeRawUnsafe(
    `CREATE ROLE ${BACKUP_ROLE} LOGIN PASSWORD '${ROLE_SECRET}' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`
  )
  const dbName = new URL(DB_URL as string).pathname.replace(/^\//, '')
  // The application owns its workspace, so it needs CREATE to make one.
  await prisma.$executeRawUnsafe(`GRANT CREATE, CONNECT ON DATABASE "${dbName}" TO ${APP_ROLE}`)
  // The backup role gets CONNECT and nothing else at database level: no
  // CREATE, no membership of the application role, not a superuser. If these
  // tests pass, that IS the privilege contract — the dump needs to read
  // everything, and nothing more. Restore writes over the application's own
  // connection, which is what keeps ownership where it belongs.
  await prisma.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO ${BACKUP_ROLE}`)
}, 60_000)

afterAll(async () => {
  for (const id of createdProjectIds) {
    const s = schemaOf(id)
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
    const asides = await prisma.$queryRawUnsafe<{ nspname: string }[]>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, `${s}_pre%`
    ).catch(() => [])
    for (const a of asides) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${a.nspname}" CASCADE`).catch(() => {})
    }
  }
  await prisma.workspaceBackup.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})

  const dbName = new URL(DB_URL as string).pathname.replace(/^\//, '')
  for (const role of [BACKUP_ROLE, APP_ROLE]) {
    await prisma.$executeRawUnsafe(`REVOKE ALL ON DATABASE "${dbName}" FROM ${role}`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP OWNED BY ${role} CASCADE`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }

  fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
  if (ORIGINAL_BACKUP_URL === undefined) delete process.env.BACKUP_DATABASE_URL
  else process.env.BACKUP_DATABASE_URL = ORIGINAL_BACKUP_URL
  await prisma.$disconnect()
}, 60_000)

afterEach(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
  delete process.env.BACKUP_DATABASE_URL
})

describe('without BACKUP_DATABASE_URL, on a role that cannot bypass RLS', () => {
  it('fails cleanly and explicitly instead of writing a misleading backup', async () => {
    const projectId = await makeProject()
    await seedProductionShapedWorkspace(projectId)

    // What a self-hoster on managed Postgres has: the app credential, no
    // dedicated backup role. This is the configuration that produced the
    // four-day outage.
    process.env.DATABASE_URL = urlFor(APP_ROLE)

    const result = await backupWorkspace(projectId)
    expect(result.success).toBe(false)

    // The operator must be told that the cause is a credential, not a broken
    // database. The raw pg_dump line reads like a database fault.
    expect(result.error).toMatch(/row-level security/i)
    expect(result.error).toMatch(/BACKUP_DATABASE_URL/)
    expect(result.error).toMatch(/BYPASSRLS/)

    // No misleading record, and nothing a pruner could later mistake for cover.
    const rows = await prisma.workspaceBackup.findMany({ where: { projectId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].sizeBytes).toBe(BigInt(0))
    const completed = await prisma.workspaceBackup.count({ where: { projectId, status: 'completed' } })
    expect(completed).toBe(0)
  }, 120_000)
})

describe('with BACKUP_DATABASE_URL on a dedicated non-superuser role', () => {
  it('round-trips rows, indexes, constraints, policies, FORCE RLS and grants', async () => {
    const projectId = await makeProject()
    const s = schemaOf(projectId)
    await seedProductionShapedWorkspace(projectId)

    process.env.DATABASE_URL = urlFor(APP_ROLE)
    process.env.BACKUP_DATABASE_URL = urlFor(BACKUP_ROLE)

    const before = {
      relations: await relationCount(s),
      rows: await rowCount(s),
      indexes: await indexCount(s),
      constraints: await constraintCount(s),
      policies: await policyCount(s),
      forceRls: await forceRlsCount(s),
      grants: await grantCount(s),
    }
    const beforeOwnerGrants = await grantsTo(s, APP_ROLE)
    const beforeBackupGrants = await grantsTo(s, BACKUP_ROLE)
    expect(beforeBackupGrants).toBeGreaterThan(0)
    expect(before.forceRls).toBeGreaterThan(0)
    expect(before.policies).toBeGreaterThan(0)

    const backup = await backupWorkspace(projectId)
    expect(backup.success).toBe(true)

    // Destroy: lose rows, an index and the policy.
    await prisma.$executeRawUnsafe(`DELETE FROM "${s}".customers WHERE age > 22`)
    await prisma.$executeRawUnsafe(`DROP INDEX "${s}".idx_customers_age`)
    await prisma.$executeRawUnsafe(`DROP POLICY own_rows ON "${s}".customers`)
    expect(await rowCount(s)).toBe(2)
    expect(await policyCount(s)).toBe(0)

    const restored = await restoreWorkspace(projectId)
    expect(restored.success).toBe(true)

    expect(await relationCount(s)).toBe(before.relations)
    expect(await rowCount(s)).toBe(before.rows)
    expect(await indexCount(s)).toBe(before.indexes)
    expect(await constraintCount(s)).toBe(before.constraints)
    expect(await policyCount(s)).toBe(before.policies)
    // The dump carries ENABLE and FORCE; losing FORCE would silently expose
    // every row to the table owner.
    expect(await forceRlsCount(s)).toBe(before.forceRls)
    // GRANTs are the one thing the dump does NOT carry: backupWorkspace runs
    // pg_dump with --no-privileges. The owner's implicit privileges come back
    // with the tables, but an explicit grant to another role does not.
    //
    // On a real Backenly install this is invisible, because the
    // backenly_ddl_watch event trigger re-applies grants on CREATE TABLE — a
    // cold-install restore came back with 39/39. A bare schema like this one
    // has no such trigger, which is what makes the gap visible here. Anything
    // relying on the dump ALONE to carry access is relying on something it
    // does not do.
    // The application must still own its own workspace. Restoring over
    // BACKUP_DATABASE_URL used to re-own the schema and every table to the
    // backup role, because pg_dump runs --no-owner and psql creates what it
    // replays as the connected role. FORCE RLS keys on the owner, so that
    // silently rewrote who the policies bind — invisible wherever one
    // superuser is both roles.
    expect(await schemaOwnerOf(s)).toBe(APP_ROLE)
    expect(await ownerOf(s, 'customers')).toBe(APP_ROLE)
    expect(await grantsTo(s, APP_ROLE)).toBe(beforeOwnerGrants)
    expect(await grantsTo(s, BACKUP_ROLE)).toBe(0)
    expect(await grantCount(s)).toBe(before.grants - beforeBackupGrants)
    expect(await asideCount(s)).toBe(0)
  }, 180_000)

  it('puts the original schema back when the restore cannot complete', async () => {
    const projectId = await makeProject()
    const s = schemaOf(projectId)
    await seedProductionShapedWorkspace(projectId)

    process.env.DATABASE_URL = urlFor(APP_ROLE)
    process.env.BACKUP_DATABASE_URL = urlFor(BACKUP_ROLE)

    const backup = await backupWorkspace(projectId)
    expect(backup.success).toBe(true)

    const before = {
      rows: await rowCount(s),
      policies: await policyCount(s),
      forceRls: await forceRlsCount(s),
    }

    // A readable archive that restores nothing: psql exits 0 on this, which is
    // exactly how the original defect reported success over an emptied schema.
    const zlib = require('zlib')
    fs.writeFileSync(backup.filePath!, zlib.gzipSync(Buffer.from('SELECT 1;\n')))

    const restored = await restoreWorkspace(projectId)
    expect(restored.success).toBe(false)

    // The rename-aside path must have put the project back, intact.
    expect(await rowCount(s)).toBe(before.rows)
    expect(await policyCount(s)).toBe(before.policies)
    expect(await forceRlsCount(s)).toBe(before.forceRls)
    expect(await asideCount(s)).toBe(0)
  }, 180_000)
})
