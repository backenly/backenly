/**
 * CHANGING A PROJECT FROM THE CONSOLE NEEDS THE DEVELOPER ROLE
 * ============================================================
 * Every member of a project can see it. Changing it needs the Developer role,
 * and taking down what an Admin published needs the Admin role. The three
 * wrappers that hand a console route its project apply the floor by method
 * (lib/auth/project-floor.ts), and a handler that checks the project by hand
 * asks canWriteProject or canAdministerProject.
 *
 *   withProjectAccess, default     DELETE /api/database/delete-table
 *                                  VIEWER 403 and the table is still there;
 *                                  a DEVELOPER drops it
 *   withTenantIsolation, default   DELETE /api/storage/files/[fileId]
 *                                  VIEWER 403 and the file is not deleted;
 *                                  a DEVELOPER deletes it
 *   by hand, write                 POST /api/workspace/files
 *                                  VIEWER 403 and nothing is saved; a
 *                                  DEVELOPER saves
 *   option, administer             DELETE /api/projects/[id]/share-report
 *                                  DEVELOPER 403 and the link stays live; an
 *                                  ADMIN revokes it
 *   by hand, administer            DELETE /api/preview-shares
 *                                  someone outside the project 404, DEVELOPER
 *                                  403, the share stays; an ADMIN revokes it
 *   option, view                   POST /api/database/query
 *                                  a VIEWER still runs a read-only query
 *   single-tenant                  every account is the deployment's operator:
 *                                  the same changes go through for an account
 *                                  that belongs to no organization
 *
 * Every refusal is 403 PROJECT_ROLE_INSUFFICIENT and leaves the project as it
 * was. Real database, real signed sessions, the real handlers, wrappers, guard
 * and resolver, and real DDL through the executor.
 */

import { randomUUID } from 'crypto'

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})

// No PostgREST runs beside the tests; registering a schema with it is not what
// these cases are about.
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

// withProjectAccess and withAuth read the session through next/headers, which
// only a real Next request carries. The session behind the token is a real row.
let mockSessionToken = ''
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'auth-token' && mockSessionToken ? { value: mockSessionToken } : undefined),
  }),
  headers: async () => new Map<string, string>(),
}))

/**
 * Where an organization member's role comes from. The public tree resolves
 * `@cloud/project-access` to a stub that knows no organizations; this mirrors
 * lib/cloud/project-access.ts against the real membership rows, and the real
 * module is used when the Cloud overlay is composed.
 */
jest.mock('@cloud/project-access', () => {
  try {
    return jest.requireActual('@/lib/cloud/project-access')
  } catch {
    return {
      async organizationRoleForProject(projectId: string, organizationId: string | null, userId: string) {
        if (!organizationId) return null
        const { prisma: db } = jest.requireActual('@/lib/db')
        const member = await db.organizationMember.findUnique({
          where: { orgId_userId: { orgId: organizationId, userId } },
          select: { role: true, restricted: true },
        })
        if (!member) return null
        if (member.restricted && member.role !== 'OWNER' && member.role !== 'ADMIN') {
          const grant = await db.projectMember.findUnique({
            where: { userId_projectId: { userId, projectId } },
            select: { id: true },
          })
          if (!grant) return null
        }
        return member.role
      },
      async organizationProjectClauses(userId: string) {
        return [
          { organization: { members: { some: { userId, restricted: false } } } },
          { projectMembers: { some: { userId } } },
        ]
      },
    }
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { createProvisionedProject } from '@/lib/projects/provision'
import { createWorkspaceTable } from '@/lib/services/tableLifecycle'
import { forgetProtection } from '@/lib/branches/protection'
import { closeChangeLockPool } from '@/lib/changes/lock'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_ENGINE_MODE = process.env.ENGINE_MODE
const ORIGINAL_PROJECT_ID = process.env.BACKENLY_PROJECT_ID
const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const ROLE_INSUFFICIENT = 'PROJECT_ROLE_INSUFFICIENT'

type Role = 'VIEWER' | 'DEVELOPER' | 'ADMIN'
type TestUser = { id: string; token: string }

const userIds: string[] = []
let orgId = ''
let owner!: TestUser
let stranger!: TestUser
let operator!: TestUser
const members = {} as Record<Role, TestUser>

/** The organization's project, and a second one standing in for a self-hosted install. */
let projectId = ''
let schema = ''
let soloProjectId = ''
let soloSchema = ''

async function makeUser(tag: string): Promise<TestUser> {
  const email = `floor-${tag}-${randomUUID()}@test.invalid`
  const u = await prisma.user.create({ data: { email, name: `Floor ${tag}` }, select: { id: true } })
  userIds.push(u.id)
  const { token } = await createSession(u.id, email, 'user')
  return { id: u.id, token }
}

/** The subset of a Next request these handlers read. jest.setup.js replaces the global Request. */
function req(user: TestUser, method: string, path: string, opts: { body?: unknown; project?: string } = {}): any {
  mockSessionToken = user.token
  const url = `http://localhost:3000${path}`
  const headers: Record<string, string> = {
    authorization: `Bearer ${user.token}`,
    'content-type': 'application/json',
    ...(opts.project ? { 'x-project-id': opts.project } : {}),
  }
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? {},
    clone() {
      return this
    },
  }
}

async function tableExists(inSchema: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    `"${inSchema}"."${table}"`,
  )
  return rows[0]?.present === true
}

/** Backenly's own build cooldown spaces governed changes apart; these cases make several in a row. */
async function clearBuildLocks(): Promise<void> {
  await prisma.backgroundJob.deleteMany({
    where: { projectId: { in: [projectId, soloProjectId].filter(Boolean) }, type: 'build_lock' },
  })
}

async function newTable(forProject: string, tableName: string): Promise<void> {
  await clearBuildLocks()
  const created = await createWorkspaceTable(forProject, {
    tableName,
    columns: [{ name: 'title', type: 'text' }],
    skipApi: true,
  })
  if (!created.success) throw new Error(`Could not create ${tableName}: ${created.message}`)
}

async function dropTable(user: TestUser, forProject: string, tableName: string) {
  await clearBuildLocks()
  const { DELETE } = await import('@/app/api/database/delete-table/route')
  return DELETE(req(user, 'DELETE', '/api/database/delete-table', { project: forProject, body: { tableName } }))
}

async function newFile(forProject: string): Promise<string> {
  const tag = randomUUID().slice(0, 8)
  const bucket = await prisma.storageBucket.create({ data: { name: `floor-${tag}`, projectId: forProject } })
  const file = await prisma.storageFile.create({
    data: { bucketId: bucket.id, name: 'note.txt', path: `floor/${tag}/note.txt`, size: 0, projectId: forProject },
  })
  return file.id
}

async function deleteFile(user: TestUser, forProject: string, fileId: string) {
  const { DELETE } = await import('@/app/api/storage/files/[fileId]/route')
  return DELETE(req(user, 'DELETE', `/api/storage/files/${fileId}`, { project: forProject }), {
    params: Promise.resolve({ fileId }),
  })
}

const fileDeletedAt = async (fileId: string) =>
  (await prisma.storageFile.findUnique({ where: { id: fileId }, select: { deletedAt: true } }))?.deletedAt ?? null

async function saveWorkspaceFile(user: TestUser, forProject: string, path: string) {
  const { POST } = await import('@/app/api/workspace/files/route')
  return POST(
    req(user, 'POST', '/api/workspace/files', {
      project: forProject,
      body: { files: [{ path, content: 'export const answer = 42', description: 'floor test' }] },
    }),
  )
}

const workspaceFile = (forProject: string, path: string) =>
  prisma.workspaceFile.findUnique({ where: { projectId_path: { projectId: forProject, path } }, select: { id: true } })

async function newReportLink(): Promise<string> {
  const token = await prisma.shareToken.create({
    data: { projectId, tokenHash: `floor-${randomUUID()}`, createdBy: owner.id },
    select: { id: true },
  })
  return token.id
}

async function revokeReportLink(user: TestUser, tokenId: string) {
  const { DELETE } = await import('@/app/api/projects/[id]/share-report/route')
  return DELETE(req(user, 'DELETE', `/api/projects/${projectId}/share-report?tokenId=${tokenId}`))
}

async function newPreviewShare(): Promise<string> {
  const share = await prisma.previewShare.create({
    data: {
      projectId,
      userId: owner.id,
      token: `floor-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  })
  return share.id
}

async function revokePreviewShare(user: TestUser, shareId: string) {
  const { DELETE } = await import('@/app/api/preview-shares/route')
  return DELETE(req(user, 'DELETE', `/api/preview-shares?id=${shareId}`))
}

const previewShareRevoked = async (shareId: string) =>
  (await prisma.previewShare.findUnique({ where: { id: shareId }, select: { revoked: true } }))?.revoked

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  delete process.env.BACKENLY_PROJECT_ID
  resetSingleTenantCache()
  assertSafeTestDatabase()

  owner = await makeUser('owner')
  stranger = await makeUser('stranger')
  operator = await makeUser('operator')
  for (const role of ['VIEWER', 'DEVELOPER', 'ADMIN'] as Role[]) members[role] = await makeUser(role.toLowerCase())

  orgId = (await prisma.organization.create({
    data: { name: `floor-${randomUUID().slice(0, 8)}`, ownerId: owner.id },
    select: { id: true },
  })).id
  await prisma.organizationMember.create({ data: { orgId, userId: owner.id, role: 'OWNER' } })
  for (const role of ['VIEWER', 'DEVELOPER', 'ADMIN'] as Role[]) {
    await prisma.organizationMember.create({ data: { orgId, userId: members[role].id, role } })
  }

  const project = await createProvisionedProject({ name: 'console-role-floors', userId: owner.id, organizationId: orgId })
  projectId = project.id
  schema = project.postgresSchema

  // A self-hosted install's one project, as bootstrap leaves it: nobody owns it
  // yet and it belongs to no organization. Provisioned here as Cloud, because
  // single-tenant only ever reconciles its one project.
  const solo = await createProvisionedProject({ name: 'console-role-floors-solo', userId: owner.id })
  soloProjectId = solo.id
  soloSchema = solo.postgresSchema
  await prisma.project.update({ where: { id: soloProjectId }, data: { userId: null } })

  // A person in the dashboard changes production directly.
  for (const id of [projectId, soloProjectId]) {
    await prisma.project.update({ where: { id }, data: { protectedProduction: false } })
    forgetProtection(id)
  }

  await newTable(projectId, 'kept_from_viewer')
  await newTable(projectId, 'dropped_by_developer')
  await newTable(soloProjectId, 'dropped_by_operator')
}, 240_000)

afterAll(async () => {
  for (const id of [projectId, soloProjectId].filter(Boolean)) {
    await prisma.workspaceFile.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.storageFile.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.storageBucket.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.shareToken.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.previewShare.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.backgroundJob.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  for (const s of [schema, soloSchema].filter(Boolean)) {
    const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
      `${s}%`,
    ).catch(() => [])
    for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: [projectId, soloProjectId].filter(Boolean) } } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {})
  await closeChangeLockPool().catch(() => {})

  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_ENGINE_MODE === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = ORIGINAL_ENGINE_MODE
  if (ORIGINAL_PROJECT_ID === undefined) delete process.env.BACKENLY_PROJECT_ID
  else process.env.BACKENLY_PROJECT_ID = ORIGINAL_PROJECT_ID
  resetSingleTenantCache()
}, 240_000)

describe('withProjectAccess holds a DELETE to the Developer role', () => {
  it('refuses a VIEWER, and the table is still there', async () => {
    const res: any = await dropTable(members.VIEWER, projectId, 'kept_from_viewer')

    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(ROLE_INSUFFICIENT)
    expect(await tableExists(schema, 'kept_from_viewer')).toBe(true)
  }, 120_000)

  it('lets a DEVELOPER drop a table', async () => {
    const res: any = await dropTable(members.DEVELOPER, projectId, 'dropped_by_developer')

    expect(res.status).toBe(200)
    expect(await tableExists(schema, 'dropped_by_developer')).toBe(false)
  }, 120_000)
})

describe('withTenantIsolation holds a DELETE to the Developer role', () => {
  it('refuses a VIEWER, and the file is not deleted', async () => {
    const fileId = await newFile(projectId)

    const res: any = await deleteFile(members.VIEWER, projectId, fileId)

    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(ROLE_INSUFFICIENT)
    expect(await fileDeletedAt(fileId)).toBeNull()
  }, 60_000)

  it('lets a DEVELOPER delete a file', async () => {
    const fileId = await newFile(projectId)

    const res: any = await deleteFile(members.DEVELOPER, projectId, fileId)

    expect(res.status).toBe(200)
    expect(await fileDeletedAt(fileId)).not.toBeNull()
  }, 60_000)
})

describe('a handler that checks the project by hand asks for the role its change needs', () => {
  it('refuses a VIEWER saving workspace files, and nothing is saved', async () => {
    const res: any = await saveWorkspaceFile(members.VIEWER, projectId, 'src/viewer.ts')

    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(ROLE_INSUFFICIENT)
    expect(await workspaceFile(projectId, 'src/viewer.ts')).toBeNull()
  }, 60_000)

  it('lets a DEVELOPER save workspace files', async () => {
    const res: any = await saveWorkspaceFile(members.DEVELOPER, projectId, 'src/developer.ts')

    expect(res.status).toBe(200)
    expect(await workspaceFile(projectId, 'src/developer.ts')).not.toBeNull()
  }, 60_000)
})

describe('taking down a published link needs the Admin role', () => {
  it('refuses a DEVELOPER revoking a change-report link, and the link stays live', async () => {
    const tokenId = await newReportLink()

    const res: any = await revokeReportLink(members.DEVELOPER, tokenId)

    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(ROLE_INSUFFICIENT)
    const row = await prisma.shareToken.findUnique({ where: { id: tokenId }, select: { revokedAt: true } })
    expect(row?.revokedAt).toBeNull()
  }, 60_000)

  it('lets an ADMIN revoke a change-report link', async () => {
    const tokenId = await newReportLink()

    const res: any = await revokeReportLink(members.ADMIN, tokenId)

    expect(res.status).toBe(200)
    const row = await prisma.shareToken.findUnique({ where: { id: tokenId }, select: { revokedAt: true } })
    expect(row?.revokedAt).not.toBeNull()
  }, 60_000)

  it('answers someone outside the project 404 for a preview share, and the share stays', async () => {
    const shareId = await newPreviewShare()

    const res: any = await revokePreviewShare(stranger, shareId)

    expect(res.status).toBe(404)
    expect(await previewShareRevoked(shareId)).toBe(false)
  }, 60_000)

  it('refuses a DEVELOPER revoking a preview share, and the share stays', async () => {
    const shareId = await newPreviewShare()

    const res: any = await revokePreviewShare(members.DEVELOPER, shareId)

    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(ROLE_INSUFFICIENT)
    expect(await previewShareRevoked(shareId)).toBe(false)
  }, 60_000)

  it('lets an ADMIN revoke a preview share', async () => {
    const shareId = await newPreviewShare()

    const res: any = await revokePreviewShare(members.ADMIN, shareId)

    expect(res.status).toBe(200)
    expect(await previewShareRevoked(shareId)).toBe(true)
  }, 60_000)
})

describe('a POST that changes nothing stays open to every member', () => {
  it('lets a VIEWER run a read-only query', async () => {
    const { POST } = await import('@/app/api/database/query/route')

    const res: any = await POST(
      req(members.VIEWER, 'POST', '/api/database/query', { project: projectId, body: { sql: 'SELECT 1 AS one' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.rowCount).toBe(1)
  }, 60_000)
})

describe('a self-hosted deployment: every account is its operator', () => {
  beforeAll(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_PROJECT_ID = soloProjectId
    resetSingleTenantCache()
  })

  afterAll(() => {
    process.env.BACKENLY_EDITION = 'cloud'
    delete process.env.BACKENLY_PROJECT_ID
    resetSingleTenantCache()
  })

  it('an account in no organization drops a table, deletes a file and saves workspace files', async () => {
    const dropped: any = await dropTable(operator, soloProjectId, 'dropped_by_operator')
    expect(dropped.status).toBe(200)
    expect(await tableExists(soloSchema, 'dropped_by_operator')).toBe(false)

    const fileId = await newFile(soloProjectId)
    const deleted: any = await deleteFile(operator, soloProjectId, fileId)
    expect(deleted.status).toBe(200)
    expect(await fileDeletedAt(fileId)).not.toBeNull()

    const saved: any = await saveWorkspaceFile(operator, soloProjectId, 'src/operator.ts')
    expect(saved.status).toBe(200)
    expect(await workspaceFile(soloProjectId, 'src/operator.ts')).not.toBeNull()
  }, 120_000)
})
