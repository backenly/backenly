/**
 * POSTGREST FORGETS WHAT A STATEMENT DROPPED OR MOVED INTO A VAULT
 * ===============================================================
 * PostgREST serves from a schema cache it rebuilds when told to, on the pgrst
 * channel. The DDL event trigger (scripts/sql/postgrest-ddl-sync.sql) told it
 * on ddl_command_end, which reports what a statement created or altered and
 * never what it dropped, and reports a moved table only by the schema it moved
 * to. So:
 *
 *   DROP TABLE, DROP VIEW, DROP FUNCTION   no reload: the dropped object stayed
 *                                          in the cache, and requests for it
 *                                          failed in the database
 *   moving a table into a change's vault   no reload either: a vault is not a
 *                                          served schema, so it was skipped
 *
 * The drops now reach an sql_drop trigger, and a move into the vault of a
 * served schema reloads without granting anything there.
 *
 * A database of its own, with the two files installed as the installer
 * installs them: event triggers are database-wide, and registering a schema
 * writes the authenticator's settings, which are cluster-wide, so the
 * authenticator is a throwaway role (as in postgrest-roles-idempotency).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Client, type Notification } from 'pg'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = `backenly_pgrst_drop_${randomBytes(4).toString('hex')}`
const TEST_AUTHENTICATOR = `bkn_auth_test_${randomBytes(4).toString('hex')}`

let DB_URL = ''
const projectId = randomUUID()
const served = `workspace_${projectId}`
const vault = `${served}_r1`

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

async function adminExec(query: string): Promise<void> {
  const client = new Client({ connectionString: urlForDatabase(ADMIN_URL!, 'postgres') })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

async function sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  try {
    return (await client.query(query, params)).rows as T[]
  } finally {
    await client.end()
  }
}

let listener: Client
const heard: string[] = []

/** What the pgrst channel heard while `statement` ran and committed. */
async function heardFrom(statement: string): Promise<string[]> {
  heard.length = 0
  await sql(statement)
  // A notification is delivered at commit; give it a moment to arrive.
  const until = Date.now() + 1_500
  while (heard.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 150))
  return [...heard]
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  DB_URL = urlForDatabase(ADMIN_URL, DB_NAME)

  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await adminExec(`CREATE DATABASE ${DB_NAME}`)
  await adminExec(`ALTER DATABASE ${DB_NAME} SET backenly.app_role = '${new URL(ADMIN_URL).username}'`)

  // In the installer's order: the registry first, then the DDL sync.
  for (const file of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
    const text = fs
      .readFileSync(path.join(process.cwd(), 'scripts', 'sql', file), 'utf8')
      .replace(/backenly_authenticator/g, TEST_AUTHENTICATOR)
    await sql(text)
  }

  // A canonical workspace schema registers itself (backenly_pgrst_on_schema_create).
  await sql(`CREATE SCHEMA "${served}"`)
  await sql(`CREATE SCHEMA "${vault}"`)
  await sql(`CREATE SCHEMA scratch`)
  expect((await sql<{ s: string }>(`SELECT public.backenly_pgrst_current_schemas() AS s`))[0].s.split(',')).toEqual([served])

  listener = new Client({ connectionString: DB_URL })
  await listener.connect()
  listener.on('notification', (n: Notification) => {
    if (n.channel === 'pgrst') heard.push(n.payload ?? '')
  })
  await listener.query('LISTEN pgrst')
}, 120_000)

afterAll(async () => {
  await listener?.end().catch(() => {})
  await sql(`DROP OWNED BY ${TEST_AUTHENTICATOR} CASCADE`).catch(() => {})
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {})
  await adminExec(`DROP ROLE IF EXISTS ${TEST_AUTHENTICATOR}`).catch(() => {})
}, 120_000)

describe('in a served schema', () => {
  it('a new table reloads the cache, as before', async () => {
    expect(await heardFrom(`CREATE TABLE "${served}".kept (id int PRIMARY KEY)`)).toContain('reload schema')
  })

  it('a dropped table reloads it', async () => {
    await heardFrom(`CREATE TABLE "${served}".doomed (id int PRIMARY KEY)`)
    expect(await heardFrom(`DROP TABLE "${served}".doomed`)).toContain('reload schema')
  })

  it('a dropped view and a dropped function reload it', async () => {
    await heardFrom(`CREATE VIEW "${served}".kept_ids AS SELECT id FROM "${served}".kept`)
    expect(await heardFrom(`DROP VIEW "${served}".kept_ids`)).toContain('reload schema')
    await heardFrom(`CREATE FUNCTION "${served}".answer() RETURNS int LANGUAGE sql AS $$ SELECT 42 $$`)
    expect(await heardFrom(`DROP FUNCTION "${served}".answer()`)).toContain('reload schema')
  })

  it('a table moved into its vault reloads it, and nothing in the vault is granted', async () => {
    await heardFrom(`CREATE TABLE "${served}".moved (id int PRIMARY KEY)`)
    expect(await heardFrom(`ALTER TABLE "${served}".moved SET SCHEMA "${vault}"`)).toContain('reload schema')
    const [grants] = await sql<{ anon: boolean; authenticated: boolean }>(
      `SELECT has_schema_privilege('anon', $1, 'USAGE') AS anon, has_schema_privilege('authenticated', $1, 'USAGE') AS authenticated`,
      [vault],
    )
    expect(grants).toEqual({ anon: false, authenticated: false })
  })

  it('a table brought back from its vault reloads it, as before', async () => {
    expect(await heardFrom(`ALTER TABLE "${vault}".moved SET SCHEMA "${served}"`)).toContain('reload schema')
  })
})

describe('outside every served schema', () => {
  it('creating and dropping reload nothing', async () => {
    expect(await heardFrom(`CREATE TABLE scratch.loose (id int)`)).toEqual([])
    expect(await heardFrom(`DROP TABLE scratch.loose`)).toEqual([])
  })
})
