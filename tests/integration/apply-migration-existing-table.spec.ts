/**
 * apply_migration checks each statement against the tables that exist.
 *
 * create_table answered "Created table …" for a table that was already there
 * and changed nothing, so `CREATE TABLE organizations (tagline text)` after
 * enable_teams had made `organizations` came back ok with the column reported
 * and never added. Found by the golden SaaS workflow
 * (tests/integration/mcp-golden-workflows.spec.ts).
 *
 * Through the real /api/mcp/tool route with a real key, against Postgres.
 */

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { POST } from '@/app/api/mcp/tool/route'

let ownerId: string
let projectId: string
let schema: string
const KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function migrate(sql: string) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ tool: 'apply_migration', args: { sql } }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function tables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name`
  return rows.map((r) => r.table_name)
}

async function columns(table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`
  return rows.map((r) => r.column_name)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js sets integration mode, which skips real DDL on some paths.
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `migrate-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'migrate' },
  })).id
  const project = await createProvisionedProject({ name: 'apply-migration-existing', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: KEY.slice(0, 12), keyHash: hashApiKey(KEY), userId: ownerId, projectId,
      scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
  const first = await migrate('CREATE TABLE posts (title text NOT NULL)')
  expect(first.body.ok).toBe(true)
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

it('refuses CREATE TABLE for a table that exists, names ALTER TABLE, and changes nothing', async () => {
  const r = await migrate('CREATE TABLE posts (subtitle text)')
  expect(r.status).toBe(400)
  expect(r.body).toMatchObject({ ok: false, code: 'TABLE_EXISTS', applied: [] })
  expect(r.body.hint).toMatch(/ALTER TABLE posts ADD COLUMN/)
  expect(await columns('posts')).not.toContain('subtitle')
}, 60_000)

it('refuses before anything runs, when the existing table is not the first statement', async () => {
  const r = await migrate('CREATE TABLE comments (body text);\nCREATE TABLE posts (subtitle text)')
  expect(r.body).toMatchObject({ ok: false, code: 'TABLE_EXISTS', applied: [] })
  expect(await tables()).not.toContain('comments')
}, 60_000)

it('leaves an existing table as it is for CREATE TABLE IF NOT EXISTS, says so, and runs the rest', async () => {
  const r = await migrate('CREATE TABLE IF NOT EXISTS posts (subtitle text, CHECK (length(subtitle) < 10));\nCREATE TABLE tags (label text)')
  expect(r.body.ok).toBe(true)
  expect(JSON.stringify(r.body)).toMatch(/posts already existed; CREATE TABLE IF NOT EXISTS left it unchanged/)
  expect(r.body.data.applied.map((a: any) => a.statement)).toEqual(['CREATE TABLE tags (label text)'])
  expect(await columns('posts')).not.toContain('subtitle')
  expect(await tables()).toContain('tags')
}, 60_000)

it('refuses ALTER TABLE on a table that does not exist, instead of creating it', async () => {
  // add_column used to create the table it was pointed at, so a typo made a
  // new table. Found by the acceptance suite: tests/integration/mcp-acceptance-cases.spec.ts.
  const r = await migrate('CREATE TABLE drafts (body text);\nALTER TABLE no_such_table ADD COLUMN y text')
  expect(r.status).toBe(400)
  expect(r.body).toMatchObject({ ok: false, code: 'TABLE_NOT_FOUND', applied: [] })
  expect(r.body.hint).toMatch(/read_backend_state/)
  const t = await tables()
  expect(t).not.toContain('no_such_table')
  expect(t).not.toContain('drafts')
}, 60_000)

it('lets a migration alter a table it creates earlier in the same migration', async () => {
  const r = await migrate('CREATE TABLE reviews (stars integer);\nALTER TABLE reviews ADD COLUMN body text;\nCREATE INDEX reviews_stars_idx ON reviews (stars)')
  expect(r.body.ok).toBe(true)
  expect(await columns('reviews')).toEqual(expect.arrayContaining(['stars', 'body']))
}, 60_000)

describe('ADD COLUMN applies what it declares', () => {
  // addColumnToTable took only a name and a type and stripped NOT NULL, so
  // `ADD COLUMN c text NOT NULL DEFAULT 'x'` came back "✅ Added" as a
  // nullable column with no default. Found by the acceptance suite.
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".posts (title) VALUES ('existing row')`)
  })

  async function column(table: string, name: string) {
    const rows = await prisma.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${name}`
    return rows[0] ?? null
  }

  it('fills a NOT NULL DEFAULT column into the rows already there', async () => {
    const r = await migrate("ALTER TABLE posts ADD COLUMN status text NOT NULL DEFAULT 'draft'")
    expect(r.body.ok).toBe(true)
    expect(await column('posts', 'status')).toMatchObject({ is_nullable: 'NO', column_default: expect.stringMatching(/draft/) })
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status FROM "${schema}".posts`)
    expect(rows.map((x) => x.status)).toEqual(['draft'])
  }, 60_000)

  it('refuses a NOT NULL column with no default on a table with rows, and adds nothing', async () => {
    const r = await migrate('ALTER TABLE posts ADD COLUMN must_have text NOT NULL')
    expect(r.body).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' })
    expect(JSON.stringify(r.body)).toMatch(/already has rows that would have no value/)
    expect(await column('posts', 'must_have')).toBeNull()
  }, 60_000)

  it('adds a UNIQUE column with its constraint', async () => {
    const r = await migrate('ALTER TABLE posts ADD COLUMN slug text UNIQUE')
    expect(r.body.ok).toBe(true)
    const u = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage cu ON cu.constraint_name = tc.constraint_name AND cu.table_schema = tc.table_schema
      WHERE tc.table_schema = ${schema} AND tc.table_name = 'posts' AND tc.constraint_type = 'UNIQUE' AND cu.column_name = 'slug'`
    expect(u[0].n).toBe(1)
  }, 60_000)

  it('refuses a default it would have to run as arbitrary SQL', async () => {
    const r = await migrate("ALTER TABLE posts ADD COLUMN risky text DEFAULT md5('x')")
    expect(r.body.ok).toBe(false)
    expect(await column('posts', 'risky')).toBeNull()
  }, 60_000)

  it('still adds a plain column the way it always did', async () => {
    const r = await migrate('ALTER TABLE posts ADD COLUMN subtitle_plain text')
    expect(r.body.ok).toBe(true)
    expect(await column('posts', 'subtitle_plain')).toMatchObject({ is_nullable: 'YES' })
  }, 60_000)
})

it('still creates a table that does not exist', async () => {
  const r = await migrate('CREATE TABLE IF NOT EXISTS authors (name text)')
  expect(r.body.ok).toBe(true)
  expect(await columns('authors')).toContain('name')
}, 60_000)
