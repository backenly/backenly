/**
 * apply_migration and a table that already exists.
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

it('still creates a table that does not exist', async () => {
  const r = await migrate('CREATE TABLE IF NOT EXISTS authors (name text)')
  expect(r.body.ok).toBe(true)
  expect(await columns('authors')).toContain('name')
}, 60_000)
