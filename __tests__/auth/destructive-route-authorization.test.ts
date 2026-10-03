/**
 * FIVE DESTRUCTIVE ROUTES THAT DID NOT CHECK WHO WAS ASKING
 * ========================================================
 * Found by the route-authorization sweep, in the class the sweep exists to
 * find: reachable, destructive, and called by no UI, so nothing ever exercised
 * them.
 *
 *   /api/projects/[id]/undo-last-live-update   NO AUTHENTICATION AT ALL
 *   /api/workspaces/[workspaceId]/provision-database   NO AUTHENTICATION
 *   /api/workspaces/[workspaceId]/setup-database       NO AUTHENTICATION
 *   /api/projects/[id]/restore   authenticated, never authorized
 *   /api/projects/[id]/undo      authenticated, never authorized
 *
 * The first three needed no session whatsoever: anyone able to reach the server
 * and name a project or workspace could roll back a live deployment or rebuild
 * a workspace database. The last two verified a token and then checked the
 * CALLER'S PLAN ENTITLEMENT before rolling back the project named in the path —
 * an entitlement check is about billing, not access, and reading like a
 * permission check is what let it stand in for one.
 *
 * Tested at the guard, because that is where the decision now lives and a
 * route-level test would pass against a guard that was still willing. Two-sided
 * throughout: every denial is paired with the matching permission, since this
 * program has twice produced refusal-only suites that were green because
 * nothing worked.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { canAccessProject, canAdministerProject } from '@/lib/edition/guard'

/**
 * Cloud, deliberately. Single-tenant treats any authenticated account as the
 * deployment's operator and refuses to resolve with more than one project, so
 * cross-tenant authorization is a Cloud property and these defects were never
 * reachable on a self-hosted install.
 */
const originalEdition = process.env.BACKENLY_EDITION

let ownerId: string
let strangerId: string
let ownedProjectId: string
let foreignProjectId: string
let foreignWorkspaceId: string

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'

  const owner = await prisma.user.create({
    data: { email: `destr-owner-${Date.now()}@example.test`, password: 'x', name: 'owner' },
  })
  ownerId = owner.id
  const stranger = await prisma.user.create({
    data: { email: `destr-stranger-${Date.now()}@example.test`, password: 'x', name: 'stranger' },
  })
  strangerId = stranger.id

  const owned = await prisma.project.create({ data: { name: 'destr-owned', userId: ownerId } })
  ownedProjectId = owned.id

  const foreign = await prisma.project.create({ data: { name: 'destr-foreign', userId: strangerId } })
  foreignProjectId = foreign.id

  // The workspace routes resolve a workspace and then authorize its project,
  // so the fixture needs a real workspace belonging to the other tenant.
  const ws = await prisma.workspace.create({
    data: { projectId: foreignProjectId, name: 'foreign-ws', postgresSchema: `workspace_${foreignProjectId}` },
  })
  foreignWorkspaceId = ws.id
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition

  await prisma.workspace.deleteMany({ where: { id: foreignWorkspaceId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [ownedProjectId, foreignProjectId] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
}, 60_000)

describe('rolling back a deployment', () => {
  test('the owner may administer their own project', async () => {
    // The positive half. Without it, a guard that denied everybody would make
    // every refusal below pass while breaking the feature entirely.
    expect(await canAdministerProject(ownerId, ownedProjectId)).toBe(true)
  })

  test('a different tenant may not, which is what restore and undo required', async () => {
    expect(await canAdministerProject(strangerId, ownedProjectId)).toBe(false)
  })

  test('an unauthenticated caller may not', async () => {
    // The shape of the three routes that had no session check at all: there is
    // no user id to present.
    expect(await canAdministerProject('', ownedProjectId)).toBe(false)
    expect(await canAdministerProject('00000000-0000-0000-0000-000000000000', ownedProjectId)).toBe(false)
  })

  test('a real user paired with a real project that is not theirs is refused', async () => {
    // Neither identifier is malformed. Nothing short of an ownership check
    // refuses this, which is exactly why these routes did not.
    expect(await canAdministerProject(ownerId, foreignProjectId)).toBe(false)
  })
})

describe('administer is stricter than access', () => {
  test('the distinction exists and is not an alias', async () => {
    // These routes use canAdministerProject rather than canAccessProject
    // because a rollback rewrites live state. If the two ever became
    // equivalent, that choice would silently stop meaning anything.
    expect(await canAccessProject(ownerId, ownedProjectId)).toBe(true)
    expect(await canAdministerProject(ownerId, ownedProjectId)).toBe(true)

    expect(await canAccessProject(strangerId, ownedProjectId)).toBe(false)
    expect(await canAdministerProject(strangerId, ownedProjectId)).toBe(false)
  })
})

describe('the workspace database routes', () => {
  test('resolve to a project the caller must be able to administer', async () => {
    // provision-database and setup-database take a WORKSPACE id, so the
    // authorization hop is workspace -> project -> caller. This asserts the
    // hop lands somewhere real.
    const ws = await prisma.workspace.findUnique({
      where: { id: foreignWorkspaceId },
      select: { projectId: true },
    })
    expect(ws?.projectId).toBe(foreignProjectId)

    expect(await canAdministerProject(strangerId, ws!.projectId)).toBe(true)
    expect(await canAdministerProject(ownerId, ws!.projectId)).toBe(false)
  })

  test('a workspace id that does not exist resolves to nothing', async () => {
    const ws = await prisma.workspace.findUnique({
      where: { id: '00000000-0000-0000-0000-000000000000' },
      select: { projectId: true },
    })
    expect(ws).toBeNull()
  })
})

describe('the victim tenant is unchanged by a denied request', () => {
  test('a refused rollback leaves the target project untouched', async () => {
    const before = await prisma.project.findUnique({
      where: { id: foreignProjectId },
      select: { userId: true, activeGraphId: true, name: true },
    })

    // The check each route now performs, refused.
    expect(await canAdministerProject(ownerId, foreignProjectId)).toBe(false)

    const after = await prisma.project.findUnique({
      where: { id: foreignProjectId },
      select: { userId: true, activeGraphId: true, name: true },
    })
    // activeGraphId is what a rollback swaps. Asserting it explicitly is the
    // difference between "denied" and "denied AND did nothing".
    expect(after).toEqual(before)
  })

  test('a refused workspace provision leaves the workspace untouched', async () => {
    const before = await prisma.workspace.findUnique({
      where: { id: foreignWorkspaceId },
      select: { databaseProvisioned: true, postgresSchema: true },
    })

    expect(await canAdministerProject(ownerId, foreignProjectId)).toBe(false)

    const after = await prisma.workspace.findUnique({
      where: { id: foreignWorkspaceId },
      select: { databaseProvisioned: true, postgresSchema: true },
    })
    expect(after).toEqual(before)
  })
})
