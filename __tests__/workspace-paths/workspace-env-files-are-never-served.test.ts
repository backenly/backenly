/**
 * A workspace never holds or hands out a credential.
 *
 * POST /api/database/setup-workspace wrote a `.env` into the project's
 * workspace holding a database connection string, and the workspace routes
 * served workspace files back: POST /api/workspace/files/content read any of
 * them, GET /api/workspace/files listed them and copied them into
 * workspace_files, and GET /api/workspace/download put them in the ZIP. Now no
 * `.env` is written, and no route serves, lists, copies or archives an
 * environment file. `.env.example`, a template without values, is served as
 * before.
 *
 * lib/workspace/env-files.ts finds the copies made before this and removes the
 * ones Backenly wrote; it is the logic of scripts/remove-workspace-env-files.ts.
 *
 * Real database, real signed session, the real handlers. The workspace root is
 * a temporary directory, and the environment files hold marker text only.
 */

import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { isEnvFile } from '@/lib/workspace/paths'
import { BACKENLY_ENV_HEADER, findWorkspaceEnvFiles, removeBackenlyEnvFiles } from '@/lib/workspace/env-files'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_WORKSPACE_DIR = process.env.WORKSPACE_DIR

const createdUserIds: string[] = []
const createdProjectIds: string[] = []

let tmp = ''
let owner: { id: string; token: string }

/** What a `.env` setup-workspace wrote looks like, with a marker for its value. */
const backenlyEnv = (marker: string) => `${BACKENLY_ENV_HEADER}\nDATABASE_URL="${marker}"\n`

async function makeProject(): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `wse-${randomUUID().slice(0, 8)}`, userId: owner.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

/** A fresh workspace root holding one project directory with these files. */
function workspaceWith(projectId: string, files: Record<string, string>): string {
  const root = path.join(tmp, randomUUID())
  process.env.WORKSPACE_DIR = root
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, projectId, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return path.join(root, projectId)
}

/** jest.setup.js replaces the global Request; this is the subset the handlers touch. */
function req(method: string, pathname: string, projectId: string, body?: unknown): any {
  const headers: Record<string, string> = {
    authorization: `Bearer ${owner.token}`,
    'x-project-id': projectId,
  }
  return {
    method,
    url: `http://localhost:3000${pathname}?projectId=${projectId}`,
    nextUrl: { pathname },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body,
  }
}

async function readFile(projectId: string, filePath: string) {
  const { POST } = await import('@/app/api/workspace/files/content/route')
  const res: any = await POST(req('POST', '/api/workspace/files/content', projectId, { filePath }) as any)
  const body = await res.json()
  return { status: res.status, body, text: JSON.stringify(body) }
}

async function listFiles(projectId: string) {
  const { GET } = await import('@/app/api/workspace/files/route')
  const res: any = await GET(req('GET', '/api/workspace/files', projectId) as any)
  const body = await res.json()
  return { status: res.status, body, text: JSON.stringify(body) }
}

async function downloadZip(projectId: string): Promise<Buffer> {
  const { GET } = await import('@/app/api/workspace/download/route')
  const res: any = await GET(req('GET', '/api/workspace/download', projectId) as any)
  expect(res.status).toBe(200)
  // jest.setup.js's Response keeps the body it was given; a real one reads it out.
  return typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(res.body)
}

/** Entry names in a ZIP, read from its central directory. */
function zipEntryNames(zip: Buffer): string[] {
  let end = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a ZIP: no end of central directory')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const names: string[] = []
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('not a ZIP: bad central directory entry')
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    names.push(zip.toString('utf8', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
}

beforeAll(async () => {
  assertSafeTestDatabase()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-env-'))
  const email = `wse-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Workspace Env Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  owner = { id: u.id, token }
})

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
})

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
})

afterAll(async () => {
  if (ORIGINAL_WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = ORIGINAL_WORKSPACE_DIR
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  if (createdUserIds.length) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {})
  }
  if (createdProjectIds.length) {
    await prisma.workspaceFile.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.workspace.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    for (const id of createdProjectIds) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
    }
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('isEnvFile', () => {
  it.each(['.env', '.env.local', '.env.production', '.env.development.local', 'app/.env', 'workspace/config/.env.test', '.ENV'])(
    '%s is an environment file',
    (name) => expect(isEnvFile(name)).toBe(true),
  )

  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', 'env.example', '.environment', 'src/env.ts', 'notes.txt'])(
    '%s is not',
    (name) => expect(isEnvFile(name)).toBe(false),
  )
})

describe('POST /api/database/setup-workspace', () => {
  it('writes the schema and no .env', async () => {
    const projectId = await makeProject()
    const dir = workspaceWith(projectId, {})
    const { POST } = await import('@/app/api/database/setup-workspace/route')

    const res: any = await POST(req('POST', '/api/database/setup-workspace', projectId) as any)

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false)
  })
})

describe('POST /api/workspace/files/content', () => {
  it.each(['.env', 'workspace/.env', 'config/.env.local'])('refuses %s', async (filePath) => {
    const marker = `marker-${randomUUID()}`
    const projectId = await makeProject()
    workspaceWith(projectId, { '.env': backenlyEnv(marker), 'config/.env.local': backenlyEnv(marker) })

    const r = await readFile(projectId, filePath)

    expect(r.status).toBe(403)
    expect(r.body.code).toBe('ENV_FILE_NOT_SERVED')
    expect(r.text).not.toContain(marker)
  })

  it('refuses the database copy of a .env too', async () => {
    const marker = `marker-${randomUUID()}`
    const projectId = await makeProject()
    workspaceWith(projectId, {})
    await prisma.workspaceFile.create({ data: { projectId, path: '.env', content: backenlyEnv(marker) } })

    const r = await readFile(projectId, '.env')

    expect(r.status).toBe(403)
    expect(r.text).not.toContain(marker)
  })

  it('serves .env.example', async () => {
    const projectId = await makeProject()
    workspaceWith(projectId, { '.env.example': 'DATABASE_URL=\n' })

    const r = await readFile(projectId, '.env.example')

    expect(r.status).toBe(200)
    expect(r.body.content).toBe('DATABASE_URL=\n')
  })
})

describe('GET /api/workspace/files', () => {
  it('neither lists nor copies a .env, from disk or from an earlier copy', async () => {
    const onDisk = `marker-disk-${randomUUID()}`
    const copied = `marker-copied-${randomUUID()}`
    const projectId = await makeProject()
    workspaceWith(projectId, { '.env': backenlyEnv(onDisk), '.env.example': 'DATABASE_URL=\n', 'src/app.ts': 'export {}\n' })
    await prisma.workspaceFile.create({ data: { projectId, path: 'workspace/config/.env', content: backenlyEnv(copied) } })

    const r = await listFiles(projectId)

    expect(r.status).toBe(200)
    expect(r.text).not.toContain(onDisk)
    expect(r.text).not.toContain(copied)
    expect(r.text).toContain('workspace/.env.example')
    expect(r.text).toContain('workspace/src/app.ts')
    const rows = await prisma.workspaceFile.findMany({ where: { projectId }, select: { path: true } })
    expect(rows.map((row) => row.path)).not.toContain('workspace/.env')
  })
})

describe('GET /api/workspace/download', () => {
  it('leaves environment files out of the archive and keeps the rest', async () => {
    const projectId = await makeProject()
    workspaceWith(projectId, {
      '.env': backenlyEnv(`marker-${randomUUID()}`),
      'api/.env.production': 'SECRET=marker\n',
      '.env.example': 'DATABASE_URL=\n',
      'src/app.ts': 'export {}\n',
    })

    const names = zipEntryNames(await downloadZip(projectId))

    expect(names.sort()).toEqual(['.env.example', 'src/app.ts'])
  })
})

describe('removing the copies made before', () => {
  it('lists every environment file, and removes only the ones Backenly wrote', async () => {
    const projectId = await makeProject()
    const dir = workspaceWith(projectId, {
      '.env': backenlyEnv(`marker-${randomUUID()}`),
      'api/.env.local': 'MINE=1\n',
      '.env.example': 'DATABASE_URL=\n',
    })
    await prisma.workspaceFile.create({ data: { projectId, path: 'workspace/.env', content: backenlyEnv('marker') } })
    await prisma.workspaceFile.create({ data: { projectId, path: 'workspace/api/.env.local', content: 'MINE=1\n' } })

    const found = (await findWorkspaceEnvFiles()).filter((f) => f.projectId === projectId)
    const summary = found.map((f) => `${f.where} ${f.file} ${f.writtenByBackenly ? 'backenly' : 'other'}`).sort()

    expect(summary).toEqual([
      `database workspace/.env backenly`,
      `database workspace/api/.env.local other`,
      `disk .env backenly`,
      `disk ${path.join('api', '.env.local')} other`,
    ])
    expect(JSON.stringify(found)).not.toContain('MINE=1')

    const removed = await removeBackenlyEnvFiles(found)

    expect(removed).toEqual({ files: 1, rows: 1 })
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'api', '.env.local'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.env.example'))).toBe(true)
    const rows = await prisma.workspaceFile.findMany({ where: { projectId }, select: { path: true } })
    expect(rows.map((row) => row.path)).toEqual(['workspace/api/.env.local'])
  })

  it('leaves a file that no longer starts with the header when it is removed', async () => {
    const projectId = await makeProject()
    const dir = workspaceWith(projectId, { '.env': backenlyEnv('marker') })
    const found = (await findWorkspaceEnvFiles()).filter((f) => f.projectId === projectId)
    fs.writeFileSync(path.join(dir, '.env'), 'EDITED_SINCE=1\n')

    const removed = await removeBackenlyEnvFiles(found)

    expect(removed.files).toBe(0)
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(true)
  })
})
