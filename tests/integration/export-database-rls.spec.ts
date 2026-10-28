/**
 * THE DATABASE EXPORT IS A COMPLETE DUMP OR A CLEAR REFUSAL — NEVER A 200 LIE
 * ===========================================================================
 * Connect → Direct "Export your backend" ran pg_dump as DATABASE_URL — the
 * NOBYPASSRLS app role — against FORCE-RLS workspace tables: the exact failure
 * the platform's own nightly-backup code documents ("every nightly backup
 * failed … ending at zero backups on disk"). Worse, the route committed to a
 * 200 stream on pg_dump's first stdout byte, and pg_dump prints the pre-data
 * DDL before the COPY that aborts — so the browser saved a success-looking
 * .sql that silently ended mid-way with no data.
 *
 * The route now dumps with the SAME credential the backups use
 * (buildConnection: BACKUP_DATABASE_URL first) and answers only after pg_dump
 * exits: exit 0 → the whole file, anything else → a 503 that names the cause.
 * Real route handler, real pg_dump binary, real FORCE-RLS table.
 *
 * (Locally the test role is a superuser, which bypasses RLS — the production
 * role premise NOSUPERUSER NOBYPASSRLS is pinned by the credential-split
 * suites. What THIS suite pins is the mechanism: which credential is used,
 * and that no partial dump can ever leave as a 200.)
 */

let currentProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) =>
    handler({ projectId: currentProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { GET as exportGET } from '@/app/api/projects/[id]/export/database/route'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let schema = ''
const savedBackupUrl = process.env.BACKUP_DATABASE_URL

async function callExport(mode = 'full') {
  const req = new NextRequest(`http://localhost:3000/api/projects/${projectId}/export/database?mode=${mode}`)
  const res = await exportGET(req)
  const text = await res.text()
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `export-rls-${randomUUID()}@test.invalid`, name: 'Export RLS Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `export-rls-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  currentProjectId = projectId
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."orders" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item text NOT NULL, user_id text)`,
  )
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."orders" ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."orders" FORCE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(
    `CREATE POLICY own_rows ON "${schema}"."orders" USING (user_id = current_setting('app.user_id', true))`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."orders" (item, user_id) VALUES ('golden-widget', 'u1'), ('silver-widget', 'u2')`,
  )
}, 120_000)

afterAll(async () => {
  if (savedBackupUrl === undefined) delete process.env.BACKUP_DATABASE_URL
  else process.env.BACKUP_DATABASE_URL = savedBackupUrl
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('with the backup credential configured', () => {
  it('a full export is the WHOLE dump: schema, data, and the completion marker', async () => {
    process.env.BACKUP_DATABASE_URL = DB_URL!
    const res = await callExport('full')
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('application/sql')
    expect(res.text).toContain('CREATE TABLE')
    expect(res.text).toContain('golden-widget') // the COPY data actually made it
    // pg_dump prints this only when it finished; a truncated dump cannot carry it.
    expect(res.text).toContain('PostgreSQL database dump complete')
  }, 120_000)

  it('schema-only still works', async () => {
    process.env.BACKUP_DATABASE_URL = DB_URL!
    const res = await callExport('schema')
    expect(res.status).toBe(200)
    expect(res.text).toContain('CREATE TABLE')
    expect(res.text).not.toContain('golden-widget')
  }, 120_000)
})

describe('the copied pg_dump command can actually run (CON-03)', () => {
  // The bkn_ro_ role is NOBYPASSRLS, and pg_dump defaults row_security to OFF,
  // which makes PostgreSQL refuse every RLS table the role is subject to. The
  // flag turns row_security on, and the role then reads through its
  // pass-through SELECT policy.
  it('the handed-out command carries --enable-row-security', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'services', 'direct-access.ts'), 'utf8')
    const cmdLine = src.split('\n').find((l) => l.includes('pgDumpCommand:') && l.includes('pg_dump')) ?? ''
    expect(cmdLine).toContain('--enable-row-security')
  })

  it('the agent doc states the flag instead of a bare "pg_dump works"', () => {
    const doc = fs.readFileSync(path.join(process.cwd(), 'public', 'docs', 'agents', 'database.md'), 'utf8')
    expect(doc).toContain('--enable-row-security')
  })
})

describe('a failing dump is a refusal, never a 200 .sql', () => {
  it('the export runs on the backup credential, and its failure is a 503 with a reason', async () => {
    // Point the backup credential somewhere that cannot answer. The old route
    // ignored BACKUP_DATABASE_URL entirely and dumped as DATABASE_URL, so this
    // produced a healthy-looking 200 .sql.
    process.env.BACKUP_DATABASE_URL = DB_URL!.replace(/\/[^/?]+(\?|$)/, '/no_such_database_zz$1')
    const res = await callExport('full')
    expect(res.status).toBe(503)
    expect(res.contentType).toContain('application/json')
    expect(res.text).not.toContain('CREATE TABLE')
  }, 120_000)
})
