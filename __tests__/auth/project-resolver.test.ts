/**
 * ONE AUTHORITY FOR "MAY THIS CALLER REACH THIS PROJECT"
 * =====================================================
 * Written BEFORE the ~70 call sites are migrated, so the behaviour they will be
 * migrated TO is pinned first and the migration cannot quietly redefine it.
 *
 * The defect this locks down is live today. Two implementations disagree:
 *
 *   lib/auth/project-access.ts   owner, else organization membership, else the
 *                                project-scoped grant a `restricted` member
 *                                needs. Six files consult it.
 *
 *   lib/tenant/isolation.ts      `where: { id, userId }`. Owner only. Twenty-nine
 *                                files import it, and 43 of the 69 route
 *                                directories under app/api/projects/[id]/ inline
 *                                the same query themselves.
 *
 * So an invited organization member is granted a project by one and denied by
 * the other, across storage, logs, monitoring, security issues, end-user auth
 * and env vars.
 *
 * The nastier half is the fallback. `getCurrentProjectId` resolves a MISSING
 * projectId to the caller's OLDEST OWNED project, so those routes do not merely
 * deny an organization member: they answer 200 with a different project's data.
 * Storage renders the organization's project as empty rather than as an error.
 * `respects the organization project over the caller's own older one` below is
 * the test for precisely that, and it is the reason this file exists.
 *
 * Real database. Every defect here lives in a `where` clause, which is exactly
 * what a mocked client cannot model.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import {
  getProjectResolver,
  currentEdition,
  ProjectAccessDeniedError,
  ProjectContextRequiredError,
  ProjectNotFoundError,
} from '@/lib/edition'
import {
  MultipleProjectsInSingleTenantError,
  resetSingleTenantCache,
} from '@/lib/edition/single-tenant/project-resolver'
import {
  canAccessProject,
  canWriteProject,
  canAdministerProject,
} from '@/lib/edition/guard'

const DB_URL = process.env.TEST_DATABASE_URL

/** Cleanup is scoped to this file's own rows: suites share one database. */
function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdOrgIds: string[] = []
const createdProjectIds: string[] = []

async function makeUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `resolver-${randomUUID()}@test.invalid`, name: 'Resolver Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  return u.id
}

async function makeProject(userId: string | null, orgId?: string): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `resolver-${randomUUID().slice(0, 8)}`, userId, organizationId: orgId ?? null },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

async function makeOrg(ownerId: string): Promise<string> {
  const o = await prisma.organization.create({
    data: { name: `resolver-org-${randomUUID().slice(0, 8)}`, ownerId },
    select: { id: true },
  })
  createdOrgIds.push(o.id)
  return o.id
}

async function addMember(orgId: string, userId: string, role: string, restricted = false): Promise<void> {
  await prisma.organizationMember.create({ data: { orgId, userId, role, restricted } })
}

/** An organization project plus a member of the given role. */
async function orgFixture(role: string, restricted = false) {
  const ownerId = await makeUser()
  const memberId = await makeUser()
  const orgId = await makeOrg(ownerId)
  await addMember(orgId, ownerId, 'OWNER')
  await addMember(orgId, memberId, role, restricted)
  const projectId = await makeProject(ownerId, orgId)
  return { ownerId, memberId, orgId, projectId }
}

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_PINNED = process.env.BACKENLY_PROJECT_ID

beforeAll(() => {
  assertSafeTestDatabase()
})

afterEach(() => {
  process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_PINNED === undefined) delete process.env.BACKENLY_PROJECT_ID
  else process.env.BACKENLY_PROJECT_ID = ORIGINAL_PINNED
  resetSingleTenantCache()
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.projectMember.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdOrgIds.length) {
    await prisma.organizationMember.deleteMany({ where: { orgId: { in: createdOrgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

// ============================================================================
// EDITION SELECTION
// ============================================================================

describe('edition selection', () => {
  it('defaults to cloud so this seam changes no running behaviour yet', () => {
    delete process.env.BACKENLY_EDITION
    expect(currentEdition()).toBe('cloud')
    expect(getProjectResolver().edition).toBe('cloud')
  })

  it('refuses an unrecognised edition instead of guessing', () => {
    process.env.BACKENLY_EDITION = 'clould'
    // Picking an edition on a typo is an authorization outcome, not a
    // configuration nicety: single-tenant treats every account as an operator.
    expect(() => currentEdition()).toThrow(/must be "cloud" or "single-tenant"/)
  })
})

// ============================================================================
// CLOUD — HUMAN SESSIONS
// ============================================================================

describe('cloud: human sessions', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('allows the owner of a project', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)

    const resolved = await getProjectResolver().resolveForUser(userId, projectId)
    expect(resolved.id).toBe(projectId)
  })

  it.each(['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'])(
    'allows an unrestricted org %s who does not own the project',
    async role => {
      const { memberId, projectId } = await orgFixture(role)

      const resolved = await getProjectResolver().resolveForUser(memberId, projectId)
      expect(resolved.id).toBe(projectId)
    }
  )

  it('denies a user with no relationship to the project', async () => {
    const ownerId = await makeUser()
    const strangerId = await makeUser()
    const projectId = await makeProject(ownerId)

    await expect(getProjectResolver().resolveForUser(strangerId, projectId)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError
    )
  })

  it('denies a restricted member with no grant for this project', async () => {
    const { memberId, projectId } = await orgFixture('DEVELOPER', true)

    // An empty allowlist means NOTHING, never everything. A restricted member
    // with zero ProjectMember rows must not fall back to org-wide access.
    await expect(getProjectResolver().resolveForUser(memberId, projectId)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError
    )
  })

  it('allows a restricted member once the project is granted to them', async () => {
    const { memberId, orgId, projectId } = await orgFixture('DEVELOPER', true)
    await prisma.projectMember.create({ data: { orgId, userId: memberId, projectId } })

    const resolved = await getProjectResolver().resolveForUser(memberId, projectId)
    expect(resolved.id).toBe(projectId)
  })

  it.each(['OWNER', 'ADMIN'])(
    'never scopes a restricted %s, who stays org-wide by definition',
    async role => {
      const { memberId, projectId } = await orgFixture(role, true)

      const resolved = await getProjectResolver().resolveForUser(memberId, projectId)
      expect(resolved.id).toBe(projectId)
    }
  )

  it('reports a missing project as not found, distinctly from forbidden', async () => {
    const userId = await makeUser()

    await expect(getProjectResolver().resolveForUser(userId, randomUUID())).rejects.toBeInstanceOf(
      ProjectNotFoundError
    )
  })

  // ── The fallback regression ────────────────────────────────────────────────

  it('refuses a request that names no project, rather than choosing one', async () => {
    const userId = await makeUser()
    await makeProject(userId)

    const err = await getProjectResolver()
      .resolveForUser(userId, null)
      .then(() => null, e => e)

    expect(err).toBeInstanceOf(ProjectContextRequiredError)
    expect(err.status).toBe(400)
    expect(err.code).toBe('PROJECT_REQUIRED')
  })

  it('respects the organization project over the caller\'s own older one', async () => {
    // THE regression. Under getCurrentProjectId an org member calling a route
    // that reads storage, logs or env vars got their OWN oldest project back
    // with a 200, so the organization's project rendered as empty rather than
    // erroring. Ordering matters here: the member's own project is created
    // FIRST so it is the one the old `orderBy: { createdAt: 'asc' }` would win.
    const { memberId, projectId: orgProjectId } = await orgFixture('DEVELOPER')
    const ownProjectId = await makeProject(memberId)

    const resolved = await getProjectResolver().resolveForUser(memberId, orgProjectId)

    expect(resolved.id).toBe(orgProjectId)
    expect(resolved.id).not.toBe(ownProjectId)
  })
})

// ============================================================================
// CLOUD — API KEYS
// ============================================================================

describe('cloud: api keys are authorized by the project the key belongs to', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('resolves the project the key was issued for', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)

    const resolved = await getProjectResolver().resolveForApiKey({ projectId, userId })
    expect(resolved.id).toBe(projectId)
  })

  it('keeps working when the key owner holds no org membership at all', async () => {
    // A machine credential must not be revoked because the human who created it
    // changed teams — nor widened because they were promoted. This asserts the
    // key path does NOT consult organization membership.
    const orgOwnerId = await makeUser()
    const keyOwnerId = await makeUser()
    const orgId = await makeOrg(orgOwnerId)
    await addMember(orgId, orgOwnerId, 'OWNER')
    const projectId = await makeProject(orgOwnerId, orgId)

    // keyOwnerId is in no organization and owns nothing, so the HUMAN check denies.
    await expect(getProjectResolver().resolveForUser(keyOwnerId, projectId)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError
    )

    // The key still resolves, because the key is scoped to the project.
    const resolved = await getProjectResolver().resolveForApiKey({ projectId, userId: keyOwnerId })
    expect(resolved.id).toBe(projectId)
  })

  it('refuses an unscoped key rather than letting it name a project', async () => {
    const userId = await makeUser()

    await expect(
      getProjectResolver().resolveForApiKey({ projectId: null, userId })
    ).rejects.toBeInstanceOf(ProjectContextRequiredError)
  })
})

// ============================================================================
// TRUSTED INTERNAL OPERATIONS
// ============================================================================

describe('trusted internal operations', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('resolves without a principal when given a written reason', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)

    const resolved = await getProjectResolver().resolveTrusted(projectId, 'autonomy reconciler tick')
    expect(resolved.id).toBe(projectId)
  })

  it('refuses an unexplained bypass', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)

    // So that "this skipped authorization" is always greppable and deliberate.
    await expect(getProjectResolver().resolveTrusted(projectId, '  ')).rejects.toThrow(/written reason/)
  })
})

// ============================================================================
// ROLE: ACCESS IS NOT AUTHORITY
// ============================================================================

describe('cloud: role gates what a member may DO', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'cloud'
  })

  it('reports the project owner as OWNER regardless of organization', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)

    const resolved = await getProjectResolver().resolveForUser(userId, projectId)
    expect(resolved.callerRole).toBe('OWNER')
  })

  it.each(['ADMIN', 'DEVELOPER', 'VIEWER'])('reports an org %s as that role', async role => {
    const { memberId, projectId } = await orgFixture(role)

    const resolved = await getProjectResolver().resolveForUser(memberId, projectId)
    expect(resolved.callerRole).toBe(role)
  })

  it('lets a VIEWER read and stops them writing or deleting', async () => {
    // The regression this section exists for. Every one of these routes was
    // owner-only before the migration, so membership had never had to mean
    // anything narrower than "may do everything" — and routing writes through
    // the access check would have handed a VIEWER the ability to edit project
    // settings and delete webhooks, domains and functions.
    const { memberId, projectId } = await orgFixture('VIEWER')

    expect(await canAccessProject(memberId, projectId)).toBe(true)
    expect(await canWriteProject(memberId, projectId)).toBe(false)
    expect(await canAdministerProject(memberId, projectId)).toBe(false)
  })

  it('lets a DEVELOPER write but not perform an irreversible operation', async () => {
    const { memberId, projectId } = await orgFixture('DEVELOPER')

    expect(await canAccessProject(memberId, projectId)).toBe(true)
    expect(await canWriteProject(memberId, projectId)).toBe(true)
    // Deleting a project, a domain or a webhook is not undoable from the
    // dashboard. A DEVELOPER builds; removing what they built is administrative.
    expect(await canAdministerProject(memberId, projectId)).toBe(false)
  })

  it.each(['ADMIN', 'OWNER'])('lets an org %s do all three', async role => {
    const { memberId, projectId } = await orgFixture(role)

    expect(await canAccessProject(memberId, projectId)).toBe(true)
    expect(await canWriteProject(memberId, projectId)).toBe(true)
    expect(await canAdministerProject(memberId, projectId)).toBe(true)
  })

  it('denies every level to someone outside the organization', async () => {
    const ownerId = await makeUser()
    const strangerId = await makeUser()
    const projectId = await makeProject(ownerId)

    expect(await canAccessProject(strangerId, projectId)).toBe(false)
    expect(await canWriteProject(strangerId, projectId)).toBe(false)
    expect(await canAdministerProject(strangerId, projectId)).toBe(false)
  })

  it('gives the project owner every level even as a VIEWER of the org', async () => {
    // Project.userId outranks the org role: the owner of a project cannot be
    // demoted out of their own project by an organization membership row.
    const ownerId = await makeUser()
    const orgId = await makeOrg(ownerId)
    await addMember(orgId, ownerId, 'VIEWER')
    const projectId = await makeProject(ownerId, orgId)

    const resolved = await getProjectResolver().resolveForUser(ownerId, projectId)
    expect(resolved.callerRole).toBe('OWNER')
    expect(await canAdministerProject(ownerId, projectId)).toBe(true)
  })
})

describe('single-tenant: every operator is an owner', () => {
  it('reports OWNER, so no self-hosted route is gated by a role that cannot exist', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    resetSingleTenantCache()
    const userId = await makeUser()
    const projectId = await makeProject(userId)
    process.env.BACKENLY_PROJECT_ID = projectId

    const resolved = await getProjectResolver().resolveForUser(userId, projectId)
    expect(resolved.callerRole).toBe('OWNER')
    expect(await canAdministerProject(userId, projectId)).toBe(true)
  })
})

// ============================================================================
// SINGLE-TENANT
// ============================================================================

describe('single-tenant: one deployment is one project', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    resetSingleTenantCache()
  })

  it('resolves THE project when a request names none', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)
    process.env.BACKENLY_PROJECT_ID = projectId

    // The opposite of the cloud case above, and correct for the same reason it
    // is wrong there: with one project there is nothing to disambiguate.
    const resolved = await getProjectResolver().resolveForUser(userId, null)
    expect(resolved.id).toBe(projectId)
  })

  it('treats any authenticated account as an operator of the deployment', async () => {
    const ownerId = await makeUser()
    const otherId = await makeUser()
    const projectId = await makeProject(ownerId)
    process.env.BACKENLY_PROJECT_ID = projectId

    // No organizations, invites or grants exist in this edition: that layer is
    // the Cloud control plane. Everyone with an account here is an operator.
    const resolved = await getProjectResolver().resolveForUser(otherId, projectId)
    expect(resolved.id).toBe(projectId)
  })

  it('reports any other project id as not found', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)
    const otherProjectId = await makeProject(userId)
    process.env.BACKENLY_PROJECT_ID = projectId

    await expect(
      getProjectResolver().resolveForUser(userId, otherProjectId)
    ).rejects.toBeInstanceOf(ProjectNotFoundError)
  })

  it('denies an API key issued for a different deployment', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)
    const foreignProjectId = await makeProject(userId)
    process.env.BACKENLY_PROJECT_ID = projectId

    await expect(
      getProjectResolver().resolveForApiKey({ projectId: foreignProjectId, userId })
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError)
  })

  it('refuses to answer at all when the database holds many projects', async () => {
    // The backstop for the worst possible misconfiguration: single-tenant
    // pointed at the multi-tenant production database. This resolver grants any
    // authenticated user whatever project it picks, so picking one here would be
    // a cross-tenant authorization bypass. It must refuse instead.
    //
    // Unpinned on purpose: this exercises the inference path, and the shared
    // test database genuinely holds many projects.
    delete process.env.BACKENLY_PROJECT_ID
    const userId = await makeUser()
    await makeProject(userId)
    await makeProject(userId)

    await expect(getProjectResolver().resolveForUser(userId, null)).rejects.toBeInstanceOf(
      MultipleProjectsInSingleTenantError
    )
  })
})
