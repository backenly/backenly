/**
 * A PORTABLE EXPORT'S POLICIES RESTORE ON A REAL POSTGRESQL SERVER
 * ================================================================
 * Production QA (2026-11-09): the portable export left out every CREATE
 * POLICY, so a restore had FORCE ROW LEVEL SECURITY with nothing that allowed
 * a row. Now every policy comes with its table, and one written for particular
 * roles is created for those of its roles the destination has
 * (lib/services/export-policies.ts).
 *
 * This suite runs the SQL the export writes against PostgreSQL itself, so the
 * statements are proven where they run, not by their text. tests/integration/
 * export-database-rls.spec.ts restores a whole export made by the real pg_dump.
 */
import { Client } from 'pg'
import { randomBytes } from 'crypto'
import { portablePolicies } from '@/lib/services/export-policies'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
}

const suffix = randomBytes(4).toString('hex')
const schema = `export_policies_${suffix}`
const here = `bkn_export_${suffix}` // a role this server has
const gone = `bkn_gone_${suffix}` // a role it does not

let db: Client
const said: string[] = [] // what the server said to the session, warnings included

/** What pg_dump writes before an object (_printTocEntry). */
const header = (name: string, type: string) => `--\n-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: -\n--\n\n`

const portable = (dump: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const filter = portablePolicies()
    filter.on('data', (d: Buffer) => out.push(Buffer.from(d)))
    filter.on('end', () => resolve(Buffer.concat(out).toString('utf8')))
    filter.on('error', reject)
    filter.end(Buffer.from(dump, 'utf8'))
  })

async function policy(name: string) {
  const { rows } = await db.query(
    `SELECT p.permissive, p.roles::text[] AS roles, p.cmd, p.qual, obj_description(pol.oid, 'pg_policy') AS comment
       FROM pg_policies p
       JOIN pg_policy pol ON pol.polname = p.policyname AND pol.polrelid = format('%I.%I', p.schemaname, p.tablename)::regclass
      WHERE p.schemaname = $1 AND p.tablename = 'orders' AND p.policyname = $2`,
    [schema, name],
  )
  return rows[0] ?? null
}

beforeAll(async () => {
  assertSafeTestDatabase()
  db = new Client({ connectionString: DB_URL })
  await db.connect()
  db.on('notice', (n) => said.push(`${n.severity}: ${n.message}`))
  // Every dump sets this before anything else (_doSetFixedOutputState), so
  // only a warning or worse reaches the person restoring it.
  await db.query('SET client_min_messages = warning')
  await db.query(`CREATE ROLE ${here} NOLOGIN`)
  await db.query(`CREATE SCHEMA ${schema}`)
  await db.query(`CREATE TABLE ${schema}.orders (id int, user_id text, deleted_at timestamptz)`)
})

afterAll(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
  await db.query(`DROP ROLE IF EXISTS ${here}`).catch(() => {})
  await db.end()
})

it('restores a policy that applies to every role exactly as written', async () => {
  const sql = await portable(
    header('orders own_rows', 'POLICY') +
      `CREATE POLICY own_rows ON ${schema}.orders USING ((user_id = current_setting('app.user_id'::text, true)));\n`,
  )
  await db.query(sql)
  expect(await policy('own_rows')).toEqual({
    permissive: 'PERMISSIVE',
    roles: ['public'],
    cmd: 'ALL',
    qual: "(user_id = current_setting('app.user_id'::text, true))",
    comment: null,
  })
})

it('creates a policy for those of its roles this server has, with its comment', async () => {
  const sql = await portable(
    header('orders soft_delete', 'POLICY') +
      `CREATE POLICY soft_delete ON ${schema}.orders AS RESTRICTIVE FOR SELECT TO ${gone}, ${here} USING ((deleted_at IS NULL));\n\n\n` +
      header('POLICY soft_delete ON orders', 'COMMENT') +
      `COMMENT ON POLICY soft_delete ON ${schema}.orders IS 'Hides deleted rows; kept';\n`,
  )
  await db.query(sql)
  expect(await policy('soft_delete')).toEqual({
    permissive: 'RESTRICTIVE',
    roles: [here],
    cmd: 'SELECT',
    qual: '(deleted_at IS NULL)',
    comment: 'Hides deleted rows; kept',
  })
})

it('skips a policy when this server has none of its roles, warns, and skips its comment', async () => {
  said.length = 0
  const sql = await portable(
    header('orders direct_read', 'POLICY') +
      `CREATE POLICY direct_read ON ${schema}.orders FOR SELECT TO ${gone} USING (true);\n\n\n` +
      header('POLICY direct_read ON orders', 'COMMENT') +
      `COMMENT ON POLICY direct_read ON ${schema}.orders IS 'Never here';\n`,
  )
  await db.query(sql) // a clean restore: nothing in it fails
  expect(await policy('direct_read')).toBeNull()
  expect(said).toEqual([
    `WARNING: Policy direct_read on ${schema}.orders was not restored: this server has none of its roles (${gone}).`,
  ])
})
