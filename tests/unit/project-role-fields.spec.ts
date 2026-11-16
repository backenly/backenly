/**
 * What GET /api/projects/[id] tells the console a person may do (project
 * console decision 9, 2026-11-16): `role`, `canWrite`, `canAdminister` and the
 * team that owns the project (`organizationId`). The console hides every
 * control these rule out, so they must say exactly what the server's own
 * checks (lib/edition/guard.ts) allow: never more, which would offer controls
 * that answer 403, and never less, which would hide work a person may do.
 *
 * Database-free: the resolver is stubbed with each role, and the route's
 * project read with one row.
 */

import { projectRoleFields, type ProjectRole } from '@/lib/edition/types'

type Resolution = { callerRole: ProjectRole; organizationId: string | null } | 'refused' | 'broken'
let resolution: Resolution = { callerRole: 'OWNER', organizationId: 'org_1' }

jest.mock('@/lib/edition', () => {
  const types = jest.requireActual('@/lib/edition/types')
  return {
    ...types,
    getProjectResolver: () => ({
      resolveForUser: async (_userId: string, projectId: string) => {
        if (resolution === 'refused') throw new types.ProjectAccessDeniedError()
        if (resolution === 'broken') throw new Error('the database is down')
        return { id: projectId, name: 'shop', userId: 'u_owner', workspaces: [], ...resolution }
      },
    }),
  }
})

jest.mock('@/lib/auth/route-protection', () => ({
  withAuth: (handler: any) => async (request: any, ctx: any = {}) =>
    handler(request, { user: { userId: 'u_member' }, params: ctx.params }),
}))

const ROW = {
  id: 'p1',
  name: 'shop',
  description: null,
  userId: 'u_owner',
  projectStatus: 'LIVE',
  deployedAt: null,
  environment: 'production',
  apiUrlDev: null,
  apiUrlStaging: null,
  apiUrlProd: null,
  apiRequests: 0,
  avgLatency: 0,
  errorCount: 0,
  storageUsed: BigInt(0),
  maxFileSize: BigInt(52428800),
  maxFilesPerBucket: 1000,
  activeUsers: 0,
  lastMetricsUpdate: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  pausedAt: null,
  region: null,
  _count: { tables: 2, workspaces: 1 },
}

jest.mock('@/lib/db', () => ({ prisma: { project: { findUnique: jest.fn(async () => ROW) } } }))
jest.mock('@/lib/services/storageQuota', () => ({ getProjectQuota: jest.fn(async () => ({ limit: BigInt(1073741824) })) }))
jest.mock('@/lib/projects/delete', () => ({ deleteProjectCompletely: jest.fn() }))

import { canAccessProject, canAdministerProject, canWriteProject } from '@/lib/edition/guard'

const ROLES: ProjectRole[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER']

function get(id = 'p1'): any {
  return {
    method: 'GET',
    url: `http://localhost:3000/api/projects/${id}`,
    nextUrl: { pathname: `/api/projects/${id}` },
    headers: new Headers(),
    cookies: { get: () => undefined },
    json: async () => ({}),
  }
}

async function read() {
  const { GET } = await import('@/app/api/projects/[id]/route')
  const res: any = await GET(get(), {} as any)
  return { status: res.status as number, body: await res.json() }
}

beforeEach(() => {
  resolution = { callerRole: 'OWNER', organizationId: 'org_1' }
})

describe('the role mapping', () => {
  it.each([
    ['OWNER', true, true],
    ['ADMIN', true, true],
    ['DEVELOPER', true, false],
    ['VIEWER', false, false],
  ] as const)('%s may write: %s, may administer: %s', (role, canWrite, canAdminister) => {
    expect(projectRoleFields({ callerRole: role, organizationId: 'org_1' })).toEqual({
      role,
      canWrite,
      canAdminister,
      organizationId: 'org_1',
    })
  })

  it('names no team for a project without one', () => {
    expect(projectRoleFields({ callerRole: 'OWNER', organizationId: null }).organizationId).toBeNull()
  })

  it.each(ROLES)('says for %s exactly what the server’s own checks allow', async (role) => {
    resolution = { callerRole: role, organizationId: 'org_1' }
    const fields = projectRoleFields(resolution)
    expect(await canAccessProject('u_member', 'p1')).toBe(true)
    expect(await canWriteProject('u_member', 'p1')).toBe(fields.canWrite)
    expect(await canAdministerProject('u_member', 'p1')).toBe(fields.canAdminister)
  })
})

describe('GET /api/projects/[id]', () => {
  it.each(ROLES)('answers the project with what the role %s may do, and its team', async (role) => {
    resolution = { callerRole: role, organizationId: 'org_team' }
    const { status, body } = await read()
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      id: 'p1',
      name: 'shop',
      ...projectRoleFields({ callerRole: role, organizationId: 'org_team' }),
    })
    // Still the project's own shape around it.
    expect(typeof body.data.storageLimit).toBe('number')
    expect(body.data.metrics.totalTables).toBe(2)
  })

  it('names no team for a project without one, rather than a guessed one', async () => {
    resolution = { callerRole: 'OWNER', organizationId: null }
    const { body } = await read()
    expect(body.data.organizationId).toBeNull()
  })

  it('answers a refusal as not found, with no project and no role', async () => {
    resolution = 'refused'
    const { status, body } = await read()
    expect(status).toBe(404)
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })

  it('reports an outage as a failure, never as "denied"', async () => {
    resolution = 'broken'
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { status } = await read()
      expect(status).toBe(500)
    } finally {
      quiet.mockRestore()
    }
  })
})
