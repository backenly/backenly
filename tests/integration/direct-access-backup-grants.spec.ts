/**
 * THE BACKUP ROLE READS EVERY WORKSPACE
 * =====================================
 * Snapshots run pg_dump as the backup role. It locks every table of the schema
 * it dumps, so a schema it cannot use, or one table it cannot read, fails every
 * snapshot of that project with "permission denied". This suite pins what
 * grants it, and when (scripts/setup-direct-access.sql,
 * backenly_direct_sync_schema):
 *
 *   a workspace with no direct-access role   granted by the sync, which used to
 *                                            return before reaching the grant,
 *                                            so no such project could be dumped
 *   a table the application adds later       a default privilege for the
 *                                            application role
 *   a table the developer adds directly      a default privilege for their
 *                                            read-write role, before adoption
 *   a table no default privilege covers      the next sync
 *   every workspace that already exists      installing the file again
 *   a project the application creates        provisioning (lib/projects/provision.ts)
 *   a project without credentials, after DDL the application's sync
 *                                            (syncDirectAccessGrants)
 *
 * The application role is named through the seam the definers resolve it with
 * (backenly.app_role, read first by public.backenly_app_role()), so the suite
 * does not depend on which roles the shared cluster happens to hold.
 *
 * Real Postgres: the property is who may read what, which only the catalog can say.
 */
import { execFileSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { syncDirectAccessGrants } from '@/lib/services/direct-access'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const hex = randomBytes(6).toString('hex')
// A workspace with READ_WRITE direct access, and one whose project never had any.
const schema = `workspace_${randomUUID()}`
const plain = `workspace_${randomUUID()}`
const rw = `bkn_rw_${hex}`
const own = `bkn_own_${hex}`
const app = `bkn_test_app_${hex}`
const BACKUP = 'backenly_backup'
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let db: Client
let createdBackupRole = false
let ownerId = ''

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const canRead = async (role: string, rel: string) =>
  (await q(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, rel]))[0].ok as boolean
const canUse = async (role: string, nsp: string) =>
  (await q(`SELECT has_schema_privilege($1, $2, 'USAGE') AS ok`, [role, nsp]))[0].ok as boolean
const ownerOf = async (rel: string) =>
  (await q(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = $1::regclass`, [rel]))[0].owner as string
const sync = () =>
  q(`SELECT public.backenly_direct_sync_schema($1, NULL, $2, $3) AS ok`, [schema, rw, own])
/** As the application does for a project without credentials: the schema alone. */
const syncPlain = () => q(`SELECT public.backenly_direct_sync_schema($1) AS ok`, [plain])
/** As the application role, which creates every table a platform path makes. */
const asApp = async (sql: string) => {
  await q(`SET ROLE ${app}`)
  try {
    await q(sql)
  } finally {
    await q(`RESET ROLE`)
  }
}
// Options before the connection, database with -d (see sql-workspace-isolation).
const install = () =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', CONN], {
    stdio: 'pipe',
  })

beforeAll(async () => {
  install()
  db = new Client({ connectionString: CONN })
  await db.connect()
  if ((await q(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [BACKUP])).length === 0) {
    await q(`CREATE ROLE ${BACKUP} NOLOGIN BYPASSRLS`)
    createdBackupRole = true
  }
  await q(`CREATE ROLE ${app} NOLOGIN`)
  await q(`SET backenly.app_role = '${app}'`)
  await q(`CREATE SCHEMA "${schema}" AUTHORIZATION ${app}`)
  await q(`CREATE ROLE ${rw} NOLOGIN`)
  // Provision: the rw role gets USAGE + CREATE, the owner role takes the schema.
  await sync()
}, 120_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ownerId) {
    const ids = (await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true } })).map((p) => p.id)
    for (const id of ids) await q(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  }
  await q(`RESET backenly.app_role`).catch(() => {})
  for (const nsp of [schema, plain]) await q(`DROP SCHEMA IF EXISTS "${nsp}" CASCADE`).catch(() => {})
  for (const role of [rw, own, app]) {
    await q(`DROP OWNED BY ${role}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  if (createdBackupRole) {
    await q(`DROP OWNED BY ${BACKUP}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${BACKUP}`).catch(() => {})
  }
  await db.end()
}, 60_000)

describe('the sync and the backup role', () => {
  it('grants a workspace with no direct-access role, which it used to skip', async () => {
    await q(`CREATE SCHEMA "${plain}" AUTHORIZATION ${app}`)
    await asApp(`CREATE TABLE "${plain}".notes (id serial PRIMARY KEY, body text)`)
    // A project made before the sync covered it: nothing granted, so its
    // snapshots fail "permission denied for schema".
    expect(await canUse(BACKUP, plain)).toBe(false)

    expect(await syncPlain()).toEqual([{ ok: true }])

    expect(await canUse(BACKUP, plain)).toBe(true)
    expect(await canRead(BACKUP, `"${plain}".notes`)).toBe(true)
    expect(await canRead(BACKUP, `"${plain}".notes_id_seq`)).toBe(true)
    // Nothing a direct-access sync does: the schema and its table stay the application's.
    expect((await q(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`, [plain]))[0].owner).toBe(app)
    expect(await ownerOf(`"${plain}".notes`)).toBe(app)
  })

  it('lets it read each table the application adds after the sync, with no further sync', async () => {
    await asApp(`CREATE TABLE "${plain}".invoices (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, total int)`)
    expect(await canRead(BACKUP, `"${plain}".invoices`)).toBe(true)
    expect(await canRead(BACKUP, `"${plain}".invoices_id_seq`)).toBe(true)
  })

  it('lets it read a table the developer creates directly, from its creation through adoption', async () => {
    // The developer's own DDL, as their read-write role.
    await q(`SET ROLE ${rw}`)
    await q(`CREATE TABLE "${schema}".orders (id serial PRIMARY KEY, total int)`)
    await q(`RESET ROLE`)
    const table = `"${schema}".orders`
    const seq = `"${schema}".orders_id_seq`

    // Before adoption, which may wait for the owner's approval.
    expect(await canRead(BACKUP, table)).toBe(true)
    expect(await canRead(BACKUP, seq)).toBe(true)

    // Adoption syncs again and hands the table to the owner role; the read stays.
    await sync()
    expect(await ownerOf(table)).toBe(own)
    expect(await canRead(BACKUP, table)).toBe(true)
    expect(await canRead(BACKUP, seq)).toBe(true)
    expect(await canUse(BACKUP, schema)).toBe(true)
    // Read only: the grant must not give the backup role any write.
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect((await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [BACKUP, table, p]))[0].ok).toBe(false)
    }
    expect((await q(`SELECT has_schema_privilege($1, $2, 'CREATE') AS ok`, [BACKUP, schema]))[0].ok).toBe(false)
  })

  it('grants at the next sync a table no default privilege covered', async () => {
    // Made by a role the sync sets no default for (this session's own), as a
    // table made by hand would be.
    await q(`CREATE TABLE "${schema}".by_hand (id int)`)
    expect(await canRead(BACKUP, `"${schema}".by_hand`)).toBe(false)
    await sync()
    expect(await canRead(BACKUP, `"${schema}".by_hand`)).toBe(true)
  })

  it('converges every existing workspace when the file is installed again', async () => {
    const before = `workspace_${randomUUID()}`
    await q(`CREATE SCHEMA "${before}" AUTHORIZATION ${app}`)
    try {
      await asApp(`CREATE TABLE "${before}".kept (id serial PRIMARY KEY)`)
      expect(await canUse(BACKUP, before)).toBe(false)

      install()

      expect(await canUse(BACKUP, before)).toBe(true)
      expect(await canRead(BACKUP, `"${before}".kept`)).toBe(true)
      expect(await canRead(BACKUP, `"${before}".kept_id_seq`)).toBe(true)
    } finally {
      await q(`DROP SCHEMA IF EXISTS "${before}" CASCADE`)
    }
  })

  it('still syncs when the backup role does not exist', async () => {
    await q(`SET backenly.backup_role = 'no_such_backup_role'`)
    try {
      await expect(sync()).resolves.toEqual([{ ok: true }])
      await expect(syncPlain()).resolves.toEqual([{ ok: true }])
    } finally {
      await q(`RESET backenly.backup_role`)
    }
  })

  it('grants the role named by backenly.backup_role', async () => {
    const custom = `bkn_test_backup_${hex}`
    await q(`CREATE ROLE ${custom} NOLOGIN`)
    await q(`SET backenly.backup_role = '${custom}'`)
    try {
      await sync()
      await syncPlain()
      expect(await canRead(custom, `"${schema}".orders`)).toBe(true)
      expect(await canRead(custom, `"${plain}".notes`)).toBe(true)
    } finally {
      await q(`RESET backenly.backup_role`)
      await q(`DROP OWNED BY ${custom}`)
      await q(`DROP ROLE ${custom}`)
    }
  })
})

describe('the application', () => {
  beforeAll(async () => {
    // Project creation is refused on a single-tenant deployment, the default.
    process.env.BACKENLY_EDITION = 'cloud'
    ownerId = (
      await prisma.user.create({
        data: { email: `backup-grants-${randomUUID()}@example.test`, name: 'backup grants fixture' },
        select: { id: true },
      })
    ).id
  })

  it('grants the backup role on a project’s schema when it creates the project', async () => {
    const created = await createProvisionedProject({ name: `backup-grants-${hex}`, userId: ownerId })
    expect(await canUse(BACKUP, created.postgresSchema)).toBe(true)
  })

  it('grants it on a project without direct-access credentials when it syncs after DDL', async () => {
    const created = await createProvisionedProject({ name: `backup-grants-ddl-${hex}`, userId: ownerId })
    const nsp = created.postgresSchema
    expect(await prisma.databaseCredential.count({ where: { projectId: created.id } })).toBe(0)
    // A table no default privilege covers: made by a role the sync sets none for.
    await q(`GRANT USAGE, CREATE ON SCHEMA "${nsp}" TO ${app}`)
    await asApp(`CREATE TABLE "${nsp}".made_later (id serial PRIMARY KEY)`)
    expect(await canRead(BACKUP, `"${nsp}".made_later`)).toBe(false)

    await syncDirectAccessGrants(created.id)

    expect(await canRead(BACKUP, `"${nsp}".made_later`)).toBe(true)
    expect(await canRead(BACKUP, `"${nsp}".made_later_id_seq`)).toBe(true)
  })
})
