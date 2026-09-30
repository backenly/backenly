/**
 * A table created over a READ_WRITE direct connection is readable by the backup
 * role once it has been synced, so that project's backups keep working.
 *
 * The backup role's default privileges name the roles that created tables when
 * it last converged (scripts/setup-backup-role.ts). A developer's own table
 * belongs to bkn_rw_* (then bkn_own_*), which did not exist then, so pg_dump
 * failed "permission denied" for that project on every run. The sync that every
 * external table passes through on adoption now grants the backup role too
 * (scripts/setup-direct-access.sql, backenly_direct_sync_schema).
 *
 * Real Postgres: the property is who may read what, which only the catalog can say.
 */
import { execFileSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { Client } from 'pg'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const hex = randomBytes(6).toString('hex')
const schema = `workspace_${randomUUID()}`
const rw = `bkn_rw_${hex}`
const own = `bkn_own_${hex}`
const BACKUP = 'backenly_backup'

let db: Client
let createdBackupRole = false

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const canRead = async (role: string, rel: string) =>
  (await q(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, rel]))[0].ok as boolean
const sync = () =>
  q(`SELECT public.backenly_direct_sync_schema($1, NULL, $2, $3) AS ok`, [schema, rw, own])

beforeAll(async () => {
  // Options before the connection, database with -d (see sql-workspace-isolation).
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', CONN], {
    stdio: 'pipe',
  })
  db = new Client({ connectionString: CONN })
  await db.connect()
  if ((await q(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [BACKUP])).length === 0) {
    await q(`CREATE ROLE ${BACKUP} NOLOGIN BYPASSRLS`)
    createdBackupRole = true
  }
  await q(`CREATE SCHEMA "${schema}"`)
  await q(`CREATE ROLE ${rw} NOLOGIN`)
  // Provision: the rw role gets USAGE + CREATE, the owner role takes the schema.
  await sync()
}, 120_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const role of [rw, own]) {
    await q(`DROP OWNED BY ${role}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  if (createdBackupRole) {
    await q(`DROP OWNED BY ${BACKUP}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${BACKUP}`).catch(() => {})
  }
  await db.end()
}, 60_000)

describe('direct-access sync and the backup role', () => {
  it('lets the backup role read a table the developer created directly, once synced', async () => {
    // The developer's own DDL, as their read-write role.
    await q(`SET ROLE ${rw}`)
    await q(`CREATE TABLE "${schema}".orders (id serial PRIMARY KEY, total int)`)
    await q(`RESET ROLE`)
    const table = `"${schema}".orders`
    const seq = `"${schema}".orders_id_seq`

    // Nothing named this role when the backup role converged: the gap itself.
    expect(await canRead(BACKUP, table)).toBe(false)

    await sync()

    expect(await canRead(BACKUP, table)).toBe(true)
    expect((await q(`SELECT has_sequence_privilege($1, $2, 'SELECT') AS ok`, [BACKUP, seq]))[0].ok).toBe(true)
    expect((await q(`SELECT has_schema_privilege($1, $2, 'USAGE') AS ok`, [BACKUP, schema]))[0].ok).toBe(true)
    // Read only: the grant must not give the backup role any write.
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect((await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [BACKUP, table, p]))[0].ok).toBe(false)
    }
  })

  it('still syncs when the backup role does not exist', async () => {
    await q(`SET backenly.backup_role = 'no_such_backup_role'`)
    try {
      await expect(sync()).resolves.toEqual([{ ok: true }])
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
      expect(await canRead(custom, `"${schema}".orders`)).toBe(true)
    } finally {
      await q(`RESET backenly.backup_role`)
      await q(`DROP OWNED BY ${custom}`)
      await q(`DROP ROLE ${custom}`)
    }
  })
})
