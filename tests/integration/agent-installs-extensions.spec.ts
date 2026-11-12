/**
 * AN AGENT INSTALLS AN ALLOWLISTED EXTENSION THE WAY IT WRITES ONE
 * ================================================================
 *
 * Production QA (2026-11-09, report 22): a store's product search used ILIKE,
 * and its agent could not install pg_trgm or citext. apply_migration refused
 * every CREATE EXTENSION, and stripped the operator class from
 * `(name gin_trgm_ops)`; only the console's Install button could install one.
 *
 * Through the real /api/mcp/tool route, against a real database:
 *   - `create extension if not exists pg_trgm with schema extensions` and a
 *     gin_trgm_ops index on a workspace table apply as one migration, into
 *     public whatever SCHEMA said, and the answer says the extension is the
 *     whole database's and is never removed;
 *   - the project's own roles use it: both REST dialects are served by
 *     PostgREST, which runs a request as anon, authenticated or service_role
 *     with the workspace schema and public on its search_path, so a request is
 *     run here in exactly that session;
 *   - a second project on the database sees it installed;
 *   - an install is recorded where the console's is, from either door, and
 *     a recovery of the rest of its migration leaves it and says so;
 *   - a name off the allowlist and a superuser-only one are refused before
 *     anything runs, with the console's reason; DROP and ALTER EXTENSION stay
 *     refused;
 *   - on a protected production a branch migration installs one without
 *     waiting for a person, says it is the whole database's, and the merge a
 *     person approves replays it.
 *
 * Extensions are database-wide, so the suite starts without the ones it
 * installs or refuses and puts back afterwards whatever was there before.
 * Only PostgREST's schema registry is stubbed: a list in an external service's
 * configuration, absent from a test database.
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
// The console route reads its session through next/headers, which only a real
// Next request carries; the session behind the cookie is a real row.
let cookieToken = ''
jest.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'auth-token' && cookieToken ? { value: cookieToken } : undefined) }),
  headers: async () => new Map<string, string>(),
}))

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createSession } from '@/lib/auth/session'
import { createProvisionedProject } from '@/lib/projects/provision'
import { POST as mcpTool } from '@/app/api/mcp/tool/route'
import { POST as installRoute } from '@/app/api/projects/[id]/database/extensions/route'
import { createBranch } from '@/lib/branches/engine'
import { decideApproval } from '@/lib/mcp/approvals'
import { forgetProtection } from '@/lib/branches/protection'
import { listExtensions, resetExtensionPool } from '@/lib/services/extensions'

/** Installed or refused here, so absent when the suite starts. */
const MANAGED = ['pg_trgm', 'citext', 'unaccent', 'fuzzystrmatch', 'pgstattuple']

let ownerId: string
let ownerEmail: string
let projects: Record<'store' | 'other' | 'guarded', { id: string; schema: string; key: string }>
let foundBefore: Array<{ name: string; schema: string }> = []
let db: Client
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function call(key: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await mcpTool(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function consoleInstall(projectId: string, name: string) {
  const res = await installRoute(
    new NextRequest(`https://backenly.test/api/projects/${projectId}/database/extensions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    { params: Promise.resolve({ id: projectId }) },
  )
  return { status: res.status, body: await res.json() as any }
}

async function installedIn(name: string): Promise<string | null> {
  const rows = await db.query(
    `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1`, [name],
  )
  return rows.rows[0]?.nspname ?? null
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = await db.query(`SELECT to_regclass($1) AS t`, [`"${schema}"."${table}"`])
  return rows.rows[0].t !== null
}

async function project(name: string, protectedProduction: boolean) {
  const made = await createProvisionedProject({ name, userId: ownerId })
  await prisma.project.update({ where: { id: made.id }, data: { protectedProduction } })
  forgetProtection(made.id)
  const key = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: key.slice(0, 12), keyHash: hashApiKey(key),
      userId: ownerId, projectId: made.id, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  return { id: made.id, schema: made.postgresSchema, key }
}

/**
 * A read as PostgREST runs one for the project: as the role the gateway's
 * token names, with the request's claims, and with the workspace schema and
 * PostgREST's extra search path, public, as the search_path.
 */
async function asProjectRole<T>(role: string, schema: string, read: (c: Client) => Promise<T>): Promise<T> {
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL ROLE ${role}`)
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })])
    await db.query(`SELECT set_config('search_path', $1, true)`, [`"${schema}", "public"`])
    return await read(db)
  } finally {
    await db.query('ROLLBACK')
  }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph that skips DDL.
  process.env.ENGINE_MODE = 'runtime'

  db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`)
  }
  for (const name of MANAGED) {
    const schema = await installedIn(name)
    if (schema) {
      foundBefore.push({ name, schema })
      await db.query(`DROP EXTENSION "${name}" CASCADE`)
    }
  }

  ownerEmail = `extensions-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'owner' } })).id
  cookieToken = (await createSession(ownerId, ownerEmail)).token
  projects = {
    store: await project('extensions-store', false),
    other: await project('extensions-other', false),
    guarded: await project('extensions-guarded', true),
  }

  const table = await call(projects.store.key, 'apply_migration', { sql: 'CREATE TABLE products (name text NOT NULL, sku text)' })
  if (table.status !== 200) throw new Error(`setup: ${JSON.stringify(table.body)}`)
  const s = projects.store.schema
  await db.query(
    `INSERT INTO "${s}".products (name, sku)
     SELECT n, 'sku-' || g FROM unnest(ARRAY['Running sneakers', 'Canvas sneakers', 'Leather boots', 'Wool socks']) n,
            generate_series(1, 50) g`,
  )
  // The data plane's grants (scripts/sql/postgrest-ddl-sync.sql), which the
  // test database has no event trigger to make.
  await db.query(`GRANT USAGE ON SCHEMA "${s}" TO anon, authenticated, service_role`)
  await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${s}" TO anon, authenticated, service_role`)
}, 240_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({
    where: { projectId: { in: Object.values(projects ?? {}).map((p) => p.id) } }, select: { schemaName: true },
  }).catch(() => [])
  for (const b of branches) await db.query(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  for (const p of Object.values(projects ?? {})) await db.query(`DROP SCHEMA IF EXISTS "${p.schema}" CASCADE`).catch(() => {})
  // Back as the suite found them: what it installed goes, what was there returns.
  for (const name of MANAGED) await db.query(`DROP EXTENSION IF EXISTS "${name}" CASCADE`).catch(() => {})
  for (const { name, schema } of foundBefore) await db.query(`CREATE EXTENSION IF NOT EXISTS "${name}" WITH SCHEMA "${schema}"`).catch(() => {})
  if (ownerId) {
    await prisma.auditLog.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await db?.end().catch(() => {})
  await resetExtensionPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 240_000)

describe('an agent installs an allowlisted extension in its migration', () => {
  it('installs pg_trgm with the index that uses it, into public whatever SCHEMA said, and says it is the database\'s', async () => {
    const sql =
      'create extension if not exists pg_trgm with schema extensions;\n' +
      'create index products_name_trgm on products using gin (name gin_trgm_ops);'
    const r = await call(projects.store.key, 'apply_migration', { sql })
    expect(r.status).toBe(200)

    const [install, index] = r.body.data.applied
    expect(install).toMatchObject({ tool: 'install_extension', statement: 'create extension if not exists pg_trgm with schema extensions' })
    expect(install.summary).toMatch(/^Installed pg_trgm [\d.]+ in schema public\./)
    expect(install.summary).toContain('Extensions are database-wide: every project on this database can use pg_trgm, and Backenly never removes an extension.')
    expect(install.summary).toContain('SCHEMA extensions was not used')
    expect(index.tool).toBe('create_index')

    expect(await installedIn('pg_trgm')).toBe('public')
    const def = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'products_name_trgm'`, [projects.store.schema],
    )
    expect(def.rows[0]?.indexdef).toMatch(/USING gin \(name gin_trgm_ops\)/)

    // One governed change in History, verified, listing the install among its
    // steps and its statement among those that ran.
    expect(r.body.data.change).toMatchObject({ status: 'healthy', verified: true })
    const change = await prisma.backendChange.findUnique({ where: { id: r.body.data.change.id }, select: { steps: true, statements: true } })
    expect(change?.steps).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'install_extension', ok: true })]))
    expect(JSON.stringify(change?.statements)).toContain('CREATE EXTENSION IF NOT EXISTS \\"pg_trgm\\" WITH SCHEMA public')
  }, 180_000)

  it('is usable by the project\'s own roles, as PostgREST runs a v1 or v2 read', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const found = await asProjectRole(role, projects.store.schema, async (c) => {
        await c.query('SET LOCAL enable_seqscan = off')
        const plan = await c.query(`EXPLAIN (FORMAT JSON) SELECT name FROM products WHERE name ILIKE '%sneak%'`)
        const ilike = await c.query(`SELECT DISTINCT name FROM products WHERE name ILIKE '%sneak%' ORDER BY name`)
        const similar = await c.query(
          `SELECT DISTINCT name, round(similarity(name, 'sneekers')::numeric, 2) AS score
             FROM products WHERE name % 'sneekers' ORDER BY name`,
        )
        return { plan: JSON.stringify(plan.rows), ilike: ilike.rows.map((x) => x.name), similar: similar.rows.map((x) => x.name) }
      })
      // The trigram index answers ILIKE, and the extension's operator and
      // function resolve without a qualifier.
      expect(found.plan).toContain('products_name_trgm')
      expect(found.ilike).toEqual(['Canvas sneakers', 'Running sneakers'])
      expect(found.similar).toEqual(['Canvas sneakers', 'Running sneakers'])
    }
  }, 120_000)

  it('is installed for a second project on the database, which installing it again leaves unchanged', async () => {
    const state = await call(projects.other.key, 'read_backend_state', { section: 'schema' })
    expect(state.status).toBe(200)
    expect(state.body.data.extensions.installed).toEqual(
      expect.arrayContaining([{ name: 'pg_trgm', version: expect.any(String), schema: 'public' }]),
    )
    expect(state.body.data.extensions.installable).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'citext' })]))
    expect(state.body.summary).toMatch(/Extensions\*\* \(database-wide\): installed [^;]*pg_trgm/)

    const again = await call(projects.other.key, 'apply_migration', { sql: 'CREATE EXTENSION pg_trgm' })
    expect(again.status).toBe(200)
    expect(again.body.data.applied[0].summary).toMatch(/^pg_trgm [\d.]+ was already installed in schema public, so nothing changed\./)
    expect(await prisma.auditLog.count({ where: { projectId: projects.other.id, action: 'EXTENSION_INSTALLED' } })).toBe(0)
  }, 120_000)

  it('is recorded where the console\'s install is, from either door', async () => {
    const byAgent = await prisma.auditLog.findMany({ where: { projectId: projects.store.id, action: 'EXTENSION_INSTALLED' } })
    expect(byAgent).toHaveLength(1)
    expect(JSON.parse(byAgent[0].details ?? '{}')).toMatchObject({ extension: 'pg_trgm', schema: 'public', via: 'agent' })

    const byConsole = await consoleInstall(projects.store.id, 'citext')
    expect(byConsole.status).toBe(200)
    expect(byConsole.body).toMatchObject({ installed: true, alreadyInstalled: false, schema: 'public' })
    expect(byConsole.body.message).toContain('Extensions are database-wide')
    const rows = await prisma.auditLog.findMany({
      where: { projectId: projects.store.id, action: 'EXTENSION_INSTALLED' }, orderBy: { timestamp: 'asc' },
    })
    expect(rows.map((x) => JSON.parse(x.details ?? '{}'))).toEqual([
      expect.objectContaining({ extension: 'pg_trgm', via: 'agent' }),
      expect.objectContaining({ extension: 'citext', via: 'console', schema: 'public' }),
    ])

    // Where the console put it, the project's roles resolve its type and its
    // case-insensitive equality too.
    const equal = await asProjectRole('anon', projects.store.schema, async (c) =>
      (await c.query(`SELECT 'Ada@Example.com'::citext = 'ada@example.com' AS same`)).rows[0].same)
    expect(equal).toBe(true)
  }, 120_000)

  it('keeps the extension when the rest of its migration is recovered, and says so', async () => {
    // The seeded skus repeat, so the unique index fails after the install and
    // a new table ran: Backenly restores the table, and the extension stays.
    const r = await call(projects.store.key, 'apply_migration', {
      sql: 'create extension if not exists unaccent; create table brands (label text); create unique index products_sku_key on products (sku)',
    })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'MIGRATION_FAILED', recovered: true })
    expect(r.body.applied.map((a: any) => a.tool)).toEqual(['install_extension'])
    expect(r.body.rolledBack.map((a: any) => a.tool)).toEqual(['create_table'])
    expect(r.body.hint).toMatch(/^Nothing but its extensions was applied\. The 1 statement\(s\) that ran before the failure were restored/)
    expect(r.body.hint).toContain('The extensions it installed stay installed: an extension is database-wide, and Backenly never removes one.')
    expect(await installedIn('unaccent')).toBe('public')
    expect(await tableExists(projects.store.schema, 'brands')).toBe(false)
  }, 180_000)
})

describe('what stays refused', () => {
  it('refuses an extension off the allowlist with the console\'s reason, applying nothing', async () => {
    const viaConsole = await consoleInstall(projects.store.id, 'plpython3u')
    expect(viaConsole.status).toBe(400)

    const r = await call(projects.store.key, 'apply_migration', {
      sql: 'CREATE TABLE before_it (x text); CREATE EXTENSION plpython3u',
    })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'NOT_ALLOWED', error: viaConsole.body.error, applied: [] })
    expect(await tableExists(projects.store.schema, 'before_it')).toBe(false)
  }, 60_000)

  it('refuses one only a superuser can install, before anything runs, with the console\'s reason', async () => {
    const entry = (await listExtensions(projects.store.id)).find((e) => e.name === 'pgstattuple')!
    expect(entry).toMatchObject({ available: true, installed: false, trusted: false, installable: false })

    const r = await call(projects.store.key, 'apply_migration', {
      sql: 'CREATE TABLE before_it (x text); CREATE EXTENSION pgstattuple',
    })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'NEEDS_SUPERUSER', error: `${entry.blockedReason} Nothing was applied.`, applied: [] })
    expect(await tableExists(projects.store.schema, 'before_it')).toBe(false)
    expect(await installedIn('pgstattuple')).toBeNull()
  }, 60_000)

  it('refuses DROP EXTENSION and ALTER EXTENSION, and pg_trgm stays', async () => {
    const drop = await call(projects.store.key, 'apply_migration', { sql: 'drop extension if exists pg_trgm cascade' })
    expect(drop.status).toBe(400)
    expect(drop.body.code).toBe('DROP_EXTENSION_REFUSED')
    expect(drop.body.error).toMatch(/never removes an extension/)

    const alter = await call(projects.store.key, 'apply_migration', { sql: 'ALTER EXTENSION pg_trgm UPDATE' })
    expect(alter.status).toBe(400)
    expect(alter.body.code).toBe('ALTER_EXTENSION_REFUSED')

    expect(await installedIn('pg_trgm')).toBe('public')
  }, 60_000)
})

describe('on a protected production', () => {
  it('still refuses a migration on main, and names the branch to use', async () => {
    const r = await call(projects.guarded.key, 'apply_migration', { sql: 'CREATE EXTENSION fuzzystrmatch' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('BRANCH_REQUIRED')
    expect(await installedIn('fuzzystrmatch')).toBeNull()
  }, 60_000)

  it('installs one from a branch migration without waiting for a person, says production has it, and the merge replays it', async () => {
    const made = await createBranch(projects.guarded.id, ownerId, 'add-fuzzy-search')
    if (!made.ok) throw new Error((made as any).error)
    const branchId = (made as any).branch.id

    const onBranch = await call(projects.guarded.key, 'apply_migration', { branchId, sql: 'CREATE EXTENSION IF NOT EXISTS fuzzystrmatch' })
    expect(onBranch.status).toBe(200)
    expect(onBranch.body.data.applied[0].summary).toMatch(/^Installed fuzzystrmatch [\d.]+ in schema public\./)
    expect(onBranch.body.data.applied[0].summary).toContain('A branch cannot hold an extension of its own, so production can use it now too.')
    expect(await installedIn('fuzzystrmatch')).toBe('public')
    expect(await prisma.agentApprovalRequest.count({ where: { projectId: projects.guarded.id } })).toBe(0)

    // The merge a person approves replays the logged statement, which finds it installed.
    const merge = await call(projects.guarded.key, 'branch', { action: 'merge', branchId })
    expect(merge.body.status).toBe('awaiting_approval')
    const approval = await prisma.agentApprovalRequest.findUnique({ where: { id: merge.body.approval.id } })
    expect(approval?.toolArgs).toEqual({ branchId, approvedMigrations: ['CREATE EXTENSION IF NOT EXISTS fuzzystrmatch'] })
    const decided = await decideApproval({ projectId: projects.guarded.id, approvalId: merge.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided.status).toBe('executed')
    expect(await installedIn('fuzzystrmatch')).toBe('public')
  }, 240_000)
})
