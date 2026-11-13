/**
 * POST /api/workspace/files/content reads one file of the project's workspace.
 *
 * The file is named by `filePath` in the request body. The route joined it
 * onto the project's workspace directory and read whatever that named, so a
 * path with `..` in it read files outside the workspace: another project's
 * workspace, or any file the server could read. It now resolves the path
 * inside the project's workspace and refuses it otherwise, and it reads a
 * symbolic link only when the link leads back inside.
 *
 * Real database, real signed session, the real handler. The workspace root is
 * a temporary directory; the files outside it hold marker text only.
 */

import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

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
let root = ''
let owner: { id: string; token: string }
let projectId = ''

const INSIDE = `marker-inside-${randomUUID()}`
const OTHER_PROJECT = `marker-other-project-${randomUUID()}`
const OUTSIDE = `marker-outside-${randomUUID()}`
const otherProjectDir = randomUUID()

/** jest.setup.js replaces the global Request; this is the subset the handler touches. */
function req(filePath: unknown): any {
  const headers: Record<string, string> = {
    authorization: `Bearer ${owner.token}`,
    'x-project-id': projectId,
  }
  return {
    method: 'POST',
    url: 'http://localhost:3000/api/workspace/files/content',
    nextUrl: { pathname: '/api/workspace/files/content' },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => ({ filePath }),
  }
}

async function read(filePath: unknown): Promise<{ status: number; body: any; text: string }> {
  const { POST } = await import('@/app/api/workspace/files/content/route')
  const res: any = await POST(req(filePath) as any)
  const body = await res.json()
  return { status: res.status, body, text: JSON.stringify(body) }
}

beforeAll(async () => {
  assertSafeTestDatabase()

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reads-'))
  root = path.join(tmp, 'root')
  process.env.WORKSPACE_DIR = root

  const email = `wsr-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: 'Workspace Reads Test' }, select: { id: true } })
  createdUserIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  owner = { id: u.id, token }

  const p = await prisma.project.create({
    data: { name: `wsr-${randomUUID().slice(0, 8)}`, userId: owner.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id

  const own = path.join(root, projectId)
  fs.mkdirSync(path.join(own, 'src'), { recursive: true })
  fs.writeFileSync(path.join(own, 'src', 'notes.txt'), INSIDE)

  fs.mkdirSync(path.join(root, otherProjectDir), { recursive: true })
  fs.writeFileSync(path.join(root, otherProjectDir, 'notes.txt'), OTHER_PROJECT)

  fs.writeFileSync(path.join(tmp, 'outside.txt'), OUTSIDE)
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(own, 'src', 'link.txt'))
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
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('POST /api/workspace/files/content', () => {
  it('reads a file in the project workspace', async () => {
    const r = await read('src/notes.txt')

    expect(r.status).toBe(200)
    expect(r.body.content).toBe(INSIDE)
  })

  it('reads it with the workspace/ prefix the console sends', async () => {
    const r = await read('workspace/src/notes.txt')

    expect(r.status).toBe(200)
    expect(r.body.content).toBe(INSIDE)
  })

  it("refuses a path into another project's workspace", async () => {
    const r = await read(`../${otherProjectDir}/notes.txt`)

    expect(r.status).toBe(400)
    expect(r.body.code).toBe('PATH_OUTSIDE_WORKSPACE')
    expect(r.text).not.toContain(OTHER_PROJECT)
  })

  it('refuses a path that leaves every workspace', async () => {
    const r = await read('../../outside.txt')

    expect(r.status).toBe(400)
    expect(r.body.code).toBe('PATH_OUTSIDE_WORKSPACE')
    expect(r.text).not.toContain(OUTSIDE)
  })

  it('refuses a path that climbs out after going in', async () => {
    const r = await read('src/../../../outside.txt')

    expect(r.status).toBe(400)
    expect(r.text).not.toContain(OUTSIDE)
  })

  it('refuses an absolute path', async () => {
    const r = await read(path.join(tmp, 'outside.txt'))

    expect(r.status).toBe(400)
    expect(r.text).not.toContain(OUTSIDE)
  })

  it.each([[''], [null], [42], [{ path: 'src/notes.txt' }], ['src/notes.txt\0.png']])(
    'refuses a filePath that is not a usable name (%p)',
    async (filePath) => {
      const r = await read(filePath)

      expect(r.status).toBe(400)
      expect(r.body.code).toBe('PATH_OUTSIDE_WORKSPACE')
    },
  )

  it('does not follow a symbolic link that leads out of the workspace', async () => {
    const r = await read('src/link.txt')

    expect(r.text).not.toContain(OUTSIDE)
    expect(r.status).toBe(404)
  })
})
