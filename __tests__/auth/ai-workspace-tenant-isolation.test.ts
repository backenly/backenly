/**
 * THE AI WORKSPACE ROUTES TOOK A PROJECT ID FROM THE REQUEST BODY
 * ==============================================================
 * `/api/ai-workspace/apply-changes`, `generate-plan` and `preview-diff` all
 * authenticated the caller and then read `projectId` straight out of the body.
 * Authentication answers who is asking; it says nothing about what they may
 * touch. So any signed-in account could name another tenant's project and, in
 * the case of apply-changes, **apply schema changes to it**.
 *
 * Found by the route-authorization sweep, not by product use — nothing in the
 * dashboard sends another tenant's id, so the hole was never exercised.
 *
 * These are two-sided on purpose. This program has twice produced refusal-only
 * suites that were green because NOTHING worked, so every denial below is
 * paired with the corresponding permission: if the guard started refusing the
 * owner too, that is a different bug and it must not look like success.
 *
 * The guards themselves are what is tested, rather than the routes over HTTP.
 * `canWriteProject` / `canAccessProject` are where the decision is made, and a
 * route-level test would pass against a guard that was still willing.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { canAccessProject, canWriteProject, canAdministerProject } from '@/lib/edition/guard'

/**
 * Runs as CLOUD, deliberately.
 *
 * In single-tenant edition these guards do not answer a per-user question at
 * all: the resolver treats any authenticated account as the operator of the
 * deployment, and refuses outright if it finds more than one project, because
 * choosing between tenants there would hand one tenant's data to another.
 *
 * So cross-tenant authorization is a CLOUD property, and that is where these
 * defects bite. A self-hosted install has one project and one operator, which
 * is why the holes the sweep found were never reachable there — and why
 * testing them under the default edition would assert nothing.
 */
const originalEdition = process.env.BACKENLY_EDITION

let ownerId: string
let strangerId: string
let ownedProjectId: string
let foreignProjectId: string

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'

  const owner = await prisma.user.create({
    data: { email: `aiws-owner-${Date.now()}@example.test`, password: 'x', name: 'owner' },
  })
  ownerId = owner.id
  const stranger = await prisma.user.create({
    data: { email: `aiws-stranger-${Date.now()}@example.test`, password: 'x', name: 'stranger' },
  })
  strangerId = stranger.id

  const owned = await prisma.project.create({ data: { name: 'aiws-owned', userId: ownerId } })
  ownedProjectId = owned.id
  const foreign = await prisma.project.create({ data: { name: 'aiws-foreign', userId: strangerId } })
  foreignProjectId = foreign.id
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition

  await prisma.project.deleteMany({ where: { id: { in: [ownedProjectId, foreignProjectId] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
}, 60_000)

describe('the owner of a project', () => {
  test('may read it', async () => {
    expect(await canAccessProject(ownerId, ownedProjectId)).toBe(true)
  })

  test('may write to it', async () => {
    // The permission apply-changes now requires. If this ever returns false the
    // route is broken for its legitimate user, and every denial below would
    // still pass — which is exactly how a refusal-only suite lies.
    expect(await canWriteProject(ownerId, ownedProjectId)).toBe(true)
  })

  test('may administer it', async () => {
    expect(await canAdministerProject(ownerId, ownedProjectId)).toBe(true)
  })
})

describe('a different authenticated tenant', () => {
  test('may not read the project', async () => {
    expect(await canAccessProject(strangerId, ownedProjectId)).toBe(false)
  })

  test('may not write to it, which is what apply-changes required', async () => {
    expect(await canWriteProject(strangerId, ownedProjectId)).toBe(false)
  })

  test('may not administer it', async () => {
    expect(await canAdministerProject(strangerId, ownedProjectId)).toBe(false)
  })

  test('the stranger is a real account that owns a real project', async () => {
    // Guards the guard: if the stranger had no project, or the ids were bad,
    // every refusal above would pass while proving nothing.
    expect(await canWriteProject(strangerId, foreignProjectId)).toBe(true)
  })
})

describe('an unauthenticated caller', () => {
  test('is denied by an empty user id', async () => {
    expect(await canAccessProject('', ownedProjectId)).toBe(false)
    expect(await canWriteProject('', ownedProjectId)).toBe(false)
  })

  test('is denied by a well-formed user id that does not exist', async () => {
    const ghost = '00000000-0000-0000-0000-000000000000'
    expect(await canAccessProject(ghost, ownedProjectId)).toBe(false)
    expect(await canWriteProject(ghost, ownedProjectId)).toBe(false)
  })
})

describe('wrong pairing of a real user and a real project', () => {
  test('both ids valid, but not each other', async () => {
    // The shape the sweep looks for: two legitimate identifiers combined into
    // an illegitimate request. Neither id is malformed, so nothing short of an
    // ownership check refuses it.
    expect(await canAccessProject(ownerId, foreignProjectId)).toBe(false)
    expect(await canWriteProject(ownerId, foreignProjectId)).toBe(false)
  })

  test('a project id that does not exist is refused, not treated as absent', async () => {
    expect(await canAccessProject(ownerId, '00000000-0000-0000-0000-000000000000')).toBe(false)
  })
})

describe('the victim tenant is unchanged by a denied request', () => {
  test('the foreign project still belongs to its owner', async () => {
    // apply-changes mutates. A denial that still altered the target would be
    // worse than no denial at all, because it would look safe.
    const before = await prisma.project.findUnique({
      where: { id: foreignProjectId },
      select: { userId: true, name: true },
    })
    expect(before?.userId).toBe(strangerId)

    // The check the route performs, refused.
    expect(await canWriteProject(ownerId, foreignProjectId)).toBe(false)

    const after = await prisma.project.findUnique({
      where: { id: foreignProjectId },
      select: { userId: true, name: true },
    })
    expect(after).toEqual(before)
  })
})
