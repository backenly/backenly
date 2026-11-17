/**
 * THE SCHEMA-DROP STEP AGAINST THE REAL POSTGREST REGISTRY
 * =======================================================
 * lib/postgrest/retire-schema.ts drops a schema PostgREST does not serve at
 * once, and stops serving one it does: unregistered in the same transaction,
 * which tells PostgREST to read its list again, and kept for a later drop.
 * Here the registry is the one production installs, so what "served" and
 * "unregistered" mean is the registry's own answer.
 *
 * A database of its own, with the registry installed as the installer installs
 * it: its event triggers are database-wide, and registering writes the
 * authenticator's settings, which are cluster-wide, so the authenticator is a
 * throwaway role (as in postgrest-reload-on-drop.spec.ts).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Client, type Notification } from 'pg'
import { servedAmong } from '@/lib/postgrest/registration'
import { dropOrRetireSchemas, type SchemaSql } from '@/lib/postgrest/retire-schema'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = `backenly_retire_${randomBytes(4).toString('hex')}`
const TEST_AUTHENTICATOR = `bkn_auth_test_${randomBytes(4).toString('hex')}`

const projectId = randomUUID()
const served = `workspace_${projectId}`
const vault = `${served}_r1`

let DB_URL = ''
let client: Client
let listener: Client
const heard: string[] = []

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

async function adminExec(query: string): Promise<void> {
  const admin = new Client({ connectionString: urlForDatabase(ADMIN_URL!, 'postgres') })
  await admin.connect()
  try {
    await admin.query(query)
  } finally {
    await admin.end()
  }
}

/** The step's view of a database: node-postgres behind the two raw methods it uses. */
function sqlOf(c: Client): SchemaSql {
  return {
    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]) => (await c.query(query, values)).rows as T,
    $executeRawUnsafe: async (query: string, ...values: unknown[]) => (await c.query(query, values)).rowCount ?? 0,
  }
}

async function exists(name: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [name])).rowCount === 1
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  DB_URL = urlForDatabase(ADMIN_URL, DB_NAME)

  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await adminExec(`CREATE DATABASE ${DB_NAME}`)
  await adminExec(`ALTER DATABASE ${DB_NAME} SET backenly.app_role = '${new URL(ADMIN_URL).username}'`)

  client = new Client({ connectionString: DB_URL })
  await client.connect()
  // In the installer's order: the registry first, then the DDL sync.
  for (const file of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
    const text = fs
      .readFileSync(path.join(process.cwd(), 'scripts', 'sql', file), 'utf8')
      .replace(/backenly_authenticator/g, TEST_AUTHENTICATOR)
    await client.query(text)
  }

  // A canonical workspace schema registers itself (backenly_pgrst_on_schema_create).
  await client.query(`CREATE SCHEMA "${served}"`)
  await client.query(`CREATE TABLE "${served}".orders (id int PRIMARY KEY)`)
  await client.query(`CREATE SCHEMA "${vault}"`)

  listener = new Client({ connectionString: DB_URL })
  await listener.connect()
  listener.on('notification', (n: Notification) => {
    if (n.channel === 'pgrst') heard.push(n.payload ?? '')
  })
  await listener.query('LISTEN pgrst')
}, 120_000)

afterAll(async () => {
  await listener?.end().catch(() => {})
  await client?.query(`DROP OWNED BY ${TEST_AUTHENTICATOR} CASCADE`).catch(() => {})
  await client?.end().catch(() => {})
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {})
  await adminExec(`DROP ROLE IF EXISTS ${TEST_AUTHENTICATOR}`).catch(() => {})
}, 120_000)

it('reads which schemas the registry serves', async () => {
  expect(await servedAmong(sqlOf(client), [served, vault, 'scratch'])).toEqual([served])
})

it('stops serving a served schema in the transaction and keeps it, and drops one nothing serves', async () => {
  heard.length = 0
  await client.query('BEGIN')
  const out = await dropOrRetireSchemas(sqlOf(client), [served, vault])
  await client.query('COMMIT')
  expect(out).toEqual({ dropped: [vault], retired: [served] })

  expect(await exists(served)).toBe(true)
  expect(await exists(vault)).toBe(false)
  const [{ list }] = (await client.query(`SELECT public.backenly_pgrst_current_schemas() AS list`)).rows
  expect(String(list ?? '').split(',')).not.toContain(served)

  // Told at commit to read the list again.
  const until = Date.now() + 1_500
  while (!heard.includes('reload config') && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  expect(heard).toContain('reload config')
})

it('drops the retired schema once asked again, now that nothing serves it', async () => {
  const out = await dropOrRetireSchemas(sqlOf(client), [served])
  expect(out).toEqual({ dropped: [served], retired: [] })
  expect(await exists(served)).toBe(false)
})
