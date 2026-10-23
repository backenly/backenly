/**
 * RUN_TEST "CREATE" WRITES A REAL ROW, AS A SIGNED-IN TEST USER (#248)
 * ===================================================================
 * create used to POST a sample row with the project's anon key, which may not
 * write: every routed table refused it, the refusal counted as a pass, and a
 * broken insert path passed with it. Now it signs a throwaway end user up,
 * inserts as that user, judges the answer and removes the row and the user
 * (lib/ai/brain/verify-create.ts):
 *   - a trigger that refuses the row is a failure, with the database's reason;
 *   - a CHECK the old sample row broke, and a NOT NULL column with a default,
 *     insert;
 *   - an owned table's row is owned by the test user, and a required parent
 *     row is added first, owned by them too;
 *   - a table only the service role writes is refused by design: a pass that
 *     says the insert path was not exercised;
 *   - a missing INSERT grant and a policy that refuses users their own rows
 *     are failures;
 *   - a project without end-user sign-up has no one to write as: the anon key's
 *     refusal is the one that passes, and it says so.
 * Every case leaves no test row and no test user behind.
 *
 * The real runtime (server/app) serves the requests in process: sign-up, the
 * key and the user's token, the gateway to the data plane. PostgREST is not in
 * the integration job, so a stand-in plays it for the one request it gets, an
 * insert, run in the real database as the role and with the claims the
 * gateway's token carries, and answered with PostgREST's statuses. The row
 * level security is the policies Backenly installs.
 */

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { Pool } from 'pg'
import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { runEndpointTest } from '@/lib/ai/brain/verifier'
import { applyPermissionPolicy, autoApplyRlsIfNeeded } from '@/lib/services/workspace-rls'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

const PGRST_SECRET = crypto.randomBytes(32).toString('hex')
const saved = {
  POSTGREST_URL: process.env.POSTGREST_URL,
  POSTGREST_JWT_SECRET: process.env.POSTGREST_JWT_SECRET,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
}

let ownerId: string
/** A project with end-user sign-up: a users table and a signing secret. */
let projectId: string
/** A project without it. */
let bareProjectId: string
let runtime: http.Server
let postgrest: http.Server
let pool: Pool

const schemaOf = (id: string) => `workspace_${id}`
const s = () => `"${schemaOf(projectId)}"`

/** Every insert the stand-in ran, and as whom. */
const inserts: Array<{ table: string; role: string; sub: string | undefined; row: Record<string, unknown> }> = []

/**
 * PostgREST's answer to a failed statement: its status for the SQLSTATE, and
 * its body. 42501 is 401 for the anonymous role and 403 for any other.
 */
function postgrestError(err: { code?: string; message?: string; detail?: string; hint?: string }, role: string) {
  const code = err.code ?? ''
  const status =
    code === '42501' ? (role === 'anon' ? 401 : 403)
      : code === '23503' || code === '23505' ? 409
        : code === '42P01' ? 404
          : code.startsWith('22') || code.startsWith('23') || code === 'P0001' ? 400
            : 500
  return { status, body: { code, message: err.message ?? '', details: err.detail ?? null, hint: err.hint ?? null } }
}

/** PostgREST, for an insert: the role and claims from the gateway's token, the schema from Content-Profile. */
function postgrestStandIn(): http.Server {
  return http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (req.method !== 'POST') return reply(405, { message: 'this stand-in only inserts' })
    let claims: { role: string; sub?: string }
    try {
      claims = jwt.verify(String(req.headers.authorization).replace(/^Bearer /, ''), PGRST_SECRET) as typeof claims
    } catch {
      return reply(401, { code: 'PGRST301', message: 'JWT invalid' })
    }
    const table = decodeURIComponent(new URL(req.url!, 'http://postgrest').pathname.replace(/^\/+/, ''))
    const schema = String(req.headers['content-profile'])
    const row = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(claims.role)}`)
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
      const target = `${client.escapeIdentifier(schema)}.${client.escapeIdentifier(table)}`
      const columns = Object.keys(row).map((c) => client.escapeIdentifier(c)).join(', ')
      const { rows } = await client.query(
        columns
          ? `INSERT INTO ${target} (${columns}) SELECT ${columns} FROM json_populate_record(NULL::${target}, $1::json) RETURNING *`
          : `INSERT INTO ${target} DEFAULT VALUES RETURNING *`,
        columns ? [JSON.stringify(row)] : [],
      )
      await client.query('COMMIT')
      inserts.push({ table, role: claims.role, sub: claims.sub, row: rows[0] })
      reply(201, rows)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      const { status, body } = postgrestError(err as Record<string, string>, claims.role)
      reply(status, body)
    } finally {
      client.release()
    }
  })
}

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A project with an anon key, as provisioning gives one: a public key that reads and writes. */
async function newProject(name: string, jwtSecret: string | null): Promise<string> {
  const anonKey = `bk_live_${crypto.randomBytes(24).toString('hex')}`
  const id = (await prisma.project.create({
    data: { name, userId: ownerId, anonKey, ...(jwtSecret ? { jwtSecret } : {}) },
    select: { id: true },
  })).id
  await prisma.apiKey.create({
    data: {
      name: 'Public Anon Key', keyHash: hashApiKey(anonKey), keyPrefix: anonKey.slice(0, 16), projectId: id, userId: ownerId,
      permissions: ['read', 'write'], keyType: 'public', serviceRole: false,
    },
  })
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaOf(id)}"`)
  return id
}

/** The data plane's grants (scripts/sql/postgrest-ddl-sync.sql): anon reads, the others read and write. */
async function grantDataPlane(id: string) {
  const sch = `"${schemaOf(id)}"`
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${sch} TO anon, authenticated, service_role`)
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${sch} TO authenticated, service_role`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${sch} TO anon`)
  await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${sch} TO authenticated, service_role`)
}

const create = (tableName: string, id = projectId) => runEndpointTest({ projectId: id, tableName, operation: 'create' })

const count = async (sql: string) => (await prisma.$queryRawUnsafe<Array<{ n: number }>>(sql))[0].n

/** No test row in the tables, and no test user left in the project. */
async function expectNothingLeft(...tables: string[]) {
  for (const table of tables) expect(await count(`SELECT count(*)::int AS n FROM ${s()}."${table}"`)).toBe(0)
  expect(await count(`SELECT count(*)::int AS n FROM ${s()}.users WHERE email ILIKE '%@%.internal'`)).toBe(0)
}

beforeAll(async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await prisma.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
    )
  }
  ownerId = (await prisma.user.create({
    data: { email: `run-test-create-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'run_test create' },
    select: { id: true },
  })).id

  projectId = await newProject('run-test-create', crypto.randomBytes(32).toString('hex'))
  const ref = (table: string) => `REFERENCES ${s()}."${table}"(id)`
  for (const ddl of [
    `CREATE TABLE ${s()}.users (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
       name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now())`,
    // Owned by a user.
    `CREATE TABLE ${s()}.notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')}, body text NOT NULL)`,
    // A trigger that refuses every row.
    `CREATE TABLE ${s()}.gated (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')}, title text NOT NULL)`,
    `CREATE FUNCTION ${s()}.refuse_gated() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'gated: the trigger refused this row'; END $$`,
    `CREATE TRIGGER refuse BEFORE INSERT ON ${s()}.gated FOR EACH ROW EXECUTE FUNCTION ${s()}.refuse_gated()`,
    // A CHECK the old sample row ('brain-verify-status') broke.
    `CREATE TABLE ${s()}.drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')},
       status text NOT NULL CHECK (status IN ('draft', 'published')))`,
    // A NOT NULL column the database fills in: sending any other value breaks its CHECK.
    `CREATE TABLE ${s()}.stamped (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')},
       kind text NOT NULL DEFAULT 'auto' CHECK (kind = 'auto'), seq integer GENERATED ALWAYS AS IDENTITY)`,
    // Owned through a required parent.
    `CREATE TABLE ${s()}.lists (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')}, name text NOT NULL)`,
    `CREATE TABLE ${s()}.list_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), list_id uuid NOT NULL ${ref('lists')}, label text NOT NULL)`,
    // Owned by no end user: only the service role writes it.
    `CREATE TABLE ${s()}.categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`,
    // Owned, but signed-in users have no INSERT grant.
    `CREATE TABLE ${s()}.locked (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')}, note text NOT NULL)`,
    // Owned, but a policy refuses users their own new rows.
    `CREATE TABLE ${s()}.refusing (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL ${ref('users')}, note text NOT NULL)`,
  ]) await prisma.$executeRawUnsafe(ddl)
  await grantDataPlane(projectId)
  await prisma.$executeRawUnsafe(`REVOKE INSERT ON ${s()}.locked FROM authenticated`)
  for (const table of ['notes', 'gated', 'drafts', 'stamped', 'lists', 'list_items', 'locked', 'refusing']) {
    await autoApplyRlsIfNeeded(projectId, table)
  }
  const installed = await applyPermissionPolicy(projectId, { tableName: 'categories', template: 'public_read' })
  expect(installed.success).toBe(true)
  await prisma.$executeRawUnsafe(
    `CREATE POLICY no_new_rows ON ${s()}.refusing AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false)`,
  )

  bareProjectId = await newProject('run-test-create-bare', null)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schemaOf(bareProjectId)}".open_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL)`)
  await grantDataPlane(bareProjectId)

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  process.env.POSTGREST_URL = await listen((postgrest = postgrestStandIn()))
  process.env.POSTGREST_JWT_SECRET = PGRST_SECRET
  process.env.NEXT_PUBLIC_APP_URL = await listen((runtime = http.createServer(app)))
}, 120_000)

beforeEach(() => {
  inserts.length = 0
})

afterAll(async () => {
  await new Promise((resolve) => runtime?.close(resolve))
  await new Promise((resolve) => postgrest?.close(resolve))
  await pool?.end().catch(() => {})
  await flushRecordedRequests().catch(() => {})
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const id of [projectId, bareProjectId]) {
    if (!id) continue
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaOf(id)}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('run_test create, as a signed-in test user', () => {
  it('fails on a trigger that refuses the row, naming the database\'s reason', async () => {
    const result = await create('gated')

    expect(result).toMatchObject({ ok: false, failureKind: 'bad_request', statusCode: 400, method: 'POST' })
    expect(result.summary).toMatch(/the insert failed\. The database says: gated: the trigger refused this row/)
    await expectNothingLeft('gated')
  })

  it('inserts a row whose CHECK the old sample value broke, then removes it', async () => {
    const result = await create('drafts')

    expect(result).toMatchObject({ ok: true, statusCode: 201 })
    expect(result.summary).toMatch(/a row was inserted as a signed-in test user, so the insert path works\. The test row was removed again\./)
    expect(inserts).toEqual([expect.objectContaining({ table: 'drafts', role: 'authenticated', row: expect.objectContaining({ status: 'draft' }) })])
    await expectNothingLeft('drafts')
  })

  it('leaves a column the database fills in to the database', async () => {
    const result = await create('stamped')

    expect(result).toMatchObject({ ok: true, statusCode: 201 })
    expect(inserts[0].row).toMatchObject({ kind: 'auto', seq: expect.any(Number) })
    await expectNothingLeft('stamped')
  })

  it('writes an owned row as its owner, the test user', async () => {
    const result = await create('notes')

    expect(result).toMatchObject({ ok: true, statusCode: 201 })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ table: 'notes', role: 'authenticated' })
    expect(inserts[0].row.user_id).toBe(inserts[0].sub)
    await expectNothingLeft('notes')
  })

  it('adds the parent a row requires, owned by the test user, and removes both', async () => {
    const result = await create('list_items')

    expect(result).toMatchObject({ ok: true, statusCode: 201 })
    // The parent went in directly as the service role; only the child went through the endpoint.
    expect(inserts).toEqual([expect.objectContaining({ table: 'list_items', role: 'authenticated' })])
    await expectNothingLeft('list_items', 'lists')
  })

  it('passes a table only the service role writes, saying the insert path was not exercised', async () => {
    const result = await create('categories')

    expect(result).toMatchObject({ ok: true, statusCode: 403 })
    expect(result.summary).toMatch(/signed-in users may not insert into "categories"/)
    expect(result.summary).toMatch(/the insert path itself was not exercised/)
    await expectNothingLeft('categories')
  })

  it('fails when signed-in users have no INSERT grant', async () => {
    const result = await create('locked')

    expect(result).toMatchObject({ ok: false, failureKind: 'forbidden', statusCode: 403 })
    expect(result.summary).toMatch(/\(authenticated\) has no INSERT grant on "locked"/)
    await expectNothingLeft('locked')
  })

  it('fails when the policy refuses users a row of their own', async () => {
    const result = await create('refusing')

    expect(result).toMatchObject({ ok: false, failureKind: 'forbidden', statusCode: 403 })
    expect(result.summary).toMatch(/row-level security refused a row owned by the signed-in test user/)
    await expectNothingLeft('refusing')
  })
})

describe('run_test create on a project without end-user sign-up', () => {
  it('counts the anon key being refused as a pass, and says the insert path was not exercised', async () => {
    const result = await create('open_notes', bareProjectId)

    expect(result).toMatchObject({ ok: true, statusCode: 401 })
    expect(result.summary).toMatch(/This project has no end-user sign-up, so there was no one to write as/)
    expect(result.summary).toMatch(/not exercised/)
    expect(await count(`SELECT count(*)::int AS n FROM "${schemaOf(bareProjectId)}".open_notes`)).toBe(0)
    // Signing the test user up did not set end-user auth up on the project.
    expect(await count(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = '${schemaOf(bareProjectId)}' AND table_name = 'users'`,
    )).toBe(0)
  })
})
